/**
 * Tiered Reranker Engine
 *
 * `/api/rerank` does not exist in stable Ollama, so a single-endpoint reranker
 * silently degrades to cosine on every install. This module probes what the
 * local Ollama can actually do and picks the strongest available tier:
 *
 *   1. `native`        — POST /api/rerank against a cross-encoder (Ollama forks / future builds)
 *   2. `qwen_graded`   — Qwen3-Reranker through /api/generate, scored from `top_logprobs`
 *   3. `qwen_binary`   — same model, but the Ollama build predates logprobs support
 *                        (< 0.12.11), so only a hard yes/no is available
 *   4. `embed_fallback`— arctic-embed2 cosine, handled by the IPC caller
 *
 * Detection is cached per session and invalidated through `resetRerankTierCache()`
 * when Ollama settings change, mirroring `resetGpuModeCache()` in ollama-setup.ts.
 *
 * HTTP here uses `fetch`, matching electron/ipc/ollama-handlers.ts (its only caller)
 * rather than the raw `node:http` style in ollama-setup.ts.
 */

import { logger } from './safe-logger.js';
import { settingsStore } from './settings-store.js';
import {
  isOllamaRunning,
  isRerankModelInstalled,
  getRerankModelTag,
  getRerankQwenModelTag,
} from './ollama-setup.js';
import { normalizeOllamaRerankRows, type RerankResultRow } from './ollama-rerank-normalize.js';

export type RerankTier = 'native' | 'qwen_graded' | 'qwen_binary' | 'embed_fallback';

/** First Ollama release that returns `logprobs` / `top_logprobs` from /api/generate. */
export const LOGPROBS_MIN_VERSION = '0.12.11';

const TIER_LABELS: Record<RerankTier, string> = {
  native: 'Native cross-encoder',
  qwen_graded: 'Qwen3 graded',
  qwen_binary: 'Qwen3 binary',
  embed_fallback: 'Cosine fallback',
};

/** Human-readable tier name — shared by the status panel, splash and diagnostics. */
export function rerankTierLabel(tier: RerankTier): string {
  return TIER_LABELS[tier];
}

export interface RerankTierProbe {
  tier: RerankTier;
  label: string;
  model: string;
  available: boolean;
  detail: string;
  httpStatus?: number;
  latencyMs?: number;
}

export interface RerankTierDetection {
  tier: RerankTier;
  /** Model tag the winning tier uses. Empty for the cosine tier. */
  model: string;
  ollamaUp: boolean;
  ollamaVersion: string | null;
  /** Why this tier won — surfaced verbatim in the status panel and diagnostics. */
  reason: string;
  probes: RerankTierProbe[];
  detectedAt: number;
}

// ─── Timeouts and budgets ───────────────────────────────────────────────────
// The Qwen3 tier costs one /api/generate call PER DOCUMENT, so a 100-candidate
// Oracle pool is 100 sequential calls. The budget below is what stops that from
// hanging Oracle: once it is spent the pass is abandoned and the caller drops to
// cosine (see `scoreWithQwen3`).

const NATIVE_PROBE_TIMEOUT_MS = 20_000;
const TAGS_TIMEOUT_MS = 5_000;
/** Generous — the first call also has to load the model into memory. */
const QWEN_DOC_TIMEOUT_MS = 30_000;
const QWEN_BUDGET_BASE_MS = 25_000;
const QWEN_BUDGET_PER_DOC_MS = 600;
/** Same politeness pause the embedding path uses when the window is blurred. */
const QWEN_BG_COOLDOWN_MS = 100;
/** Below this many scored documents the pass is not worth keeping. */
const QWEN_MIN_USEFUL_DOCS = 8;
const QWEN_MIN_USEFUL_FRACTION = 0.4;
/** Per-document prompt trim — keeps prefill cost bounded across 100 calls. */
const QWEN_DOC_MAX_CHARS = 1_500;

function resolveBaseUrl(): string {
  const ollama = settingsStore.getOllamaSettings();
  return (ollama.url || 'http://localhost:11434').replace(/\/$/, '');
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ac.signal });
  } finally {
    clearTimeout(timer);
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ─── Version gate ───────────────────────────────────────────────────────────

/**
 * True when `version` is at least `minimum`. An unknown or unparseable version
 * returns false so we report the weaker binary tier rather than claiming graded
 * scores we cannot produce.
 */
export function versionAtLeast(version: string | null | undefined, minimum: string): boolean {
  if (!version) return false;
  const parse = (v: string): number[] | null => {
    const cleaned = v.trim().replace(/^v/i, '');
    const core = cleaned.split(/[-+]/)[0];
    const parts = core.split('.').map((p) => Number.parseInt(p, 10));
    if (parts.length === 0 || parts.some((n) => !Number.isFinite(n))) return null;
    return parts;
  };
  const a = parse(version);
  const b = parse(minimum);
  if (!a || !b) return false;
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    if (av !== bv) return av > bv;
  }
  return true;
}

// ─── Tier detection ─────────────────────────────────────────────────────────

let _tierCache: RerankTierDetection | null = null;
let _tierInFlight: Promise<RerankTierDetection> | null = null;

/** Reset cached tier detection — call when Ollama settings change. */
export function resetRerankTierCache(): void {
  _tierCache = null;
}

/** Last detection result without triggering a probe. Null before the first run. */
export function getCachedRerankTier(): RerankTierDetection | null {
  return _tierCache;
}

/**
 * Probe the reranker ladder once per session. Concurrent callers share one probe.
 * Pass `{ force: true }` to re-probe after a tier stops working mid-session.
 */
export function detectRerankTier(opts?: { force?: boolean }): Promise<RerankTierDetection> {
  if (opts?.force) _tierCache = null;
  if (_tierCache) return Promise.resolve(_tierCache);
  if (_tierInFlight) return _tierInFlight;

  const run = runTierDetection()
    .then((detection) => {
      _tierCache = detection;
      logger.log(
        `[Rerank] Tier: ${detection.tier} (${rerankTierLabel(detection.tier)}) — ${detection.reason}`,
      );
      return detection;
    })
    .finally(() => {
      _tierInFlight = null;
    });
  _tierInFlight = run;
  return run;
}

function probeRow(
  tier: RerankTier,
  model: string,
  available: boolean,
  detail: string,
  extra?: { httpStatus?: number; latencyMs?: number },
): RerankTierProbe {
  return {
    tier,
    label: rerankTierLabel(tier),
    model,
    available,
    detail,
    ...(extra?.httpStatus !== undefined ? { httpStatus: extra.httpStatus } : {}),
    ...(extra?.latencyMs !== undefined ? { latencyMs: extra.latencyMs } : {}),
  };
}

async function runTierDetection(): Promise<RerankTierDetection> {
  const probes: RerankTierProbe[] = [];
  const nativeModel = getRerankModelTag();
  const qwenModel = getRerankQwenModelTag();
  const detectedAt = Date.now();

  // `isOllamaRunning` already returns the version string — reuse it for the
  // logprobs gate instead of a second /api/version round-trip.
  const health = await isOllamaRunning();
  if (!health.running) {
    const detail = 'Ollama is not reachable';
    probes.push(probeRow('native', nativeModel, false, detail));
    probes.push(probeRow('qwen_graded', qwenModel, false, detail));
    probes.push(probeRow('embed_fallback', '', false, detail));
    return {
      tier: 'embed_fallback',
      model: '',
      ollamaUp: false,
      ollamaVersion: null,
      reason: detail,
      probes,
      detectedAt,
    };
  }

  const version = health.version;

  // Tier 1 — native /api/rerank.
  const native = await probeNativeRerank(nativeModel);
  probes.push(native);
  if (native.available) {
    return {
      tier: 'native',
      model: nativeModel,
      ollamaUp: true,
      ollamaVersion: version,
      reason: `POST /api/rerank answered with ${nativeModel}`,
      probes,
      detectedAt,
    };
  }

  // Tier 2 — Qwen3-Reranker through /api/generate.
  const installedTags = await listInstalledTags();
  const qwenInstalled = isRerankModelInstalled([], installedTags, qwenModel);
  if (qwenInstalled) {
    const graded = versionAtLeast(version, LOGPROBS_MIN_VERSION);
    const tier: RerankTier = graded ? 'qwen_graded' : 'qwen_binary';
    const reason = graded
      ? `Ollama v${version} supports top_logprobs — scoring P(yes) vs P(no) with ${qwenModel}`
      : `Ollama v${version ?? 'unknown'} predates v${LOGPROBS_MIN_VERSION}, so ${qwenModel} can only answer yes/no`;
    probes.push(probeRow(tier, qwenModel, true, reason));
    return {
      tier,
      model: qwenModel,
      ollamaUp: true,
      ollamaVersion: version,
      reason,
      probes,
      detectedAt,
    };
  }
  probes.push(probeRow('qwen_graded', qwenModel, false, `${qwenModel} is not installed`));

  // Tier 3 — cosine, applied by the IPC caller against arctic-embed2.
  const reason = `Neither /api/rerank nor ${qwenModel} is available`;
  probes.push(probeRow('embed_fallback', '', true, 'arctic-embed2 cosine similarity'));
  return {
    tier: 'embed_fallback',
    model: '',
    ollamaUp: true,
    ollamaVersion: version,
    reason,
    probes,
    detectedAt,
  };
}

/** Three-document probe of POST /api/rerank. Cheap enough to run once per session. */
async function probeNativeRerank(model: string): Promise<RerankTierProbe> {
  const baseUrl = resolveBaseUrl();
  const t0 = Date.now();
  try {
    const res = await fetchWithTimeout(
      `${baseUrl}/api/rerank`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          query: 'cozy roguelike with great pixel art',
          documents: [
            'Hades — fast action roguelike with greek mythology',
            'Stardew Valley — cozy farming sim',
            'Doom Eternal — fast shooter',
          ],
          top_n: 3,
        }),
      },
      NATIVE_PROBE_TIMEOUT_MS,
    );
    const latencyMs = Date.now() - t0;
    if (!res.ok) {
      let body = '';
      try {
        body = (await res.text()).slice(0, 200);
      } catch {
        body = '';
      }
      return probeRow(
        'native',
        model,
        false,
        res.status === 404
          ? `/api/rerank returned 404 — endpoint or model missing${body ? `: ${body}` : ''}`
          : `/api/rerank returned HTTP ${res.status}${body ? `: ${body}` : ''}`,
        { httpStatus: res.status, latencyMs },
      );
    }
    const data = (await res.json()) as {
      results?: Array<{ index?: number; relevance_score?: number; score?: number }>;
    };
    const rows = normalizeOllamaRerankRows(data.results, 3);
    if (!rows?.length) {
      return probeRow('native', model, false, '/api/rerank returned no usable rows', {
        httpStatus: res.status,
        latencyMs,
      });
    }
    return probeRow('native', model, true, `/api/rerank scored 3 documents`, {
      httpStatus: res.status,
      latencyMs,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return probeRow('native', model, false, `/api/rerank probe failed: ${message}`, {
      latencyMs: Date.now() - t0,
    });
  }
}

async function listInstalledTags(): Promise<string[]> {
  const baseUrl = resolveBaseUrl();
  try {
    const res = await fetchWithTimeout(`${baseUrl}/api/tags`, {}, TAGS_TIMEOUT_MS);
    if (!res.ok) return [];
    const data = (await res.json()) as { models?: Array<{ name?: string }> };
    return (data.models || []).map((m) => m.name || '').filter(Boolean);
  } catch {
    return [];
  }
}

// ─── Qwen3 scoring ──────────────────────────────────────────────────────────

const QWEN_SYSTEM_PROMPT =
  'Judge whether the Document meets the requirements based on the Query and the Instruct provided. Note that the answer can only be "yes" or "no".';
const QWEN_DEFAULT_INSTRUCTION =
  'Given a player taste profile, retrieve games that the player would enjoy.';

/**
 * Qwen3-Reranker's own chat template, sent with `raw: true`.
 *
 * The trailing empty `<think></think>` block matters: without it the model emits
 * a reasoning token first, and `num_predict: 1` would capture that instead of
 * the yes/no decision we score.
 */
function buildQwenPrompt(instruction: string, query: string, doc: string): string {
  return (
    `<|im_start|>system\n${QWEN_SYSTEM_PROMPT}<|im_end|>\n` +
    `<|im_start|>user\n<Instruct>: ${instruction}\n<Query>: ${query}\n<Document>: ${doc}<|im_end|>\n` +
    `<|im_start|>assistant\n<think>\n\n</think>\n\n`
  );
}

interface OllamaGenerateResponse {
  response?: string;
  logprobs?: Array<{
    token?: string;
    logprob?: number;
    top_logprobs?: Array<{ token?: string; logprob?: number }>;
  }>;
}

/**
 * Strip tokenizer prefixes so " yes", "▁Yes" and "yes" all compare equal —
 * SentencePiece and BPE tokenizers commonly emit the leading-space variant.
 */
function normalizeToken(raw: string): string {
  return raw.replace(/^[\s\u2581\u0120]+/, '').trim().toLowerCase();
}

/**
 * Softmax over just the yes and no logprobs. Returns null when neither token is
 * in the top-k, which sends the caller to the binary path for that document.
 *
 * A token outside the returned top-k is by definition less likely than every
 * token inside it, so treating a missing counterpart as ~0 probability is a
 * sound bound rather than a guess.
 */
export function scoreFromTopLogprobs(
  top: Array<{ token?: string; logprob?: number }> | undefined,
): number | null {
  if (!Array.isArray(top) || top.length === 0) return null;
  let pYes = 0;
  let pNo = 0;
  for (const entry of top) {
    if (typeof entry?.token !== 'string' || typeof entry.logprob !== 'number') continue;
    if (!Number.isFinite(entry.logprob)) continue;
    const token = normalizeToken(entry.token);
    if (token === 'yes') pYes += Math.exp(entry.logprob);
    else if (token === 'no') pNo += Math.exp(entry.logprob);
  }
  const denom = pYes + pNo;
  if (!(denom > 0)) return null;
  return pYes / denom;
}

/** Read the single generated token as a hard yes/no. Used when logprobs are absent. */
export function scoreFromBinaryToken(text: string | undefined): number | null {
  const token = normalizeToken(text ?? '');
  if (!token) return null;
  if (token.startsWith('yes')) return 1;
  if (token.startsWith('no')) return 0;
  return null;
}

export interface QwenScoreOptions {
  /** Qwen3-Reranker tag to call. */
  model: string;
  /** False forces the binary path (Ollama build predates logprobs support). */
  graded: boolean;
  /** Total wall-clock ceiling for the whole pass. Defaults to a per-document budget. */
  budgetMs?: number;
  /** Polled between documents — true adds a politeness pause for the foreground app. */
  isBackground?: () => boolean;
  /** Task instruction folded into the prompt. */
  instruction?: string;
}

export interface QwenScoreResult {
  rows: RerankResultRow[];
  /** What actually happened, not what was requested. */
  tier: 'qwen_graded' | 'qwen_binary';
  scored: number;
  requested: number;
  /** True when the latency ceiling cut the pass short. */
  truncated: boolean;
  elapsedMs: number;
}

/**
 * Score every document against the query with one /api/generate call each.
 *
 * Strictly sequential — 100 concurrent generate calls would stall the machine,
 * and Ollama serializes them anyway. Returns null when too few documents could
 * be scored to be worth using, which is the caller's signal to fall back to
 * cosine rather than serve a half-ranked shelf.
 */
export async function scoreWithQwen3(
  query: string,
  documents: string[],
  opts: QwenScoreOptions,
): Promise<QwenScoreResult | null> {
  if (documents.length === 0) return null;

  const baseUrl = resolveBaseUrl();
  const instruction = opts.instruction?.trim() || QWEN_DEFAULT_INSTRUCTION;
  const budgetMs =
    opts.budgetMs ?? QWEN_BUDGET_BASE_MS + documents.length * QWEN_BUDGET_PER_DOC_MS;
  const startedAt = Date.now();

  let graded = opts.graded;
  let sawLogprobs = false;
  let truncated = false;
  const rows: RerankResultRow[] = [];

  for (let i = 0; i < documents.length; i++) {
    if (Date.now() - startedAt > budgetMs) {
      truncated = true;
      break;
    }

    const doc = (documents[i] ?? '').slice(0, QWEN_DOC_MAX_CHARS);
    const data = await generateOnce(baseUrl, opts.model, buildQwenPrompt(instruction, query, doc), graded);
    if (!data) continue;

    const top = data.logprobs?.[0]?.top_logprobs;
    let score: number | null = null;
    if (Array.isArray(top) && top.length > 0) {
      sawLogprobs = true;
      score = scoreFromTopLogprobs(top);
    } else if (graded) {
      // The build advertised a new-enough version but returned no logprobs.
      // Stop claiming graded scores for the rest of this pass and for the
      // cached tier, so the UI reports qwen_binary honestly.
      graded = false;
      logger.warn(
        '[Rerank] /api/generate returned no logprobs — downgrading this session to qwen_binary',
      );
      downgradeCachedTierToBinary();
    }
    if (score === null) score = scoreFromBinaryToken(data.response);
    if (score === null) continue;

    rows.push({ index: i, relevance_score: score });

    if (i + 1 < documents.length && opts.isBackground?.()) {
      await sleep(QWEN_BG_COOLDOWN_MS);
    }
  }

  const elapsedMs = Date.now() - startedAt;
  const minUseful = Math.min(
    documents.length,
    Math.max(QWEN_MIN_USEFUL_DOCS, Math.ceil(documents.length * QWEN_MIN_USEFUL_FRACTION)),
  );
  if (rows.length < minUseful) {
    logger.warn(
      `[Rerank] Qwen3 pass abandoned — scored ${rows.length}/${documents.length} in ${elapsedMs}ms (needed ${minUseful})`,
    );
    return null;
  }

  rows.sort((a, b) => b.relevance_score - a.relevance_score);
  const tier: 'qwen_graded' | 'qwen_binary' = graded && sawLogprobs ? 'qwen_graded' : 'qwen_binary';
  logger.log(
    `[Rerank] Qwen3 ${tier}: scored ${rows.length}/${documents.length} in ${elapsedMs}ms${truncated ? ' (latency ceiling hit)' : ''}`,
  );
  return { rows, tier, scored: rows.length, requested: documents.length, truncated, elapsedMs };
}

function downgradeCachedTierToBinary(): void {
  if (_tierCache && _tierCache.tier === 'qwen_graded') {
    _tierCache = {
      ..._tierCache,
      tier: 'qwen_binary',
      reason: `Ollama reported v${_tierCache.ollamaVersion ?? 'unknown'} but returned no logprobs — yes/no only`,
    };
  }
}

async function generateOnce(
  baseUrl: string,
  model: string,
  prompt: string,
  graded: boolean,
): Promise<OllamaGenerateResponse | null> {
  const body: Record<string, unknown> = {
    model,
    prompt,
    stream: false,
    // Bypass Ollama's own template — buildQwenPrompt already supplies the
    // reranker's chat template including the assistant prefix.
    raw: true,
    // Pin the model so 100 sequential calls don't each pay a reload.
    keep_alive: -1,
    options: { num_predict: 1, temperature: 0 },
  };
  if (graded) {
    body.logprobs = true;
    body.top_logprobs = 20;
  }

  try {
    const res = await fetchWithTimeout(
      `${baseUrl}/api/generate`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
      QWEN_DOC_TIMEOUT_MS,
    );
    if (!res.ok) {
      logger.warn(`[Rerank] /api/generate HTTP ${res.status} for ${model}`);
      return null;
    }
    return (await res.json()) as OllamaGenerateResponse;
  } catch (err) {
    logger.warn('[Rerank] /api/generate failed:', err);
    return null;
  }
}
