/**
 * Ollama model pull progress (NDJSON streamed over a socket): lines are split only after UTF-8
 * decoding through a StringDecoder, so a multi-byte character cut across two chunks stays intact.
 *
 * settings-store.ts (imported by ollama-setup.ts) pulls `electron` and `fs` at import time, so
 * both are mocked like in rerank-model-tags.test.ts.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/tmp/ark-test') },
}));

vi.mock('fs', () => {
  const api = {
    existsSync: vi.fn(() => false),
    readFileSync: vi.fn(() => '{}'),
    writeFileSync: vi.fn(),
    renameSync: vi.fn(),
    unlinkSync: vi.fn(),
  };
  return { ...api, default: api };
});

vi.mock('../../../electron/safe-logger.js', () => ({
  logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { createNdjsonLineSplitter } from '../../../electron/ollama-setup';

describe('createNdjsonLineSplitter', () => {
  it('decodes a multi-byte character split across chunks and yields only complete lines', () => {
    const stream = Buffer.from('{"status":"pulling"}\n{"error":"modèle introuvable — 模型"}\n{"status":"succ', 'utf8');
    const cutE = stream.indexOf(Buffer.from('è', 'utf8')) + 1;
    const cutCjk = stream.indexOf(Buffer.from('模', 'utf8')) + 1;
    const split = createNdjsonLineSplitter();
    const lines = [
      ...split(stream.subarray(0, cutE)),
      ...split(stream.subarray(cutE, cutCjk)),
      ...split(stream.subarray(cutCjk)),
      ...split(Buffer.from('ess"}\n', 'utf8')),
    ];
    expect(lines.map((l) => JSON.parse(l))).toEqual([
      { status: 'pulling' },
      { error: 'modèle introuvable — 模型' },
      { status: 'success' },
    ]);
  });
});
