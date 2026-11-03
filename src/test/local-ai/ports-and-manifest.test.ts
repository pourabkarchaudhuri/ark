/**
 * Port picking for the built-in servers (skips busy ports, never 11434) and the pinned runtime
 * manifest (every file pinned by sha256, only trusted hosts, valid roles).
 */
import { describe, it, expect } from 'vitest';
import net from 'node:net';
import {
  pickFreePort, isPortFree, LOCAL_AI_PORT_BASE, OLLAMA_DEFAULT_PORT,
} from '../../../electron/local-ai/ports';
import {
  getManifest, validateManifest, getAutoModels, getModelForRole, LOCAL_AI_ROLES,
  type RuntimeManifest,
} from '../../../electron/local-ai/manifest';

describe('pickFreePort', () => {
  it('starts at the private base and skips busy ports', async () => {
    const busy = new Set([LOCAL_AI_PORT_BASE, LOCAL_AI_PORT_BASE + 1]);
    const port = await pickFreePort({ isFree: async (p) => !busy.has(p) });
    expect(port).toBe(LOCAL_AI_PORT_BASE + 2);
  });

  it('skips ports Ark already handed out this session', async () => {
    const port = await pickFreePort({ exclude: [LOCAL_AI_PORT_BASE], isFree: async () => true });
    expect(port).toBe(LOCAL_AI_PORT_BASE + 1);
  });

  it('never returns 11434 even when the range is moved over it', async () => {
    const asked: number[] = [];
    const port = await pickFreePort({ base: OLLAMA_DEFAULT_PORT - 1, span: 3, isFree: async (p) => { asked.push(p); return true; } });
    expect(port).toBe(OLLAMA_DEFAULT_PORT - 1);
    const next = await pickFreePort({ base: OLLAMA_DEFAULT_PORT, span: 2, isFree: async (p) => { asked.push(p); return true; } });
    expect(next).toBe(OLLAMA_DEFAULT_PORT + 1);
    expect(asked).not.toContain(OLLAMA_DEFAULT_PORT);
  });

  it('returns null when the whole range is taken', async () => {
    expect(await pickFreePort({ span: 4, isFree: async () => false })).toBeNull();
  });

  it('really skips a port something listens on', async () => {
    const holder = net.createServer();
    await new Promise<void>((r) => holder.listen({ port: 0, host: '127.0.0.1' }, r));
    const taken = (holder.address() as net.AddressInfo).port;
    try {
      expect(await isPortFree(taken)).toBe(false);
      const picked = await pickFreePort({ base: taken, span: 5 });
      expect(picked).not.toBe(taken);
      expect(picked).not.toBeNull();
    } finally {
      await new Promise<void>((r) => holder.close(() => r()));
    }
  });
});

describe('runtime manifest', () => {
  it('the shipped manifest is valid', () => {
    expect(validateManifest(getManifest())).toEqual([]);
  });

  it('pins the runtime zip and every model source by sha256', () => {
    const m = getManifest();
    expect(m.runtime.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(m.runtime.build).toMatch(/^b\d+$/);
    for (const model of m.models) {
      expect(model.sources.length).toBeGreaterThan(0);
      for (const src of model.sources) {
        expect(src.sha256).toMatch(/^[0-9a-f]{64}$/);
        expect(src.size).toBeGreaterThan(0);
      }
    }
  });

  it('the Ollama blob URL of each model embeds the same sha256 as the pinned hash', () => {
    for (const model of getManifest().models) {
      for (const src of model.sources.filter((s) => s.kind === 'ollama')) {
        expect(src.url.endsWith(`sha256:${src.sha256}`)).toBe(true);
      }
    }
  });

  it('downloads the Oracle models automatically and the chat model only on request', () => {
    expect(getAutoModels().map((m) => m.role).sort()).toEqual(['embed', 'rerank', 'rerank-qwen']);
    expect(getModelForRole('chat')?.auto).toBe(false);
    for (const role of LOCAL_AI_ROLES) expect(getModelForRole(role)).toBeDefined();
  });

  it('puts the Ollama registry before Hugging Face (same vector space as cached vectors)', () => {
    expect(getModelForRole('embed')?.sources.map((s) => s.kind)).toEqual(['ollama', 'huggingface']);
  });

  it('rejects a bad manifest: unknown host, short hash, duplicate role', () => {
    const base = JSON.parse(JSON.stringify(getManifest())) as RuntimeManifest;
    const evil = JSON.parse(JSON.stringify(base)) as RuntimeManifest;
    evil.models[0].sources[0].url = 'https://evil.example.com/model.gguf';
    expect(validateManifest(evil).join(' ')).toMatch(/host not allowed/);
    const shortHash = JSON.parse(JSON.stringify(base)) as RuntimeManifest;
    shortHash.models[0].sources[0].sha256 = 'abc';
    expect(validateManifest(shortHash).join(' ')).toMatch(/sha256 invalid/);
    const dup = JSON.parse(JSON.stringify(base)) as RuntimeManifest;
    dup.models[1].role = 'embed';
    expect(validateManifest(dup).join(' ')).toMatch(/listed twice/);
    const badUrl = JSON.parse(JSON.stringify(base)) as RuntimeManifest;
    badUrl.runtime.url = 'https://example.com/llama.zip';
    expect(validateManifest(badUrl).join(' ')).toMatch(/ggml-org\/llama.cpp release/);
  });
});
