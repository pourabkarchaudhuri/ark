/**
 * ML Model Manager (Main Process)
 *
 * Loads the Kaggle-trained LightGBM model (ONNX) and game profiles.
 * Provides batch scoring for recommendation candidates: given a user
 * profile and a list of game IDs, returns P(recommended) for each.
 *
 * The 8-fold ensemble is loaded for higher accuracy (averaging predictions
 * from all fold models, matching AutoGluon's bagged approach).
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { app } = require('electron');
import * as fs from 'fs';
import * as path from 'path';
import { logger } from './safe-logger.js';

import {
  N_FEATURES,
  N_NUMERIC,
  buildFeatureVector,
  buildUserProfileFromGames,
  type GameProfile,
  type ProfileGame,
  type UserProfile,
} from './ml-features.js';
import { buildSyntheticProfile, buildTagIndex, type SynthMeta } from './ml-synth.js';

export type { UserProfile } from './ml-features.js';

/** Bump when the bundled model/profile artifacts change so installed copies in userData are replaced. */
export const ML_ARTIFACT_VERSION = 2;
const ARTIFACT_STAMP_FILE = '.artifact-version';
const EXPECTED_FOLDS = 8;

interface FeatureSpec {
  feature_names: string[];
  n_features: number;
  top_k_tags: number;
  smooth_m: number;
  global_rec_rate: number;
  onnx_input_name: string;
  onnx_output_names: string[];
  defaults: Record<string, number>;
}

export interface MLScoreResult {
  gameId: string;
  score: number; // P(recommended) from the model
  /** Scored from a synthesised profile (catalog metadata, no Kaggle review aggregates). */
  synthetic?: boolean;
}

let ort: typeof import('onnxruntime-node') | null = null;
let sessions: any[] = [];
let featureSpec: FeatureSpec | null = null;
let gameProfiles: Map<string, GameProfile> = new Map();
let tagMapping: string[] = [];
let loaded = false;
let loadingPromise: Promise<boolean> | null = null;
/**
 * Session failure latch. A failed load (missing onnxruntime, missing data
 * files, broken ONNX) is deterministic, but every Oracle compute used to retry
 * it — re-reading and JSON-parsing the 11.8 MB game_profiles.json
 * synchronously on the main thread each time. Fail once, stay failed until restart.
 */
let loadFailedThisSession = false;

function getDataDir(): string {
  return path.join(app.getPath('userData'), 'ml-data');
}

function getSourceDir(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'ml-data');
  }
  const appPath = app.getAppPath();
  return path.join(appPath, 'dataset', 'ml');
}

/**
 * Copy ML artifacts from source (dev) or bundled resources to userData.
 * In dev mode, reads directly from dataset/ml/. In production, they'd
 * be bundled via electron-builder extraResources.
 */
function ensureDataFiles(): boolean {
  try {
    const dataDir = getDataDir();
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }

    const sourceDir = getSourceDir();
    const requiredFiles = ['game_profiles.json', 'feature_spec.json', 'tag_mapping.json'];

    // Installed copies from an older app version must be replaced, not kept forever.
    const stampPath = path.join(dataDir, ARTIFACT_STAMP_FILE);
    let installedVersion = 0;
    try { installedVersion = Number(fs.readFileSync(stampPath, 'utf-8').trim()) || 0; } catch { /* no stamp */ }
    const refresh = installedVersion !== ML_ARTIFACT_VERSION;
    if (refresh) {
      for (const file of requiredFiles) fs.rmSync(path.join(dataDir, file), { force: true });
      fs.rmSync(path.join(dataDir, 'onnx_ensemble'), { recursive: true, force: true });
      logger.info(`[ML] Refreshing ML artifacts (installed v${installedVersion} -> v${ML_ARTIFACT_VERSION})`);
    }

    for (const file of requiredFiles) {
      const dest = path.join(dataDir, file);
      if (!fs.existsSync(dest)) {
        const src = path.join(sourceDir, file);
        if (!fs.existsSync(src)) {
          logger.error(`[ML] Missing source file: ${src}`);
          return false;
        }
        fs.copyFileSync(src, dest);
        logger.info(`[ML] Copied ${file} to userData`);
      }
    }

    // Copy ensemble folder (preferred) or single model
    const ensembleDir = path.join(dataDir, 'onnx_ensemble');
    if (!fs.existsSync(ensembleDir)) {
      const srcEnsemble = path.join(sourceDir, 'onnx_ensemble');
      if (fs.existsSync(srcEnsemble)) {
        fs.mkdirSync(ensembleDir, { recursive: true });
        for (const f of fs.readdirSync(srcEnsemble)) {
          fs.copyFileSync(path.join(srcEnsemble, f), path.join(ensembleDir, f));
        }
        logger.info(`[ML] Copied onnx_ensemble/ to userData`);
      }
    }

    // A partial ensemble is worse than none: reject and re-copy on next load.
    if (fs.existsSync(ensembleDir)) {
      const folds = fs.readdirSync(ensembleDir).filter(f => /^fold_\d+\.onnx$/.test(f)).length;
      if (folds !== EXPECTED_FOLDS) {
        logger.error(`[ML] Ensemble has ${folds}/${EXPECTED_FOLDS} folds — rejecting`);
        fs.rmSync(ensembleDir, { recursive: true, force: true });
        return false;
      }
    }
    fs.writeFileSync(stampPath, String(ML_ARTIFACT_VERSION));

    // Single model fallback
    const singleModel = path.join(dataDir, 'model.onnx');
    if (!fs.existsSync(singleModel) && !fs.existsSync(ensembleDir)) {
      const src = path.join(sourceDir, 'model.onnx');
      if (fs.existsSync(src)) {
        fs.copyFileSync(src, singleModel);
        logger.info('[ML] Copied model.onnx to userData');
      }
    }

    return true;
  } catch (err) {
    logger.error('[ML] Failed to copy data files:', err);
    return false;
  }
}

export function loadModel(): Promise<boolean> {
  if (loaded) return Promise.resolve(true);
  if (loadFailedThisSession) return Promise.resolve(false);
  if (loadingPromise) return loadingPromise;
  loadingPromise = _doLoadModel().then((ok) => {
    if (!ok) loadFailedThisSession = true;
    return ok;
  });
  return loadingPromise;
}

async function _doLoadModel(): Promise<boolean> {
  try {
    ort = require('onnxruntime-node');
  } catch (err) {
    logger.error('[ML] Failed to load onnxruntime-node:', err);
    loadingPromise = null;
    return false;
  }

  if (!ensureDataFiles()) { loadingPromise = null; return false; }

  const dataDir = getDataDir();

  // Reset mutable state so retries after partial failure don't accumulate
  sessions = [];
  featureSpec = null;
  tagMapping = [];
  gameProfiles = new Map();
  loaded = false;

  try {
    const specRaw = fs.readFileSync(path.join(dataDir, 'feature_spec.json'), 'utf-8');
    featureSpec = JSON.parse(specRaw);

    const tagRaw = fs.readFileSync(path.join(dataDir, 'tag_mapping.json'), 'utf-8');
    tagMapping = JSON.parse(tagRaw);

    const profilesRaw = fs.readFileSync(path.join(dataDir, 'game_profiles.json'), 'utf-8');
    const profilesObj: Record<string, GameProfile> = JSON.parse(profilesRaw);
    gameProfiles = new Map(Object.entries(profilesObj));
    logger.info(`[ML] Loaded ${gameProfiles.size} game profiles`);

    const expectedFeatures = N_NUMERIC + tagMapping.length;
    if (featureSpec && featureSpec.n_features !== expectedFeatures) {
      logger.warn(`[ML] Feature count mismatch: spec says ${featureSpec.n_features}, computed ${expectedFeatures} (${N_NUMERIC} numeric + ${tagMapping.length} tags)`);
    }

    // LightGBM's ONNX converter declares label output shape as [1] even
    // though the input has dynamic batch [None, n_features]. onnxruntime
    // logs a noisy warning on every batch inference. Level 3 = errors only.
    const sessOpts = { executionProviders: ['cpu'], logSeverityLevel: 3 as const };

    // Load ensemble ONNX sessions
    const ensembleDir = path.join(dataDir, 'onnx_ensemble');
    if (fs.existsSync(ensembleDir)) {
      const foldFiles = fs.readdirSync(ensembleDir).filter(f => /^fold_\d+\.onnx$/.test(f)).sort();
      for (const foldFile of foldFiles) {
        const sess = await ort!.InferenceSession.create(
          path.join(ensembleDir, foldFile),
          sessOpts,
        );
        sessions.push(sess);
      }
      logger.info(`[ML] Loaded ${sessions.length} ensemble fold models`);
    }

    // Fallback: single model
    if (sessions.length === 0) {
      const modelPath = path.join(dataDir, 'model.onnx');
      const sess = await ort!.InferenceSession.create(modelPath, sessOpts);
      sessions.push(sess);
      logger.info('[ML] Loaded single ONNX model');
    }

    // Probe: every fold must return a float `probabilities` tensor, otherwise scores
    // silently degrade to label votes. Fail loudly instead.
    const probName = featureSpec?.onnx_output_names?.[1] ?? 'probabilities';
    const probeIn = new ort!.Tensor('float32', new Float32Array(N_FEATURES), [1, N_FEATURES]);
    for (const sess of sessions) {
      const out = await sess.run({ [featureSpec!.onnx_input_name]: probeIn }, [probName]);
      if (out[probName]?.type !== 'float32') {
        throw new Error(`ML model output '${probName}' is not a float tensor (ZipMap not removed?)`);
      }
    }

    loaded = true;
    return true;
  } catch (err) {
    logger.error('[ML] Failed to load model:', err);
    loadingPromise = null;
    return false;
  }
}

/**
 * Score a batch of games for a given user profile.
 * Returns P(recommended) for each game, averaged across the ensemble folds that
 * succeeded. The shipped folds expose `probabilities` as a float tensor
 * (scripts/ml/patch-zipmap.py removes the ZipMap node), so scores are continuous.
 */
/**
 * True when the library has enough Steam-backed evidence to drive the ML user profile.
 * Avoids scoring from empty/default profiles (Epic-only or brand-new libraries).
 */
export function hasRealSteamProfile(
  games: Array<{ gameId: string; hoursPlayed: number; rating: number; status: string }>,
): boolean {
  const steam = games.filter(g => g.gameId.startsWith('steam-'));
  if (steam.length < 3) return false;
  return steam.some(
    g =>
      g.hoursPlayed > 0 ||
      g.rating > 0 ||
      g.status === 'Completed' ||
      g.status === 'Playing' ||
      g.status === 'Playing Now',
  );
}

export async function scoreGames(
  userProfile: UserProfile,
  gameIds: string[],
  synthMeta: Record<string, SynthMeta> = {},
): Promise<MLScoreResult[]> {
  if (!loaded || sessions.length === 0 || !featureSpec || !ort) {
    // Do not invent 0.5 placeholders — caller treats missing scores as unscored
    return [];
  }

  // Steam titles with a real Kaggle game profile; others only when the renderer sent enough catalog
  // metadata to synthesise one (see ml-synth.ts — scored, but flagged and weighted lower).
  const scorable: string[] = [];
  const profilesById = new Map<string, GameProfile>();
  const synthetic = new Set<string>();
  const tagIndex = synthMeta && Object.keys(synthMeta).length > 0 ? buildTagIndex(tagMapping) : null;
  for (const id of gameIds) {
    const real = id.startsWith('steam-') ? gameProfiles.get(id.slice(6)) : undefined;
    if (real) {
      scorable.push(id);
      profilesById.set(id, real);
      continue;
    }
    const meta = synthMeta[id];
    if (!meta || !tagIndex) continue;
    const synth = buildSyntheticProfile(meta, tagIndex);
    if (!synth) continue;
    scorable.push(id);
    profilesById.set(id, synth);
    synthetic.add(id);
  }

  const n = scorable.length;
  if (n === 0) return [];

  const defaults = featureSpec.defaults;

  // Build flat feature buffer for all games
  const flatBuffer = new Float32Array(n * N_FEATURES);
  for (let i = 0; i < n; i++) {
    const vec = buildFeatureVector(userProfile, profilesById.get(scorable[i]), defaults);
    flatBuffer.set(vec, i * N_FEATURES);
  }

  const inputTensor = new ort.Tensor('float32', flatBuffer, [n, N_FEATURES]);
  const inputName = featureSpec.onnx_input_name;
  const probName = featureSpec.onnx_output_names[1] ?? 'probabilities';

  const probSums = new Float32Array(n);
  let foldsOk = 0;

  for (const sess of sessions) {
    try {
      const result = await sess.run({ [inputName]: inputTensor }, [probName]);
      const probOutput = result[probName];
      if (!probOutput?.dims || !probOutput.data) throw new Error('no probabilities tensor');
      const cols = probOutput.dims[probOutput.dims.length - 1] as number;
      const data = probOutput.data as Float32Array;
      for (let i = 0; i < n; i++) probSums[i] += data[i * cols + (cols - 1)];
      foldsOk++;
    } catch (err) {
      // Never fall back to the int label: averaging 0/1 votes is what produced a 9-level score.
      logger.warn('[ML] Fold scoring failed, skipping:', err);
    }
  }

  if (foldsOk === 0) {
    logger.error('[ML] No fold produced probabilities — returning no scores');
    return [];
  }

  return scorable.map((id, i) => ({
    gameId: id,
    score: probSums[i] / foldsOk,
    ...(synthetic.has(id) ? { synthetic: true } : {}),
  }));
}

/**
 * Build an approximate user profile from library data (see ml-features.ts).
 */
export function buildUserProfile(games: ProfileGame[]): UserProfile {
  return buildUserProfileFromGames(games, {
    globalRecRate: featureSpec?.global_rec_rate ?? 0.85,
    smoothM: featureSpec?.smooth_m ?? 10,
    defaults: featureSpec?.defaults ?? {},
  });
}

export function getGameProfile(steamAppId: string): GameProfile | undefined {
  return gameProfiles.get(steamAppId);
}

/**
 * Get recommendation rates for a batch of games.
 * Returns a map of gameId → g_rec_rate for games that have Kaggle profiles.
 */
export function getGameRecRates(gameIds: string[]): Record<string, number> {
  const result: Record<string, number> = {};
  for (const id of gameIds) {
    const appId = id.replace('steam-', '');
    const gp = gameProfiles.get(appId);
    if (gp) {
      result[id] = gp.g_rec_rate;
    }
  }
  return result;
}

export function getStatus(): {
  loaded: boolean;
  modelCount: number;
  gameProfileCount: number;
  tagCount: number;
} {
  return {
    loaded,
    modelCount: sessions.length,
    gameProfileCount: gameProfiles.size,
    tagCount: tagMapping.length,
  };
}

export function isLoaded(): boolean {
  return loaded;
}
