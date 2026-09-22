import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { createQueryClient } from '@/app/queryClient';
import { ScoringPanel } from '@/features/assessment-builder/components/ScoringPanel';
import { builderApi } from '@/services/builderApi';
import type { BuilderDimension, VersionReview } from '@/types/builder';

vi.mock('@/services/builderApi');

const DIMENSIONS: BuilderDimension[] = [
  { code: 'SE', name: 'Self-Efficacy', description: null },
  { code: 'OE', name: 'Outcome Expectations', description: null },
  { code: 'GO', name: 'Goal Orientation', description: null },
];

function review(status: VersionReview['status']): VersionReview {
  return {
    id: 'vv000000-0000-4000-8000-000000000001',
    version_number: 2,
    status,
    instructions: null,
    duration_minutes: null,
    scoring_algorithm: 'WEIGHTED_COMPOSITE',
    composite_weights: { SE: 0.4, OE: 0.3, GO: 0.3 },
    composite_ranges: [
      { min: 50, max: 100, label: 'High' },
      { min: 0, max: 50, label: 'Low' },
    ],
    created_at: '2026-09-22T00:00:00Z',
    published_at: null,
    template: { id: 't1', title: 'SCCT', category: 'SCCT' },
    publish_readiness: { total: 0, confirmed: 0, remaining: 0 },
    questions: [],
  };
}

function renderPanel(
  status: VersionReview['status'],
  editable: boolean,
  overrides: Partial<VersionReview> = {},
) {
  return render(
    <QueryClientProvider client={createQueryClient()}>
      <ScoringPanel
        review={{ ...review(status), ...overrides }}
        dimensions={DIMENSIONS}
        editable={editable}
      />
    </QueryClientProvider>,
  );
}

describe('ScoringPanel', () => {
  it('shows stored fractions as percentages and a worked example', () => {
    renderPanel('DRAFT', true);

    expect(screen.getByLabelText(/Self-Efficacy/)).toHaveValue(40);
    expect(screen.getByText('Total 100%')).toBeInTheDocument();
    expect(screen.getByTestId('scoring-example')).toHaveTextContent('gets 65 (High)');
  });

  it('flags a total that is not 100%, blocks saving, and balances it back', async () => {
    const user = userEvent.setup();

    renderPanel('DRAFT', true);

    const se = screen.getByLabelText(/Self-Efficacy/);

    await user.clear(se);
    await user.type(se, '60');

    expect(screen.getByText(/must add up to 100%/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save weights' })).toBeDisabled();

    await user.click(screen.getByRole('button', { name: /Balance to 100%/ }));

    expect(screen.getByText('Total 100%')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save weights' })).toBeEnabled();
  });

  it('saves fractions, not percentages', async () => {
    const user = userEvent.setup();

    vi.mocked(builderApi.updateScoringConfig).mockResolvedValue(review('DRAFT'));
    renderPanel('DRAFT', true);

    await user.click(screen.getByRole('button', { name: 'Save weights' }));

    await waitFor(() =>
      expect(builderApi.updateScoringConfig).toHaveBeenCalledWith(
        'vv000000-0000-4000-8000-000000000001',
        expect.objectContaining({ composite_weights: { SE: 0.4, OE: 0.3, GO: 0.3 } }),
      ),
    );
  });

  it('is read-only on a published version and points to Duplicate', () => {
    renderPanel('PUBLISHED', false);

    expect(screen.getByLabelText(/Self-Efficacy/)).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Save weights' })).not.toBeInTheDocument();
    expect(screen.getByText(/Duplicate this version to change its weights/)).toBeInTheDocument();
  });

  it('says how many students were scored under this version, and stays quiet at zero', () => {
    const { unmount } = renderPanel('PUBLISHED', false, { scored_student_count: 12 });

    expect(screen.getByTestId('scored-count')).toHaveTextContent(
      "12 students were scored under v2's weights",
    );
    unmount();

    renderPanel('DRAFT', true, { scored_student_count: 0 });
    expect(screen.queryByTestId('scored-count')).not.toBeInTheDocument();
  });
});
