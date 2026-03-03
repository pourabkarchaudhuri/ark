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

const N_FEATURES = 242;
const TOP_K_TAGS = 200;
const N_NUMERIC = 42; // first 42 features are numeric, rest are tags

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

interface GameProfile {
  g_rec_rate: number;
  g_avg_hours: number;
  g_std_hours: number;
  g_n_reviews: number;
  g_avg_helpful: number;
  g_pct_high_hours: number;
  price?: number;
  discount?: number;
  win?: boolean;
  mac?: boolean;
  linux?: boolean;
  steam_deck?: boolean;
  positive_ratio?: number;
  user_reviews?: number;
  tags?: number[];
}

export interface UserProfile {
  u_rec_rate: number;
  u_avg_hours: number;
  u_std_hours: number;
  u_n_reviews: number;
  u_avg_helpful: number;
  u_avg_funny: number;
  u_pct_high_hours: number;
  log_products: number;
  log_user_rev: number;
}

export interface MLScoreResult {
  gameId: string;
  score: number; // P(recommended) from the model
}

let ort: typeof import('onnxruntime-node') | null = null;
let sessions: any[] = [];
let featureSpec: FeatureSpec | null = null;
let gameProfiles: Map<string, GameProfile> = new Map();
let tagMapping: string[] = [];
let loaded = false;
let loadingPromise: Promise<boolean> | null = null;

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
  if (loadingPromise) return loadingPromise;
  loadingPromise = _doLoadModel();
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
      const foldFiles = fs.readdirSync(ensembleDir).filter(f => f.endsWith('.onnx')).sort();
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

    loaded = true;
    return true;
  } catch (err) {
    logger.error('[ML] Failed to load model:', err);
    loadingPromise = null;
    return false;
  }
}

/**
 * Build a feature vector for a single game given user + game profiles.
 * Features not available at recommendation time (hours, review text)
 * use sensible defaults from the training distribution.
 */
function buildFeatureVector(
  userProfile: UserProfile,
  gp: GameProfile | undefined,
  defaults: Record<string, number>,
): Float32Array {
  const vec = new Float32Array(N_FEATURES);

  const d = defaults;
  const g = gp || {} as Partial<GameProfile>;

  // Numeric features (indices 0..41) — same order as feature_spec.feature_names
  vec[0] = d.log_hours;                                                  // log_hours (default)
  vec[1] = g.price != null ? g.price / 60.0 : d.price_norm;             // price_norm
  vec[2] = g.discount ?? d.discount;                                     // discount
  vec[3] = g.win != null ? (g.win ? 1 : 0) : d.win;                     // win
  vec[4] = g.mac != null ? (g.mac ? 1 : 0) : d.mac;                     // mac
  vec[5] = g.linux != null ? (g.linux ? 1 : 0) : d.linux;               // linux
  vec[6] = g.steam_deck != null ? (g.steam_deck ? 1 : 0) : d.steam_deck; // steam_deck
  vec[7] = d.log_helpful;                                                // log_helpful (default)
  vec[8] = d.log_funny;                                                  // log_funny (default)
  vec[9] = userProfile.log_products;                                     // log_products
  vec[10] = userProfile.log_user_rev;                                    // log_user_rev
  vec[11] = d.review_year;                                               // review_year (default)
  vec[12] = d.review_month;                                              // review_month (default)
  vec[13] = g.positive_ratio != null ? g.positive_ratio / 100.0 : d.positive_ratio_norm;
  vec[14] = g.user_reviews != null ? Math.log1p(g.user_reviews) : d.log_game_reviews;
  vec[15] = d.review_age_days;                                           // review_age_days
  vec[16] = d.game_age_days;                                             // game_age_days
  vec[17] = d.hours_per_game_age;                                        // hours_per_game_age

  // User profile features
  vec[18] = userProfile.u_rec_rate;
  vec[19] = userProfile.u_avg_hours;
  vec[20] = userProfile.u_std_hours;
  vec[21] = userProfile.u_n_reviews;
  vec[22] = userProfile.u_avg_helpful;
  vec[23] = userProfile.u_avg_funny;
  vec[24] = userProfile.u_pct_high_hours;

  // Game profile features
  vec[25] = g.g_rec_rate ?? d.g_rec_rate;
  vec[26] = g.g_avg_hours ?? d.g_avg_hours;
  vec[27] = g.g_std_hours ?? d.g_std_hours;
  vec[28] = g.g_n_reviews ?? d.g_n_reviews;
  vec[29] = g.g_avg_helpful ?? d.g_avg_helpful;
  vec[30] = g.g_pct_high_hours ?? d.g_pct_high_hours;

  // Interaction features — use defaults since we don't have actual hours
  vec[31] = d.hours_vs_user_avg;
  vec[32] = d.hours_vs_game_avg;
  vec[33] = d.user_above_game_avg;
  vec[34] = d.hours_dev_from_game;
  vec[35] = d.hours_dev_from_user;
  vec[36] = d.hours_zscore_user;
  vec[37] = d.hours_zscore_game;
  vec[38] = d.hours_x_pos_ratio;
  vec[39] = d.helpful_vs_game;

  // Cross features
  const uRate = userProfile.u_rec_rate;
  const gRate = g.g_rec_rate ?? d.g_rec_rate;
  vec[40] = uRate * gRate;  // u_rec_x_g_rec
  vec[41] = uRate - gRate;  // u_rec_minus_g_rec

  // Tag features (indices 42..241)
  if (gp?.tags) {
    for (const idx of gp.tags) {
      if (idx >= 0 && idx < TOP_K_TAGS) {
        vec[N_NUMERIC + idx] = 1.0;
      }
    }
  }

  return vec;
}

/**
 * Score a batch of games for a given user profile.
 * Returns P(recommended) for each game, averaged across ensemble folds.
 *
 * LightGBM's ONNX export produces two outputs: "label" (tensor) and
 * "probabilities" (sequence<map>). onnxruntime-node cannot deserialize
 * the sequence<map> type, so we request only "label" and average the
 * binary predictions across ensemble folds for a probability estimate.
 * With 8 folds this gives 9 distinct score levels (0/8 … 8/8).
 */
export async function scoreGames(
  userProfile: UserProfile,
  gameIds: string[],
): Promise<MLScoreResult[]> {
  if (!loaded || sessions.length === 0 || !featureSpec || !ort) {
    return gameIds.map(id => ({ gameId: id, score: 0.5 }));
  }

  const n = gameIds.length;
  if (n === 0) return [];

  const defaults = featureSpec.defaults;

  // Build flat feature buffer for all games
  const flatBuffer = new Float32Array(n * N_FEATURES);
  for (let i = 0; i < n; i++) {
    const steamAppId = gameIds[i].replace('steam-', '');
    const gp = gameProfiles.get(steamAppId);
    const vec = buildFeatureVector(userProfile, gp, defaults);
    flatBuffer.set(vec, i * N_FEATURES);
  }

  const inputTensor = new ort.Tensor('float32', flatBuffer, [n, N_FEATURES]);
  const inputName = featureSpec.onnx_input_name;
  const outputNames = featureSpec.onnx_output_names;
  const labelName = outputNames[0];
  const probName = outputNames.length > 1 ? outputNames[1] : null;

  const probSums = new Float32Array(n);
  const nSessions = sessions.length;

  for (const sess of sessions) {
    // Prefer tensor probabilities (available after re-export with zipmap=False);
    // fall back to label-only to avoid the sequence<map> crash.
    try {
      if (probName) {
        const result = await sess.run({ [inputName]: inputTensor }, [probName]);
        const probOutput = result[probName];
        if (probOutput?.dims && probOutput.data) {
          const cols = probOutput.dims[probOutput.dims.length - 1] as number;
          const data = probOutput.data as Float32Array;
          for (let i = 0; i < n; i++) {
            probSums[i] += data[i * cols + (cols - 1)];
          }
          continue;
        }
      }
    } catch {
      // sequence<map> output — fall through to label path
    }

    try {
      const result = await sess.run({ [inputName]: inputTensor }, [labelName]);
      const labelOutput = result[labelName];
      if (labelOutput?.data) {
        const data = labelOutput.data;
        for (let i = 0; i < n; i++) {
          probSums[i] += Number(data[i]);
        }
      }
    } catch (err) {
      logger.warn('[ML] Fold scoring failed, skipping:', err);
    }
  }

  return gameIds.map((id, i) => ({
    gameId: id,
    score: probSums[i] / nSessions,
  }));
}

/**
 * Build an approximate user profile from library data.
 * Maps the user's game library stats to the features the ML model expects.
 */
export function buildUserProfile(
  games: Array<{
    gameId: string;
    hoursPlayed: number;
    rating: number;
    status: string;
  }>,
): UserProfile {
  if (games.length === 0) {
    return {
      u_rec_rate: featureSpec?.global_rec_rate ?? 0.85,
      u_avg_hours: 3.0,
      u_std_hours: 1.5,
      u_n_reviews: 0,
      u_avg_helpful: 0,
      u_avg_funny: 0,
      u_pct_high_hours: 0.3,
      log_products: 0,
      log_user_rev: 0,
    };
  }

  const n = games.length;
  const logHours = games.map(g => Math.log1p(Math.min(g.hoursPlayed || 0, 999.9)));
  const avgLogH = logHours.reduce((s, h) => s + h, 0) / n;
  const varH = logHours.reduce((s, h) => s + (h - avgLogH) ** 2, 0) / n;

  // Approximate rec_rate: games with rating >= 3 or status 'completed'/'playing' are "recommended"
  const recommended = games.filter(g =>
    g.rating >= 3 || g.status === 'completed' || g.status === 'playing',
  ).length;
  const smoothM = featureSpec?.smooth_m ?? 10;
  const globalRate = featureSpec?.global_rec_rate ?? 0.85;
  const recRate = (recommended + smoothM * globalRate) / (games.length + smoothM);

  const highHours = games.filter(g => g.hoursPlayed > 20).length;

  return {
    u_rec_rate: recRate,
    u_avg_hours: avgLogH,
    u_std_hours: Math.sqrt(varH),
    u_n_reviews: Math.log1p(games.length),
    u_avg_helpful: 0, // not available from app data
    u_avg_funny: 0,
    u_pct_high_hours: highHours / games.length,
    log_products: Math.log1p(games.length),
    log_user_rev: Math.log1p(games.filter(g => g.rating > 0).length),
  };
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
