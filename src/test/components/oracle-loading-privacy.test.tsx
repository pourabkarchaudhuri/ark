/**
 * Oracle loading overlay privacy note (oracle#24): scoring is local, but every compute sends
 * game ids to Steam (and gg.deals when configured), so the old "no data leaves your machine"
 * claim was false. The copy is fixed and does not depend on the gg.deals key.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

// The DNA spinner's styled wrapper does not load under jsdom; it is decoration only.
vi.mock('react-loader-spinner', () => ({ DNA: () => null }));
import { OracleLoadingOverlay, ORACLE_PRIVACY_NOTE } from '@/components/oracle-view';

describe('Oracle loading overlay privacy note', () => {
  it('says only game IDs go to Steam / gg.deals and never claims nothing leaves the machine', () => {
    render(
      <OracleLoadingOverlay
        stage=""
        percent={0}
        libraryCount={10}
        candidateCount={0}
        embeddingStatus="idle"
        embeddingProgress={null}
      />,
    );
    expect(ORACLE_PRIVACY_NOTE).toBe(
      'Scoring runs on your machine; only game IDs are sent to Steam (and gg.deals, if configured) for store data',
    );
    expect(screen.getByText(ORACLE_PRIVACY_NOTE)).toBeInTheDocument();
    expect(screen.queryByText(/no data leaves your machine/i)).toBeNull();
  });
});
