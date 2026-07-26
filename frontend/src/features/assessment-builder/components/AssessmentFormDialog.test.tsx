import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createQueryClient } from '@/app/queryClient';
import { AssessmentFormDialog } from '@/features/assessment-builder/components/AssessmentFormDialog';
import { assessmentAdminApi } from '@/services/assessmentAdminApi';
import type { AssessmentRow, AssessmentScoring, AssessmentType } from '@/types/assessmentAdmin';

vi.mock('@/services/assessmentAdminApi');

/**
 * The dynamic scoring rule, from the client's side (backend migration 0014).
 *
 * The server enforces the same matrix — `test/assessment/taxonomy.test.ts` covers that — so what is
 * under test here is the *other* half of the promise: that the form narrows its options to the
 * chosen type, and re-narrows when the type changes, so the administrator is never offered a
 * combination the server is about to refuse. A filter that merely *looked* right while sending
 * whatever was selected would pass a server-side test and fail a user.
 */

const INTEREST_ONLY = 'sc000000-0000-4000-8000-000000000002'; // Likert — Interest and Personality.
const ACADEMIC_ONLY = 'sc000000-0000-4000-8000-000000000003'; // Percentage — Academic alone.

const SCORINGS: AssessmentScoring[] = [
  {
    id: INTEREST_ONLY,
    code: 'LIKERT_SCALES',
    name: 'Likert Scales',
    description: null,
    order_number: 1,
  },
  {
    id: ACADEMIC_ONLY,
    code: 'PERCENTAGE_SCORES',
    name: 'Percentage Scores',
    description: null,
    order_number: 3,
  },
];

const TYPES: AssessmentType[] = [
  {
    id: 'ty000000-0000-4000-8000-000000000002',
    code: 'ACADEMIC',
    name: 'Academic',
    description: 'Measures attainment in a subject.',
    order_number: 2,
    allowed_scoring_ids: [INTEREST_ONLY, ACADEMIC_ONLY],
  },
  {
    id: 'ty000000-0000-4000-8000-000000000004',
    code: 'INTEREST',
    name: 'Interest',
    description: 'Measures preference for activities.',
    order_number: 4,
    allowed_scoring_ids: [INTEREST_ONLY],
  },
];

function row(overrides: Partial<AssessmentRow> = {}): AssessmentRow {
  return {
    id: 'aa000000-0000-4000-8000-000000000001',
    title: 'Study Habits Survey',
    description: null,
    category: 'CUSTOM',
    ownership: 'GLOBAL',
    status: 'DRAFT',
    is_published: false,
    is_archived: false,
    type: { id: TYPES[0]!.id, code: 'ACADEMIC', name: 'Academic' },
    scorings: [{ id: ACADEMIC_ONLY, code: 'PERCENTAGE_SCORES', name: 'Percentage Scores' }],
    versions: [],
    published_version: null,
    assignment: { scope: null, class_count: 0 },
    ai_generatable: true,
    created_at: '2026-07-26T00:00:00.000Z',
    updated_at: '2026-07-26T00:00:00.000Z',
    ...overrides,
  };
}

function renderDialog(props: Partial<React.ComponentProps<typeof AssessmentFormDialog>> = {}) {
  const onSave = vi.fn().mockResolvedValue(row());
  const onClose = vi.fn();

  render(
    <QueryClientProvider client={createQueryClient()}>
      <AssessmentFormDialog
        open
        row={null}
        onClose={onClose}
        onSave={onSave}
        isSaving={false}
        {...props}
      />
    </QueryClientProvider>,
  );

  return { onSave, onClose, user: userEvent.setup() };
}

/** Open the type combobox and choose one by its visible name. */
async function chooseType(user: ReturnType<typeof userEvent.setup>, name: string) {
  await user.click(screen.getByLabelText(/assessment type/i));
  await user.click(await screen.findByRole('option', { name }));
}

async function openScorings(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByLabelText(/type of scoring/i));
}

describe('AssessmentFormDialog', () => {
  beforeEach(() => {
    vi.mocked(assessmentAdminApi.listTypes).mockResolvedValue(TYPES);
    vi.mocked(assessmentAdminApi.listScorings).mockResolvedValue(SCORINGS);
  });

  it('offers no scoring methods until a type is chosen', async () => {
    renderDialog();

    await waitFor(() => expect(assessmentAdminApi.listTypes).toHaveBeenCalled());

    // Disabled, with the reason spelled out rather than an inert control the user has to poke at.
    expect(screen.getByLabelText(/type of scoring/i)).toBeDisabled();
    expect(screen.getByText(/choose an assessment type first/i)).toBeInTheDocument();
  });

  it('offers only the methods the chosen type allows', async () => {
    const { user } = renderDialog();

    await chooseType(user, 'Interest');
    await openScorings(user);

    expect(await screen.findByRole('option', { name: /likert scales/i })).toBeInTheDocument();
    // Percentage Scores is legal for Academic and not for Interest — it must not be offered here.
    expect(screen.queryByRole('option', { name: /percentage scores/i })).not.toBeInTheDocument();
  });

  /**
   * The rule that makes the filter trustworthy rather than decorative: switching the type must take
   * the now-illegal selection *with* it. Leaving it selected would hand the server a combination it
   * is about to refuse, and explaining that after a failed save is worse than showing it happen.
   */
  it('drops a selected method when the type changes to one that forbids it', async () => {
    const { user, onSave } = renderDialog({ row: row() });

    await waitFor(() => expect(assessmentAdminApi.listScorings).toHaveBeenCalled());

    // Seeded from the row: Academic + Percentage Scores, a legal pair.
    expect(await screen.findByText('Percentage Scores')).toBeInTheDocument();

    await chooseType(user, 'Interest');

    await waitFor(() => {
      expect(screen.queryByText('Percentage Scores')).not.toBeInTheDocument();
    });

    // And the form now refuses to save rather than sending an empty set.
    await user.click(screen.getByRole('button', { name: /save changes/i }));

    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getByText(/at least one scoring method/i)).toBeInTheDocument();
  });

  it('submits the title, the type and every chosen method', async () => {
    const { user, onSave } = renderDialog();

    await user.type(screen.getByLabelText(/^title$/i), 'Study Habits Survey');
    await chooseType(user, 'Academic');
    await openScorings(user);
    await user.click(await screen.findByRole('option', { name: /likert scales/i }));
    await user.click(screen.getByRole('option', { name: /percentage scores/i }));
    await user.click(screen.getByRole('button', { name: /create assessment/i }));

    await waitFor(() => {
      expect(onSave).toHaveBeenCalledWith({
        title: 'Study Habits Survey',
        description: null,
        assessment_type_id: TYPES[0]!.id,
        scoring_ids: [INTEREST_ONLY, ACADEMIC_ONLY],
      });
    });
  });

  it('requires a title and a type before it will save', async () => {
    const { user, onSave } = renderDialog();

    await user.click(screen.getByRole('button', { name: /create assessment/i }));

    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getByText(/a title is required/i)).toBeInTheDocument();
    // Exact, not a substring: the disabled scoring control also says "Choose an assessment type
    // first", and matching both would let this pass with the field error missing.
    expect(screen.getByText('Choose an assessment type.')).toBeInTheDocument();
  });
});
