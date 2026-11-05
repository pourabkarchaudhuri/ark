/** 1.0.99: a write that fails (disk full) must not leave its partial .tmp behind. */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import realFs from 'node:fs';

let failWrites = true;
vi.mock('fs', async (orig) => {
  const actual = await orig<typeof import('fs')>();
  const boom = () => Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC', syscall: 'write' });
  const patched = {
    ...actual,
    writeFileSync: ((p: string, d: string, e: string) => {
      if (!failWrites) return actual.writeFileSync(p, d, e as BufferEncoding);
      actual.appendFileSync(p, 'par');
      throw boom();
    }) as typeof actual.writeFileSync,
    writeFile: ((p: string, d: string, e: string, cb: (err: Error | null) => void) => {
      if (!failWrites) return actual.writeFile(p, d, e as BufferEncoding, cb);
      actual.appendFileSync(p, 'par');
      cb(boom());
    }) as unknown as typeof actual.writeFile,
  };
  return { ...patched, default: patched };
});

import { atomicWriteFileSync, atomicWriteFile } from '../../../electron/safe-write';

let dir: string;
beforeEach(() => { failWrites = true; dir = realFs.mkdtempSync(path.join(os.tmpdir(), 'ark-sw-')); });
afterEach(() => realFs.rmSync(dir, { recursive: true, force: true }));

describe('safe-write orphans', () => {
  it('sync: a failed write leaves no .tmp', () => {
    expect(() => atomicWriteFileSync(path.join(dir, 's.json'), 'data')).toThrow(/ENOSPC/);
    expect(realFs.readdirSync(dir)).toEqual([]);
  });
  it('async: a failed write leaves no .tmp', async () => {
    const err = await new Promise<NodeJS.ErrnoException | null>((r) => atomicWriteFile(path.join(dir, 'a.json'), 'data', r));
    await new Promise((r) => setTimeout(r, 50));
    expect(err?.code).toBe('ENOSPC');
    expect(realFs.readdirSync(dir)).toEqual([]);
  });
});
