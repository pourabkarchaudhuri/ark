/**
 * Verify the bundled ONNX ensemble returns continuous probabilities through
 * onnxruntime-node and the real feature builder. Prints one JSON line.
 *   npx vite-node scripts/ml/verify-ensemble.ts [dataset/ml]
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { buildFeatureVector, buildUserProfileFromGames, N_FEATURES } from '../../electron/ml-features';

const require = createRequire(import.meta.url);
const mlDir = path.resolve(process.argv[2] ?? 'dataset/ml');
const ensemble = path.join(mlDir, 'onnx_ensemble');
const ort = require('onnxruntime-node');

const spec = JSON.parse(fs.readFileSync(path.join(mlDir, 'feature_spec.json'), 'utf8'));
const profiles = JSON.parse(fs.readFileSync(path.join(mlDir, 'game_profiles.json'), 'utf8')) as Record<string, any>;
const ids = Object.keys(profiles).slice(0, 2000);

const user = buildUserProfileFromGames(
  [40, 25, 12, 8, 3].map((h, i) => ({ gameId: `steam-${i}`, hoursPlayed: h, rating: 4, status: 'Completed' })),
  { globalRecRate: spec.global_rec_rate, smoothM: spec.smooth_m, defaults: spec.defaults },
);
const flat = new Float32Array(ids.length * N_FEATURES);
ids.forEach((id, i) => flat.set(buildFeatureVector(user, profiles[id], spec.defaults), i * N_FEATURES));
const input = new ort.Tensor('float32', flat, [ids.length, N_FEATURES]);

const folds = fs.readdirSync(ensemble).filter(f => /^fold_\d+\.onnx$/.test(f)).sort();
const sums = new Float32Array(ids.length);
const types: string[] = [];
async function main() {
  for (const f of folds) {
    const sess = await ort.InferenceSession.create(path.join(ensemble, f), { logSeverityLevel: 3 });
    const out = await sess.run({ [spec.onnx_input_name]: input }, ['probabilities']);
    types.push(out.probabilities.type);
    const d = out.probabilities.data as Float32Array;
    for (let i = 0; i < ids.length; i++) sums[i] += d[i * 2 + 1];
  }
  const scores = Array.from(sums, s => s / folds.length);
  const counts = new Map<string, number>();
  let modeCount = 0;
  for (const s of scores) {
    const k = s.toFixed(3);
    const c = (counts.get(k) ?? 0) + 1;
    counts.set(k, c);
    modeCount = Math.max(modeCount, c);
  }
  console.log(JSON.stringify({
    folds: folds.length,
    types,
    n: scores.length,
    allFinite: scores.every(s => Number.isFinite(s) && s >= 0 && s <= 1),
    distinct: new Set(scores.map(s => s.toFixed(4))).size,
    modeShare: modeCount / scores.length,
    min: Math.min(...scores),
    max: Math.max(...scores),
    mean: scores.reduce((a, b) => a + b, 0) / scores.length,
  }));
}
main().catch(e => { console.error(e); process.exit(1); });
