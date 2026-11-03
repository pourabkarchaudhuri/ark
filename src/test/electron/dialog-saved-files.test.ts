/**
 * "Show file" on the Settings export toast (1.0.97 B37): main reveals only files this session saved
 * through the save dialog, never an arbitrary path from the renderer.
 */
import { describe, it, expect, vi } from 'vitest';
vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() }, dialog: {}, shell: {}, app: {} }));
vi.mock('../../../electron/safe-logger.js', () => ({ logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { createSavedFileRegistry } from '../../../electron/ipc/dialog-handlers';

describe('createSavedFileRegistry', () => {
  it('knows only the files it was told about, and only strings', () => {
    const r = createSavedFileRegistry();
    r.add('C:\\Users\\me\\ark-library-2026-11-03.json');
    expect(r.has('C:\\Users\\me\\ark-library-2026-11-03.json')).toBe(true);
    expect(r.has('C:\\Windows\\system32\\cmd.exe')).toBe(false);
    expect(r.has(undefined)).toBe(false);
    expect(r.has({ toString: () => 'C:\\Users\\me\\ark-library-2026-11-03.json' })).toBe(false);
  });

  it('forgets the oldest file past its limit and keeps a re-saved one fresh', () => {
    const r = createSavedFileRegistry(2);
    r.add('a');
    r.add('b');
    r.add('a');
    r.add('c');
    expect(r.has('b')).toBe(false);
    expect(r.has('a')).toBe(true);
    expect(r.has('c')).toBe(true);
  });
});
