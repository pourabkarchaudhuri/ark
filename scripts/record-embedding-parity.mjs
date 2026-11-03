/**
 * Record Ollama's embeddings for the fixed parity texts (1.0.97 B36).
 *
 *   node scripts/record-embedding-parity.mjs [--url=http://127.0.0.1:11434] [--model=snowflake-arctic-embed2]
 *
 * Writes src/test/fixtures/embedding-parity.json. src/test/local-ai/embedding-parity.test.ts then
 * embeds the same texts with the built-in llama.cpp runtime and requires cosine >= 0.999 for every
 * row; that is what keeps EMBEDDING_MODEL_VERSION (and every cached vector) valid. If a row fails,
 * bump EMBEDDING_MODEL_VERSION in src/services/embedding-service.ts (one re-embed on first launch,
 * said in the release notes) and review the Oracle golden test.
 *
 * Needs a reachable Ollama that has the model. Run it once; commit the fixture (it is a few
 * hundred KB of numbers, not a model file).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PARITY_TEXTS = [
  'Hades: a god-like rogue-like dungeon crawler where you defy the god of the dead as you hack and slash out of the Underworld.',
  'Stardew Valley: you inherit your grandfather\'s old farm plot. Armed with hand-me-down tools and a few coins, you set out to begin your new life.',
  'Doom Eternal: hell\'s armies have invaded Earth. Become the Slayer in an epic single-player campaign to conquer demons across dimensions.',
  'Disco Elysium: a groundbreaking role playing game. You are a detective with a unique skill system at your disposal and a whole city to carve your path across.',
  'Celeste: help Madeline survive her inner demons on her journey to the top of Celeste Mountain in this super-tight platformer.',
  'Civilization VI: expand your empire, advance your culture and go head-to-head against history\'s greatest leaders.',
  'Hollow Knight: forge your own path in a vast ruined kingdom of insects and heroes. A classically styled 2D action adventure.',
  'Forza Horizon 5: your ultimate Horizon Adventure awaits. Explore the vibrant open world landscapes of Mexico with limitless, fun driving action.',
  'Slay the Spire: we fused card games and roguelikes together to make the best single player deckbuilder we could.',
  'Portal 2: the highly anticipated sequel to the award-winning Portal. Co-operative puzzle platformer with a dark sense of humour.',
  'cozy farming sim with relaxing music and pixel art',
  'tense co-op survival horror where you must scavenge supplies and fight off waves of enemies at night',
  'Ярость: быстрый шутер от первого лица с мощным оружием и демонами',
  '戦略シミュレーション: 国を発展させ、同盟を結び、戦争に勝利せよ',
];

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name, def) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? def;

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const url = arg('url', 'http://127.0.0.1:11434').replace(/\/$/, '');
  const model = arg('model', 'snowflake-arctic-embed2');
  let res;
  try {
    res = await fetch(`${url}/api/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, input: PARITY_TEXTS }),
    });
  } catch (err) {
    console.error(`[parity] Ollama is not reachable at ${url}: ${err instanceof Error ? err.message : err}`);
    process.exit(2);
  }
  if (!res.ok) {
    console.error(`[parity] Ollama answered HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    process.exit(2);
  }
  const { embeddings } = await res.json();
  if (!Array.isArray(embeddings) || embeddings.length !== PARITY_TEXTS.length) {
    console.error('[parity] unexpected embed response');
    process.exit(2);
  }
  const out = path.join(root, 'src', 'test', 'fixtures', 'embedding-parity.json');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify({ model, recordedAt: new Date().toISOString(), texts: PARITY_TEXTS, ollama: embeddings }), 'utf8');
  console.log(`[parity] wrote ${path.relative(root, out)} (${embeddings.length} rows x ${embeddings[0].length} dims)`);
}
