/**
 * Gate for synthesised ML profiles: how well do scores from catalog-style metadata track the real
 * scores? Takes real Kaggle profiles, hides the per-game review aggregates (g_*), keeps only the tags
 * a store genre/theme list could produce, scores both with the real ensemble, and compares.
 *
 *   npx vite-node scripts/ml/verify-synth.ts [dataset/ml]
 *
 * Prints one JSON line; exits 1 when any user archetype falls below Spearman 0.7 (then synthesised
 * scores must stay off). The mean shift is reported but not gated: synthesised scores are
 * percentile-ranked within their own group and shrunk toward the middle, so a shift in raw
 * probability never reaches the ranking.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { buildFeatureVector, buildUserProfileFromGames, N_FEATURES } from '../../electron/ml-features';
import { buildSyntheticProfile, buildTagIndex, normalizeTagName } from '../../electron/ml-synth';

const require = createRequire(import.meta.url);
const mlDir = path.resolve(process.argv[2] ?? 'dataset/ml');
const ort = require('onnxruntime-node');
const spec = JSON.parse(fs.readFileSync(path.join(mlDir, 'feature_spec.json'), 'utf8'));
const tagMapping: string[] = JSON.parse(fs.readFileSync(path.join(mlDir, 'tag_mapping.json'), 'utf8'));
const profiles = JSON.parse(fs.readFileSync(path.join(mlDir, 'game_profiles.json'), 'utf8')) as Record<string, any>;
const tagIndex = buildTagIndex(tagMapping);

// Tag names a store genre / theme / mode list can produce (canonical genres, IGDB themes, modes).
const STORE_TAGS = new Set([
  'action', 'adventure', 'rpg', 'strategy', 'simulation', 'casual', 'indie', 'puzzle', 'horror', 'shooter',
  'platformer', 'racing', 'sports', 'fighting', 'survival', 'open world', 'sci-fi', 'fantasy', 'multiplayer',
  'singleplayer', 'co-op', 'mmo', 'sandbox', 'stealth', 'arcade', 'visual novel', 'card game', 'turn-based',
  'rts', 'tactical', 'roguelike', 'roguelite', 'metroidvania', 'point & click', 'music', 'educational',
  'comedy', 'mystery', 'historical', 'war', 'drama', 'thriller', 'free to play', 'first-person', 'third person',
  'early access', 'massively multiplayer', 'action-adventure', 'story rich',
].map(normalizeTagName));

const ids = Object.keys(profiles).filter(id => Array.isArray(profiles[id].tags) && profiles[id].tags.length >= 3).slice(0, 3000);

function synthOf(p: any) {
  const names = (p.tags as number[]).map(i => tagMapping[i]).filter(n => STORE_TAGS.has(normalizeTagName(n)));
  return buildSyntheticProfile({
    positivity: typeof p.positive_ratio === 'number' ? p.positive_ratio / 100 : undefined,
    reviews: p.user_reviews,
    priceUsd: p.price,
    windows: p.win, mac: p.mac, linux: p.linux,
    tags: names,
  }, tagIndex);
}

function rank(xs: number[]): number[] {
  const order = xs.map((v, i) => [v, i] as const).sort((a, b) => a[0] - b[0]);
  const r = new Array(xs.length);
  order.forEach(([, i], k) => { r[i] = k; });
  return r;
}
function spearman(a: number[], b: number[]): number {
  const ra = rank(a), rb = rank(b);
  const n = a.length;
  const ma = (n - 1) / 2;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) { num += (ra[i] - ma) * (rb[i] - ma); da += (ra[i] - ma) ** 2; db += (rb[i] - ma) ** 2; }
  return num / Math.sqrt(da * db);
}

async function scoreAll(sessions: any[], user: any, rows: any[]): Promise<number[]> {
  const flat = new Float32Array(rows.length * N_FEATURES);
  rows.forEach((p, i) => flat.set(buildFeatureVector(user, p, spec.defaults), i * N_FEATURES));
  const input = new ort.Tensor('float32', flat, [rows.length, N_FEATURES]);
  const sums = new Float64Array(rows.length);
  for (const s of sessions) {
    const out = await s.run({ [spec.onnx_input_name]: input }, ['probabilities']);
    const d = out.probabilities.data as Float32Array;
    for (let i = 0; i < rows.length; i++) sums[i] += d[i * 2 + 1];
  }
  return Array.from(sums, v => v / sessions.length);
}

async function main() {
  const ens = path.join(mlDir, 'onnx_ensemble');
  const sessions = [];
  for (const f of fs.readdirSync(ens).filter(f => /^fold_\d+\.onnx$/.test(f)).sort()) {
    sessions.push(await ort.InferenceSession.create(path.join(ens, f), { logSeverityLevel: 3 }));
  }
  const usable = ids.map(id => ({ id, real: profiles[id], synth: synthOf(profiles[id]) })).filter(r => r.synth);
  const archetypes: Record<string, number[]> = { light: [2, 1, 1, 0.5], medium: [30, 12, 8, 4, 2], heavy: [400, 220, 150, 90, 60, 40] };
  const results: Record<string, { spearman: number; meanShift: number }> = {};
  let pass = true;
  for (const [name, hours] of Object.entries(archetypes)) {
    const user = buildUserProfileFromGames(
      hours.map((h, i) => ({ gameId: `steam-${i}`, hoursPlayed: h, rating: 4, status: 'Completed' })),
      { globalRecRate: spec.global_rec_rate, smoothM: spec.smooth_m, defaults: spec.defaults },
    );
    const real = await scoreAll(sessions, user, usable.map(r => r.real));
    const syn = await scoreAll(sessions, user, usable.map(r => r.synth));
    const rho = spearman(real, syn);
    const shift = syn.reduce((a, b) => a + b, 0) / syn.length - real.reduce((a, b) => a + b, 0) / real.length;
    results[name] = { spearman: Math.round(rho * 1000) / 1000, meanShift: Math.round(shift * 1000) / 1000 };
    if (!(rho >= 0.7)) pass = false;
  }
  console.log(JSON.stringify({ n: usable.length, of: ids.length, results, pass }));
  process.exit(pass ? 0 : 1);
}
main().catch(e => { console.error(e); process.exit(1); });
