import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * 1.0.99: app.exit() skips before-quit, so every app.exit path that ends a running Ark (fatal startup error,
 * "Restart Ark" after a renderer crash) must stop the built-in AI servers and the router sidecar itself.
 */
const src = fs.readFileSync(path.resolve(__dirname, '../../../electron/main.ts'), 'utf8');

describe('main.ts exit paths stop the child servers', () => {
  it('the packaged fatal-startup handler shuts down local AI and the router before app.exit(1)', () => {
    const i = src.indexOf('app.exit(1)');
    expect(i).toBeGreaterThan(0);
    const before = src.slice(Math.max(0, i - 400), i);
    expect(before).toContain('shutdownLocalAi()');
    expect(before).toContain('shutdownAiRouter()');
  });

  it('the renderer-recovery restart exit shuts them down before app.exit(code)', () => {
    const i = src.indexOf('app.exit(code)');
    expect(i).toBeGreaterThan(0);
    const before = src.slice(Math.max(0, i - 400), i);
    expect(before).toContain('shutdownLocalAi()');
    expect(before).toContain('shutdownAiRouter()');
  });
});
