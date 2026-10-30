/**
 * Write build/.env.release from .env through the release allow-list (scripts/lib/release-env.mjs).
 * electron-builder's extraFiles ships that file as .env next to Ark.exe. Run by build:app.
 *
 *   node scripts/build-release-env.mjs
 *
 * Prints key names only, never values. A missing .env writes an empty file, so a build from a
 * clean checkout still packages (Steam list/tag calls and analytics then stay off).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { envKeyNames, filterReleaseEnv } from './lib/release-env.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = path.join(root, '.env');
const dest = path.join(root, 'build', '.env.release');

const text = fs.existsSync(src) ? fs.readFileSync(src, 'utf8') : '';
const out = filterReleaseEnv(text);
fs.mkdirSync(path.dirname(dest), { recursive: true });
fs.writeFileSync(dest, out, 'utf8');

const kept = envKeyNames(out);
const dropped = envKeyNames(text).filter((n) => !kept.includes(n));
console.log(`[release-env] build/.env.release: ${kept.length} key(s) kept (${kept.join(', ') || 'none'}), ${dropped.length} dropped`);
