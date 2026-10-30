/**
 * 1.0.97 B14: the AI chat panel (markdown + emoji-mart) stays out of the Dashboard chunk.
 * Source-level check: no static import of the panel from the dashboard, and no static import of
 * emoji-mart from the panel (both must be dynamic `import()` so Vite splits them).
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';

const root = path.resolve(__dirname, '../../..');
const read = (rel: string) => readFileSync(path.join(root, rel), 'utf-8');

describe('AI chat lazy loading', () => {
  it('dashboard loads the chat panel lazily, gated on first open', () => {
    const src = read('src/pages/dashboard.tsx');
    expect(src).not.toMatch(/^import[^;]*from '@\/components\/ai-chat-panel'/m);
    expect(src).toMatch(/lazy\(\(\) => import\('@\/components\/ai-chat-panel'\)/);
    expect(src).toMatch(/hasOpenedChatRef\.current && \(\s*<Suspense/);
  });

  it('chat panel imports emoji-mart only dynamically', () => {
    const src = read('src/components/ai-chat-panel.tsx');
    expect(src).not.toMatch(/^import[^;]*from '@emoji-mart\/(react|data)'/m);
    expect(src).toMatch(/import\('@emoji-mart\/react'\)/);
    expect(src).toMatch(/import\('@emoji-mart\/data'\)/);
  });
});
