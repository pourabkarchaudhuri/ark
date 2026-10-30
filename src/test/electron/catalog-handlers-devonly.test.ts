/**
 * Full-catalog crawl is developer-only (1.0.97 B01): packaged builds do not register the IPC
 * channel, and the output folder moves to userData when packaged. The CLI export stays callable.
 */
import { describe, it, expect, vi } from 'vitest';
import path from 'node:path';

vi.mock('../../../electron/safe-logger.js', () => ({
  logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../../../electron/steam-api.js', () => ({ steamAPI: {} }));
vi.mock('../../../electron/epic-api.js', () => ({ epicAPI: {} }));
vi.mock('../../../electron/egdata-api.js', () => ({ egdataAPI: {} }));

import {
  register,
  getDocsDir,
  runFullCatalogAdultFilterTest,
  __setCatalogHandlerDepsForTests,
} from '../../../electron/ipc/catalog-handlers';

describe('catalog handlers', () => {
  it('registers nothing when packaged', () => {
    const handle = vi.fn();
    __setCatalogHandlerDepsForTests({ isPackaged: () => true, handle });
    register();
    expect(handle).not.toHaveBeenCalled();
  });

  it('registers the crawl channel in a dev run', () => {
    const handle = vi.fn();
    __setCatalogHandlerDepsForTests({ isPackaged: () => false, handle });
    register();
    expect(handle).toHaveBeenCalledWith('catalog:runFullCatalogAdultFilterTest', expect.any(Function));
  });

  it('writes to userData/docs when packaged and to the repo docs/ in dev', () => {
    __setCatalogHandlerDepsForTests({ isPackaged: () => true, userDataDir: () => path.join('U', 'Ark'), cwd: () => 'INSTALL' });
    expect(getDocsDir()).toBe(path.join('U', 'Ark', 'docs'));
    __setCatalogHandlerDepsForTests({ isPackaged: () => false, cwd: () => 'REPO' });
    expect(getDocsDir()).toBe(path.join('REPO', 'docs'));
  });

  it('keeps the function exported for the --run-adult-filter-test CLI path', () => {
    expect(typeof runFullCatalogAdultFilterTest).toBe('function');
  });
});
