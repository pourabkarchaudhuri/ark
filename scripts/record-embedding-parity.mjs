/**
 * Record Ollama's embeddings for the fixed parity texts (1.0.97 B36).
 *
 *   node scripts/record-embedding-parity.mjs [--url=http://127.0.0.1:11434] [--model=snowflake-arctic-embed2]
 *                                            [--llama-url=http://127.0.0.1:PORT [--api-key=KEY]]
 *
 * Writes src/test/fixtures/embedding-parity.json: Ollama's vectors and, with --llama-url, the vectors
 * of a running llama-server (HF GGUF) plus the rows where the two spaces differ (cosine < 0.999).
 * src/test/local-ai/embedding-parity.test.ts then embeds the same texts with the built-in runtime and
 * compares them with both. Recorded 1.0.97 B36: ~all plain-text rows agree at >= 0.99994, but Ollama's
 * tokenizer skips the sentencepiece normalisation table (precompiled_charsmap) that llama.cpp applies
 * (full-width and CJK punctuation, curly quotes, trade marks, ligatures, tabs/newlines), so those
 * rows differ by up to ~0.1-0.8 cosine. That is why EMBEDDING_MODEL_VERSION was bumped to 2.
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
  'Elden Ring: rise, Tarnished, and be guided by grace to brandish the power of the Elden Ring in the Lands Between. A vast fantasy world created by Hidetaka Miyazaki and George R. R. Martin.',
  'The Witcher 3: Wild Hunt: as war rages on throughout the Northern Realms, you take on the greatest contract of your life, tracking down the Child of Prophecy.',
  'Minecraft: explore randomly generated worlds and build amazing things from the simplest of homes to the grandest of castles. Play in creative mode or fight to survive.',
  'Counter-Strike 2: for over two decades, Counter-Strike has offered an elite competitive experience shaped by millions of players from across the globe.',
  'Factorio: build and maintain factories. You will be mining resources, researching technologies, building infrastructure, automating production and fighting enemies.',
  'Hearts of Iron IV: victory is at your fingertips! Your ability to lead your nation is your supreme weapon, the strategy game for the Second World War.',
  'Return of the Obra Dinn: in 1807, the Obra Dinn set out from London for the Orient with 60 souls aboard. Now she drifts back with no one on board. Take the role of an insurance investigator.',
  'Cities: Skylines: a modern take on the classic city simulation. The game introduces new game play elements to realize the thrill and hardships of creating and maintaining a real city.',
  'Hi-Fi Rush: a rhythm action game where everything moves to the beat. Fight, dodge and slash with a punk rock robot hero in a colourful cel-shaded world.',
  'Baldur\'s Gate 3: gather your party and return to the Forgotten Realms in a tale of fellowship and betrayal, sacrifice and survival, and the lure of absolute power.',
  'a short relaxing puzzle game about rotating tiles, no combat, soothing ambient soundtrack',
  'competitive 5v5 tactical shooter with agent abilities and economy-based rounds',
  'Dark Souls III: as fires fade and the world falls into ruin, journey into a universe filled with colossal enemies and challenging bosses. Prepare to die.',
  'Spiel des Jahres: ein kooperatives Brettspiel für die ganze Familie, bei dem alle gemeinsam gegen das Spiel antreten und Rätsel lösen müssen.',
  'Jeu de rôle au tour par tour avec une histoire poignante, des combats stratégiques et une bande-son orchestrale inoubliable.',
  '这是一款开放世界冒险游戏，玩家可以自由探索广阔的大陆，收集角色，挑战强大的敌人。',
  'Subnautica: descend into the depths of an alien underwater world filled with wonder and peril. Craft equipment, pilot submarines and out-smart wildlife to explore lush coral reefs.',
  'Vampire Survivors: mow down thousands of night creatures and survive until dawn! An addictive gothic horror casual game with rogue-lite elements.',
  'Don\u2019t miss \u201cHades\u201d \u2014 the award-winning roguelike\u2026 now with new weapons\u2122 and Aspects\u00ae.',
  'About the game:\n\nBuild your base.\tDefend it.\n\nFeatures:\n- 4 player co-op\n- 100+ items\r\n- crafting',
];

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name, def) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? def;

export function cosine(a, b) {
  let dot = 0; let na = 0; let nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** Six decimals keep the committed fixture small and move a cosine by < 1e-6. */
const round = (rows) => rows.map((r) => r.map((x) => Math.round(x * 1e6) / 1e6));

async function postJson(url, body, headers = {}) {
  let res;
  try {
    res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  } catch (err) {
    console.error(`[parity] ${url} is not reachable: ${err instanceof Error ? err.message : err}`);
    process.exit(2);
  }
  if (!res.ok) {
    console.error(`[parity] ${url} answered HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    process.exit(2);
  }
  return res.json();
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const url = arg('url', 'http://127.0.0.1:11434').replace(/\/$/, '');
  const model = arg('model', 'snowflake-arctic-embed2');
  const llamaUrl = arg('llama-url', '').replace(/\/$/, '');
  const { embeddings } = await postJson(`${url}/api/embed`, { model, input: PARITY_TEXTS });
  if (!Array.isArray(embeddings) || embeddings.length !== PARITY_TEXTS.length) {
    console.error('[parity] unexpected embed response');
    process.exit(2);
  }
  const out = { model, recordedAt: new Date().toISOString(), texts: PARITY_TEXTS, ollama: round(embeddings) };
  if (llamaUrl) {
    // A llama-server started like the app does: --embedding --pooling cls -c 8192 -b 8192 -ub 8192, HF GGUF.
    const { data } = await postJson(`${llamaUrl}/v1/embeddings`, { input: PARITY_TEXTS, encoding_format: 'float' }, arg('api-key', '') ? { Authorization: `Bearer ${arg('api-key', '')}` } : {});
    out.builtin = round(data.sort((x, y) => x.index - y.index).map((d) => d.embedding));
    out.builtinModel = arg('llama-model', 'snowflake-arctic-embed-l-v2.0-f16.gguf (sha256 745f544e...06aa)');
    const cos = out.builtin.map((v, i) => cosine(v, out.ollama[i]));
    out.divergent = cos.flatMap((c, i) => (c < 0.999 ? [i] : []));
    const min = Math.min(...cos);
    console.log(`[parity] builtin vs ollama: min ${min.toFixed(6)}, mean ${(cos.reduce((a, b) => a + b, 0) / cos.length).toFixed(6)}, divergent rows ${JSON.stringify(out.divergent)}`);
  }
  const file = path.join(root, 'src', 'test', 'fixtures', 'embedding-parity.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(out), 'utf8');
  console.log(`[parity] wrote ${path.relative(root, file)} (${embeddings.length} rows x ${embeddings[0].length} dims)`);
}
