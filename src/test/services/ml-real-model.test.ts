/**
 * R3 no-disable guarantee: runs the REAL bundled ensemble (scripts/ml/verify-ensemble.ts,
 * in a child process: onnxruntime-node rejects jsdom's typed arrays) and fails if the ML
 * layer is dead or saturated — the pre-R3 failure was an unreadable ZipMap output that
 * collapsed scores to 0/1 votes (~9 distinct levels).
 * dataset/ is gitignored (models are built locally), so this skips where artifacts are absent.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(__dirname, '../../..');
const ENSEMBLE = path.join(ROOT, 'dataset/ml/onnx_ensemble');
const have =
  fs.existsSync(path.join(ROOT, 'dataset/ml/feature_spec.json')) &&
  fs.existsSync(path.join(ROOT, 'dataset/ml/game_profiles.json')) &&
  fs.existsSync(ENSEMBLE) &&
  fs.readdirSync(ENSEMBLE).filter(f => /^fold_\d+\.onnx$/.test(f)).length === 8;

describe.skipIf(!have)('bundled ONNX ensemble', () => {
  it('every fold returns a float probabilities tensor; scores are continuous and unsaturated', () => {
    const out = execFileSync(
      process.execPath,
      [path.join(ROOT, 'node_modules/vite-node/vite-node.mjs'), 'scripts/ml/verify-ensemble.ts'],
      { cwd: ROOT, encoding: 'utf8', timeout: 110_000 },
    );
    const r = JSON.parse(out.trim().split('\n').pop()!);
    expect(r.folds).toBe(8);
    expect(r.types.every((t: string) => t === 'float32')).toBe(true);
    expect(r.allFinite).toBe(true);
    expect(r.distinct).toBeGreaterThan(200);
    expect(r.modeShare).toBeLessThan(0.8);
    expect(r.max - r.min).toBeGreaterThan(0.1);
  }, 120_000);
});
