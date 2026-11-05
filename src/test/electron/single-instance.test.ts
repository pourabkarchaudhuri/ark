import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { isLosingInstance } from '../../../electron/single-instance';

describe('isLosingInstance', () => {
  it('is true only when the lock was lost and this is not the chat-prompts runner', () => {
    expect(isLosingInstance(false, false)).toBe(true);
    expect(isLosingInstance(true, false)).toBe(false);
    expect(isLosingInstance(false, true)).toBe(false);
    expect(isLosingInstance(true, true)).toBe(false);
  });

  it('main.ts gates ready, before-quit and will-quit on it', () => {
    const src = readFileSync('electron/main.ts', 'utf8');
    expect(src).toMatch(/whenReady\(\)\.then\(async \(\) => \{\s*(\/\/[^\n]*\n\s*)*if \(losingInstance\) return;/);
    expect(src).toMatch(/app\.on\('before-quit', \(\) => \{\s*if \(losingInstance\) return;/);
    expect(src).toMatch(/app\.on\('will-quit', \(event: any\) => \{\s*if \(losingInstance/);
  });
});
