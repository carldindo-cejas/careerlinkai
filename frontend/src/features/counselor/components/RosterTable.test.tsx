import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createQueryClient } from '@/app/queryClient';
import { RosterTable } from '@/features/counselor/components/RosterTable';
import { counselorAssessmentApi } from '@/services/assessmentApi';
import { recommendationApi } from '@/services/recommendationApi';
import { rosterApi } from '@/services/rosterApi';
import { useToastStore } from '@/stores/toastStore';
import { ApiRequestError } from '@/types/api';
import type { AssessmentResult } from '@/types/assessment';
import type { Career, College, Program } from '@/types/catalog';
import type { RosterEntry } from '@/types/class';
import type {
  CareerRecommendation,
  ProgramRecommendation,
  RecommendationSet,
} from '@/types/recommendation';

vi.mock('@/services/rosterApi');
vi.mock('@/services/assessmentApi');
vi.mock('@/services/recommendationApi');

/**
 * The roster, and the per-student dropdown that replaced the class page's Results and
 * Recommendations panels.
 *
 * Carried over from those panels' tests, because the guarantees did not change when the UI moved:
 *
 *   1. **Nothing is fetched until a row is opened.** There is no bulk recommendations endpoint, so
 *      an eager roster would fire one request per enrolled student on page load.
 *   2. **`null` is not an error.** A rebuild that returns `null` means the student has not finished
 *      both instruments (audit C4).
 *   3. **A rebuilt set replaces the cards without a refetch.**
 *   4. **The §21 reset is still two-step** — it moved into the dropdown, it did not disappear.
 */

const CLASS_ID = '33333333-3333-4333-8333-333333333333';

function entry(username: string, firstName: string): RosterEntry {
  return {
    id: `enrollment-${username}`,
    class_id: CLASS_ID,
    student_id: `student-${username}`,
    username,
    status: 'active',
    joined_at: '2026-07-13T09:14:02+00:00',
    removed_at: null,
    first_name: firstName,
    last_name: 'Dela Cruz',
    assessments_assigned: 2,
    assessments_completed: 2,
    assessments_in_progress: 0,
  };
}

const ANA = entry('adelacruz', 'Ana');
const BEN = entry('bdelacruz', 'Ben');

function riasecResult(studentId: string, name: string, code: string): AssessmentResult {
  return {
    attempt_id: `riasec-${studentId}`,
    submitted_at: '2026-07-20T02:00:00Z',
    assessment: { title: 'RIASEC Interest Inventory', category: 'RIASEC' },
    student: { id: studentId, name, username: null },
    result: { result_code: code, overall_summary: null, generated_at: null },
    dimensions: [],
  };
}

function scctResult(studentId: string, name: string): AssessmentResult {
  return {
    attempt_id: `scct-${studentId}`,
    submitted_at: '2026-07-21T02:00:00Z',
    assessment: { title: 'SCCT Career Confidence', category: 'SCCT' },
    student: { id: studentId, name, username: null },
    result: {
      result_code: null,
      overall_summary: 'Moderate overall career confidence',
      generated_at: null,
    },
    dimensions: [
      {
        code: 'SE',
        name: 'Self-Efficacy',
        description: null,
        raw_score: '29',
        normalized_score: '72.50',
        interpretation: 'High Confidence',
      },
    ],
  };
}

const COLLEGE: College = {
  id: 'college-1',
  name: 'Alpha University',
  description: null,
  status: 'active',
  region: null,
  province: null,
  town: null,
  barangay: null,
  map_link: null,
  created_at: null,
  updated_at: null,
};

function career(id: string, title: string): Career {
  return {
    id,
    title,
    description: null,
    salary_min: null,
    salary_max: null,
    employment_outlook_id: null,
    employment_outlook: null,
    typical_riasec_code: 'IEC',
    status: 'active',
    created_at: null,
    updated_at: null,
  };
}

function program(id: string, name: string): Program {
  return {
    id,
    college_id: COLLEGE.id,
    code: 'BSCS',
    name,
    department_name: null,
    description: null,
    recommended_strand: null,
    status: 'active',
    program_catalog_id: 'canonical-1',
    created_at: null,
    updated_at: null,
  };
}

/** Six of each, so "top five" is a real slice. */
function set(label: string): RecommendationSet {
  const careers: CareerRecommendation[] = [1, 2, 3, 4, 5, 6].map((n) => ({
    id: `${label}-career-${n}`,
    match_type: 'CAREER',
    match_score: 90 - n,
    ranking: n,
    reason: `Reason ${n}`,
    created_at: '2026-07-27T00:00:00Z',
    career: career(`career-${n}`, `${label} Career ${n}`),
  }));

  const programs: ProgramRecommendation[] = [1, 2, 3, 4, 5, 6].map((n) => ({
    id: `${label}-program-${n}`,
    match_type: 'PROGRAM',
    match_score: 80 - n,
    ranking: n,
    reason: `Program reason ${n}`,
    created_at: '2026-07-27T00:00:00Z',
    program: program(`program-${n}`, `${label} Program ${n}`),
    college: COLLEGE,
  }));

  return {
    assessment_result_id: 'result-1',
    generated_at: '2026-07-27T00:00:00Z',
    careers,
    programs,
  };
}

function renderRoster() {
  render(
    <QueryClientProvider client={createQueryClient()}>
      <RosterTable classId={CLASS_ID} />
    </QueryClientProvider>,
  );

  return userEvent.setup();
}

/** Open one student's row. Exact name, so the "Remove {name} from this class" button never matches. */
async function open(user: ReturnType<typeof userEvent.setup>, name: string) {
  await user.click(await screen.findByRole('button', { name }));
}

function toasts() {
  return useToastStore.getState().toasts;
}

describe('RosterTable', () => {
  beforeEach(() => {
    useToastStore.setState({ toasts: [] });

    vi.mocked(rosterApi.list).mockReset().mockResolvedValue([ANA, BEN]);
    vi.mocked(counselorAssessmentApi.listClassResults)
      .mockReset()
      .mockResolvedValue([
        scctResult(ANA.student_id, 'Ana Dela Cruz'),
        riasecResult(ANA.student_id, 'Ana Dela Cruz', 'IAS'),
        riasecResult(BEN.student_id, 'Ben Dela Cruz', 'RCE'),
      ]);
    vi.mocked(counselorAssessmentApi.resetAttempt).mockReset();
    vi.mocked(recommendationApi.getForStudent).mockReset().mockResolvedValue(set('Ana'));
    vi.mocked(recommendationApi.regenerateForStudent).mockReset();
  });

  it('lists the roster collapsed, and fetches no recommendations until a row is opened', async () => {
    renderRoster();

    expect(await screen.findByRole('button', { name: 'Ana Dela Cruz' })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
    expect(screen.getByRole('button', { name: 'Ben Dela Cruz' })).toBeInTheDocument();
    expect(screen.queryByText('IAS')).not.toBeInTheDocument();

    // The point of the lazy design: two students on screen, zero recommendation requests.
    expect(recommendationApi.getForStudent).not.toHaveBeenCalled();
  });

  it('opens a student into their Holland code, SCCT confidence and top five of each', async () => {
    const user = renderRoster();

    await open(user, 'Ana Dela Cruz');

    expect(screen.getByRole('button', { name: 'Ana Dela Cruz' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    expect(await screen.findByText('IAS')).toBeInTheDocument();

    // SCCT: the server's sentence, and each dimension on its confidence band.
    expect(screen.getByText('Moderate overall career confidence')).toBeInTheDocument();
    expect(screen.getByText('Self-Efficacy')).toBeInTheDocument();
    expect(screen.getByText(/High Confidence/)).toBeInTheDocument();

    expect(await screen.findByText('Ana Career 1')).toBeInTheDocument();
    expect(screen.getByText('Ana Career 5')).toBeInTheDocument();
    expect(screen.queryByText('Ana Career 6')).not.toBeInTheDocument();
    expect(screen.getAllByText('Alpha University')).toHaveLength(5);

    expect(recommendationApi.getForStudent).toHaveBeenCalledExactlyOnceWith(ANA.student_id);
  });

  it('says so plainly when a student has not taken an instrument', async () => {
    const user = renderRoster();

    // Ben has a RIASEC result and no SCCT one.
    await open(user, 'Ben Dela Cruz');

    expect(await screen.findByText('RCE')).toBeInTheDocument();
    expect(screen.getByText('No SCCT result yet')).toBeInTheDocument();
  });

  it('only ever has one student open, so scores from two students are never side by side', async () => {
    vi.mocked(recommendationApi.getForStudent).mockImplementation((studentId) =>
      Promise.resolve(set(studentId === ANA.student_id ? 'Ana' : 'Ben')),
    );

    const user = renderRoster();

    await open(user, 'Ana Dela Cruz');
    expect(await screen.findByText('Ana Career 1')).toBeInTheDocument();

    await open(user, 'Ben Dela Cruz');
    expect(await screen.findByText('Ben Career 1')).toBeInTheDocument();
    expect(screen.queryByText('Ana Career 1')).not.toBeInTheDocument();
  });

  it('rebuilds a set and swaps the cards without a refetch', async () => {
    vi.mocked(recommendationApi.regenerateForStudent).mockResolvedValue(set('Rebuilt'));

    const user = renderRoster();

    await open(user, 'Ana Dela Cruz');
    await screen.findByText('Ana Career 1');

    await user.click(screen.getByRole('button', { name: /rebuild/i }));

    expect(await screen.findByText('Rebuilt Career 1')).toBeInTheDocument();
    expect(screen.queryByText('Ana Career 1')).not.toBeInTheDocument();
    expect(recommendationApi.getForStudent).toHaveBeenCalledTimes(1);

    await waitFor(() => expect(toasts()).toHaveLength(1));
    expect(toasts()[0]).toMatchObject({ tone: 'success' });
    expect(toasts()[0]?.message).toContain('Ana Dela Cruz');
  });

  it('treats a null rebuild as information, not failure', async () => {
    vi.mocked(recommendationApi.getForStudent).mockResolvedValue(null);
    vi.mocked(recommendationApi.regenerateForStudent).mockResolvedValue(null);

    const user = renderRoster();

    await open(user, 'Ana Dela Cruz');

    expect(await screen.findByText(/Already finished both/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /rebuild/i }));

    await waitFor(() => expect(toasts()).toHaveLength(1));
    expect(toasts()[0]).toMatchObject({ tone: 'info' });
    expect(toasts()[0]?.message).toContain('has not finished both RIASEC and SCCT');
  });

  it('distinguishes a failed recommendations load from an empty one', async () => {
    vi.mocked(recommendationApi.getForStudent).mockRejectedValue(
      new ApiRequestError('Student not found.', 404),
    );

    const user = renderRoster();

    await open(user, 'Ana Dela Cruz');

    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText(/could not load/i)).toBeInTheDocument();
    expect(screen.queryByText(/Already finished both/)).not.toBeInTheDocument();
  });

  it('keeps the two-step retake inside the dropdown', async () => {
    vi.mocked(counselorAssessmentApi.resetAttempt).mockResolvedValue(undefined as never);

    const user = renderRoster();

    await open(user, 'Ana Dela Cruz');

    await user.click(
      await screen.findByRole('button', { name: 'Reset attempt: RIASEC Interest Inventory' }),
    );

    // The consequence is spelled out before the button that carries it out.
    expect(screen.getByText(/Resetting voids this result/)).toBeInTheDocument();
    expect(counselorAssessmentApi.resetAttempt).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Yes, reset it' }));

    await waitFor(() =>
      expect(counselorAssessmentApi.resetAttempt).toHaveBeenCalledWith(
        `riasec-${ANA.student_id}`,
      ),
    );
  });
});
