import { describe, it, expect } from 'vitest';
import path from 'path';

/**
 * Standalone validation logic extracted from IPC handlers.
 * These mirror the validation patterns used in:
 * - steam-handlers.ts (batch array capping)
 * - ai-handlers.ts (message length)
 * - webview-handlers.ts (URL scheme)
 * - session-handlers.ts (executable path)
 * - settings-handlers.ts (Ollama URL)
 */

const MAX_BATCH = 200;
const MAX_MSG_LEN = 4000;

function isValidWebviewUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function isValidExecutablePath(p: string): boolean {
  if (!p || typeof p !== 'string') return false;
  const isAbsolute = path.isAbsolute(p);
  const isExe = p.toLowerCase().endsWith('.exe');
  return isAbsolute && isExe;
}

function isMessageLengthValid(message: unknown): boolean {
  return typeof message === 'string' && message.length <= MAX_MSG_LEN;
}

function capBatchArray<T>(arr: T[]): T[] {
  return Array.isArray(arr) ? arr.slice(0, MAX_BATCH) : [];
}

function isValidOllamaUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

describe('URL scheme validation (webview)', () => {
  it('accepts http and https URLs', () => {
    expect(isValidWebviewUrl('https://example.com')).toBe(true);
    expect(isValidWebviewUrl('http://example.com/path')).toBe(true);
    expect(isValidWebviewUrl('https://sub.example.com:443/page')).toBe(true);
  });

  it('rejects javascript: scheme', () => {
    expect(isValidWebviewUrl('javascript:alert(1)')).toBe(false);
  });

  it('rejects file: scheme', () => {
    expect(isValidWebviewUrl('file:///C:/Users/test/file.html')).toBe(false);
  });

  it('rejects data: scheme', () => {
    expect(isValidWebviewUrl('data:text/html,<script>alert(1)</script>')).toBe(false);
  });

  it('rejects ftp: scheme', () => {
    expect(isValidWebviewUrl('ftp://files.example.com')).toBe(false);
  });

  it('rejects invalid URLs', () => {
    expect(isValidWebviewUrl('not a url')).toBe(false);
    expect(isValidWebviewUrl('')).toBe(false);
  });
});

describe('Executable path validation (session)', () => {
  it('accepts absolute paths ending with .exe', () => {
    expect(isValidExecutablePath('C:\\Games\\game.exe')).toBe(true);
    expect(isValidExecutablePath('D:/Steam/steamapps/common/game.exe')).toBe(true);
    expect(isValidExecutablePath('C:\\Program Files\\App\\App.EXE')).toBe(true);
  });

  it('rejects relative paths', () => {
    expect(isValidExecutablePath('./game.exe')).toBe(false);
    expect(isValidExecutablePath('game.exe')).toBe(false);
    expect(isValidExecutablePath('../parent/game.exe')).toBe(false);
  });

  it('rejects non-exe files', () => {
    expect(isValidExecutablePath('C:\\Games\\game.bat')).toBe(false);
    expect(isValidExecutablePath('C:\\Games\\game')).toBe(false);
    expect(isValidExecutablePath('C:\\Games\\game.exe.bak')).toBe(false);
  });

  it('rejects empty string', () => {
    expect(isValidExecutablePath('')).toBe(false);
  });
});

describe('AI message length validation', () => {
  it('accepts messages up to 4000 chars', () => {
    expect(isMessageLengthValid('')).toBe(true);
    expect(isMessageLengthValid('a'.repeat(4000))).toBe(true);
  });

  it('rejects messages over 4000 chars', () => {
    expect(isMessageLengthValid('a'.repeat(4001))).toBe(false);
    expect(isMessageLengthValid('x'.repeat(10000))).toBe(false);
  });

  it('rejects non-string input', () => {
    expect(isMessageLengthValid(null)).toBe(false);
    expect(isMessageLengthValid(123)).toBe(false);
    expect(isMessageLengthValid({ message: 'hello' })).toBe(false);
  });
});

describe('Batch array size capping', () => {
  it('caps arrays over 200 to 200 items', () => {
    const arr = Array.from({ length: 500 }, (_, i) => i);
    const capped = capBatchArray(arr);
    expect(capped).toHaveLength(200);
    expect(capped[0]).toBe(0);
    expect(capped[199]).toBe(199);
  });

  it('leaves arrays under 200 unchanged', () => {
    const arr = [1, 2, 3, 4, 5];
    expect(capBatchArray(arr)).toEqual([1, 2, 3, 4, 5]);
    expect(capBatchArray(Array.from({ length: 200 }, (_, i) => i))).toHaveLength(200);
  });

  it('returns empty array for non-array input', () => {
    expect(capBatchArray(null as unknown as number[])).toEqual([]);
    expect(capBatchArray(undefined as unknown as number[])).toEqual([]);
    expect(capBatchArray('not array' as unknown as number[])).toEqual([]);
  });
});

describe('Ollama URL validation', () => {
  it('accepts http and https URLs', () => {
    expect(isValidOllamaUrl('http://localhost:11434')).toBe(true);
    expect(isValidOllamaUrl('https://ollama.example.com')).toBe(true);
    expect(isValidOllamaUrl('http://127.0.0.1:11434')).toBe(true);
  });

  it('does NOT block localhost', () => {
    expect(isValidOllamaUrl('http://localhost:11434')).toBe(true);
    expect(isValidOllamaUrl('http://127.0.0.1:11434')).toBe(true);
  });

  it('rejects other schemes', () => {
    expect(isValidOllamaUrl('javascript:alert(1)')).toBe(false);
    expect(isValidOllamaUrl('file:///local')).toBe(false);
    expect(isValidOllamaUrl('ftp://ollama.example.com')).toBe(false);
  });

  it('rejects invalid URLs', () => {
    expect(isValidOllamaUrl('')).toBe(false);
    expect(isValidOllamaUrl('not a url')).toBe(false);
  });
});
