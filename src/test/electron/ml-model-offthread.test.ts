/**
 * ML model main-thread budget (1.0.97).
 *
 * Each fold run over a 2000-row Oracle batch blocked the Electron main thread
 * for up to ~1.7 s, and the model load parsed its JSON artifacts with
 * readFileSync. scoreGames now runs every fold over sub-batches of
 * ML_SCORE_SUB_BATCH rows and yields between runs (rows are scored
 * independently, so scores are unchanged); the load reads and copies files
 * asynchronously and caps onnxruntime's intra-op threads at half the cores.
 *
 * onnxruntime-node and the userData paths are replaced through
 * `__setMlModelTestHooks` (createRequire bypasses vi.mock).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

vi.mock('../../../electron/safe-logger.js', () => ({
  logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import {
  ML_SCORE_SUB_BATCH,
  __resetMlModelForTests,
  __setMlModelTestHooks,
  loadModel,
  scoreGames,
} from '../../../electron/ml-model';
import { N_FEATURES, N_NUMERIC } from '../../../electron/ml-features';

const TAGS = Array.from({ length: N_FEATURES - N_NUMERIC }, (_, i) => `tag${i}`);
const N_GAMES = 700;

class FakeTensor {
  constructor(public type: string, public data: Float32Array, public dims: number[]) {}
}

/** Deterministic per-row "model": each fold weights the row's features differently. */
function makeOrt() {
  const runs: number[] = [];
  const createOpts: Array<Record<string, unknown>> = [];
  let foldSeed = 0;
  const ort = {
    Tensor: FakeTensor,
    InferenceSession: {
      create: async (_p: string, opts: Record<string, unknown>) => {
        createOpts.push(opts);
        const fold = ++foldSeed;
        return {
          run: async (feeds: Record<string, FakeTensor>, names: string[]) => {
            const t = Object.values(feeds)[0];
            const rows = t.dims[0];
            runs.push(rows);
            const out = new Float32Array(rows * 2);
            for (let r = 0; r < rows; r++) {
              let s = 0;
              for (let j = 0; j < N_FEATURES; j++) {
                const x = t.data[r * N_FEATURES + j]; // features left to empty defaults are NaN here
                if (Number.isFinite(x)) s += x * ((j % 7) + fold) * 0.001;
              }
              const p = 1 / (1 + Math.exp(-s));
              out[r * 2] = 1 - p;
              out[r * 2 + 1] = p;
            }
            return { [names[0]]: { type: 'float32', dims: [rows, 2], data: out } };
          },
        };
      },
    },
  };
  return { ort, runs, createOpts };
}

let root: string;
let sourceDir: string;

function writeSource(): void {
  fs.mkdirSync(path.join(sourceDir, 'onnx_ensemble'), { recursive: true });
  const profiles: Record<string, unknown> = {};
  for (let i = 0; i < N_GAMES; i++) {
    profiles[String(1000 + i)] = {
      g_rec_rate: (i % 97) / 97, g_avg_hours: i % 40, g_std_hours: 3, g_n_reviews: 10 + i,
      g_avg_helpful: 1, g_pct_high_hours: 0.1, price: i % 60, win: true, tags: [i % TAGS.length, (i * 3) % TAGS.length],
    };
  }
  fs.writeFileSync(path.join(sourceDir, 'game_profiles.json'), JSON.stringify(profiles));
  fs.writeFileSync(path.join(sourceDir, 'tag_mapping.json'), JSON.stringify(TAGS));
  fs.writeFileSync(path.join(sourceDir, 'feature_spec.json'), JSON.stringify({
    feature_names: [], n_features: N_FEATURES, top_k_tags: TAGS.length, smooth_m: 10, global_rec_rate: 0.85,
    onnx_input_name: 'input', onnx_output_names: ['label', 'probabilities'], defaults: {},
  }));
  for (let f = 0; f < 8; f++) fs.writeFileSync(path.join(sourceDir, 'onnx_ensemble', `fold_${f}.onnx`), 'x');
}

const user = {
  u_rec_rate: 0.8, u_avg_hours: 20, u_std_hours: 5, u_n_reviews: 12, u_avg_helpful: 1,
  u_avg_funny: 0, u_pct_high_hours: 0.2, log_products: 3, log_user_rev: 2,
};
const ids = Array.from({ length: N_GAMES }, (_, i) => `steam-${1000 + i}`);

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'ark-ml-test-'));
  sourceDir = path.join(root, 'src');
  writeSource();
});

afterEach(() => {
  __resetMlModelForTests();
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

async function load(subBatch?: number) {
  const fake = makeOrt();
  __resetMlModelForTests();
  __setMlModelTestHooks({ ort: fake.ort, userDataDir: path.join(root, 'user'), sourceDir, cpuCount: 8, scoreSubBatch: subBatch });
  expect(await loadModel()).toBe(true);
  return fake;
}

describe('scoreGames — sub-batched fold runs', () => {
  it('scores are identical to one run per fold over every row', async () => {
    await load(Number.MAX_SAFE_INTEGER);
    const whole = await scoreGames(user, ids);
    const fake = await load();
    fake.runs.length = 0;
    const chunked = await scoreGames(user, ids);
    expect(chunked.map((r) => r.gameId)).toEqual(whole.map((r) => r.gameId));
    chunked.forEach((r, i) => expect(r.score).toBeCloseTo(whole[i].score, 6));
    expect(whole).toHaveLength(N_GAMES);
  });

  it(`runs each fold over at most ${ML_SCORE_SUB_BATCH} rows`, async () => {
    const fake = await load();
    fake.runs.length = 0;
    await scoreGames(user, ids);
    const slices = Math.ceil(N_GAMES / ML_SCORE_SUB_BATCH);
    expect(fake.runs).toHaveLength(slices * 8);
    expect(Math.max(...fake.runs)).toBeLessThanOrEqual(ML_SCORE_SUB_BATCH);
    expect(fake.runs.reduce((a, b) => a + b, 0)).toBe(N_GAMES * 8);
  });

  it('yields to the event loop between runs', async () => {
    await load();
    let ticks = 0;
    let running = true;
    const spin = () => { if (!running) return; ticks++; setImmediate(spin); };
    setImmediate(spin);
    await scoreGames(user, ids);
    running = false;
    expect(ticks).toBeGreaterThanOrEqual(Math.ceil(N_GAMES / ML_SCORE_SUB_BATCH) * 8 - 2);
  });
});

describe('loadModel — asynchronous file I/O', () => {
  it('reads the JSON artifacts with fs.promises.readFile', async () => {
    const asyncRead = vi.spyOn(fs.promises, 'readFile');
    await load();
    const asyncNames = asyncRead.mock.calls.map((c) => path.basename(String(c[0])));
    expect(asyncNames).toEqual(expect.arrayContaining(['feature_spec.json', 'tag_mapping.json', 'game_profiles.json']));
  });

  it('copies artifacts into userData with fs.promises.copyFile', async () => {
    const asyncCopy = vi.spyOn(fs.promises, 'copyFile');
    await load();
    expect(asyncCopy.mock.calls.length).toBe(3 + 8);
    expect(fs.existsSync(path.join(root, 'user', 'ml-data', 'onnx_ensemble', 'fold_7.onnx'))).toBe(true);
  });

  it('caps onnxruntime intra-op threads at half the cores', async () => {
    const fake = await load();
    expect(fake.createOpts.length).toBe(8);
    for (const o of fake.createOpts) expect(o.intraOpNumThreads).toBe(4);
  });
});
