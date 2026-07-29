import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createQueryClient } from '@/app/queryClient';
import { ClassRecommendationsPanel } from '@/features/counselor/components/ClassRecommendationsPanel';
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
 * The counselor's recommendations panel (audit F2, P1-1).
 *
 * Three things here are load-bearing beyond "it renders", and each is asserted rather than assumed:
 *
 *   1. **Nothing is fetched until a row is opened.** There is no bulk endpoint behind this screen,
 *      so an eager panel would fire one request per enrolled student on page load. That is the
 *      regression this test exists to catch, and it is invisible by inspection.
 *   2. **`null` is not an error.** A rebuild that returns `null` means the student has not finished
 *      both instruments — reporting it as a failure would send a counselor chasing a bug in a
 *      system working exactly as designed. This is the C4 distinction, at the UI layer.
 *   3. **A rebuilt set replaces the cards without a refetch.** The hook writes the response into
 *      the cache; a panel that invalidated instead would blank the cards it was pressed to fill.
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
  };
}

const ANA = entry('adelacruz', 'Ana');
const BEN = entry('bdelacruz', 'Ben');

/** A scored RIASEC row, which is where the Holland badge on each student's row comes from. */
function riasecResult(studentId: string, name: string, code: string): AssessmentResult {
  return {
    attempt_id: `attempt-${studentId}`,
    submitted_at: '2026-07-20T02:00:00Z',
    assessment: { title: 'RIASEC Interest Inventory', category: 'RIASEC' },
    student: { id: studentId, name, username: null },
    result: { result_code: code, overall_summary: null, generated_at: null },
    dimensions: [],
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

/**
 * Six of each, so "top five" is a real slice. A fixture of five could not tell "sliced to five"
 * apart from "rendered everything it was given".
 */
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

function renderPanel() {
  render(
    <QueryClientProvider client={createQueryClient()}>
      <ClassRecommendationsPanel classId={CLASS_ID} />
    </QueryClientProvider>,
  );

  return userEvent.setup();
}

/** Open one student's row and wait for their recommendations to resolve. */
async function open(user: ReturnType<typeof userEvent.setup>, name: string) {
  await user.click(await screen.findByRole('button', { name: new RegExp(name) }));
}

function toasts() {
  return useToastStore.getState().toasts;
}

describe('ClassRecommendationsPanel', () => {
  beforeEach(() => {
    useToastStore.setState({ toasts: [] });

    vi.mocked(rosterApi.list).mockReset().mockResolvedValue([ANA, BEN]);
    vi.mocked(counselorAssessmentApi.listClassResults)
      .mockReset()
      .mockResolvedValue([
        riasecResult(ANA.student_id, 'Ana Dela Cruz', 'IAS'),
        riasecResult(BEN.student_id, 'Ben Dela Cruz', 'RCE'),
      ]);
    vi.mocked(recommendationApi.getForStudent).mockReset().mockResolvedValue(set('Ana'));
    vi.mocked(recommendationApi.regenerateForStudent).mockReset();
  });

  it('lists the roster with each student’s Holland code, and fetches nothing until a row is opened', async () => {
    renderPanel();

    expect(await screen.findByText('Ana Dela Cruz')).toBeInTheDocument();
    expect(screen.getByText('Ben Dela Cruz')).toBeInTheDocument();
    expect(screen.getByText('IAS')).toBeInTheDocument();
    expect(screen.getByText('RCE')).toBeInTheDocument();

    // The point of the whole lazy design: two students on screen, zero recommendation requests.
    expect(recommendationApi.getForStudent).not.toHaveBeenCalled();
  });

  it('says so plainly when a student has no scored RIASEC attempt', async () => {
    vi.mocked(counselorAssessmentApi.listClassResults).mockResolvedValue([
      riasecResult(ANA.student_id, 'Ana Dela Cruz', 'IAS'),
    ]);

    renderPanel();

    // Ben has no result — a blank badge could be read as an empty code, so the row says why.
    expect(await screen.findByText('No RIASEC result yet')).toBeInTheDocument();
  });

  it('fetches and renders one student’s top five careers and programs on open', async () => {
    const user = renderPanel();

    await open(user, 'Ana Dela Cruz');

    expect(await screen.findByText('Ana Career 1')).toBeInTheDocument();
    expect(screen.getByText('Ana Career 5')).toBeInTheDocument();
    // Six were returned; the staff summary shows five.
    expect(screen.queryByText('Ana Career 6')).not.toBeInTheDocument();

    // Programs are listed by college, with the program itself as the secondary line.
    expect(screen.getAllByText('Alpha University')).toHaveLength(5);
    expect(screen.getByText(/Ana Program 1/)).toBeInTheDocument();

    expect(recommendationApi.getForStudent).toHaveBeenCalledExactlyOnceWith(ANA.student_id);
  });

  it('only ever has one student open, so scores from two students are never side by side', async () => {
    vi.mocked(recommendationApi.getForStudent).mockImplementation((studentId) =>
      Promise.resolve(set(studentId === ANA.student_id ? 'Ana' : 'Ben')),
    );

    const user = renderPanel();

    await open(user, 'Ana Dela Cruz');
    expect(await screen.findByText('Ana Career 1')).toBeInTheDocument();

    await open(user, 'Ben Dela Cruz');
    expect(await screen.findByText('Ben Career 1')).toBeInTheDocument();
    expect(screen.queryByText('Ana Career 1')).not.toBeInTheDocument();
  });

  it('rebuilds a set and swaps the cards without a refetch', async () => {
    vi.mocked(recommendationApi.regenerateForStudent).mockResolvedValue(set('Rebuilt'));

    const user = renderPanel();

    await open(user, 'Ana Dela Cruz');
    await screen.findByText('Ana Career 1');

    await user.click(screen.getByRole('button', { name: /rebuild/i }));

    expect(await screen.findByText('Rebuilt Career 1')).toBeInTheDocument();
    expect(screen.queryByText('Ana Career 1')).not.toBeInTheDocument();

    // The response *is* the new set, written straight into the cache — re-reading it would blank
    // the cards for a round trip and pay for bytes already in hand.
    expect(recommendationApi.getForStudent).toHaveBeenCalledTimes(1);

    await waitFor(() => expect(toasts()).toHaveLength(1));
    expect(toasts()[0]).toMatchObject({ tone: 'success' });
    expect(toasts()[0]?.message).toContain('Ana Dela Cruz');
  });

  it('treats a null rebuild as information, not failure', async () => {
    vi.mocked(recommendationApi.getForStudent).mockResolvedValue(null);
    vi.mocked(recommendationApi.regenerateForStudent).mockResolvedValue(null);

    const user = renderPanel();

    await open(user, 'Ana Dela Cruz');

    // The empty state raises the possibility that generation broke, rather than only repeating the
    // instruction the student may already have followed (audit C4).
    expect(await screen.findByText(/Already finished both/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /rebuild/i }));

    await waitFor(() => expect(toasts()).toHaveLength(1));
    expect(toasts()[0]).toMatchObject({ tone: 'info' });
    expect(toasts()[0]?.message).toContain('has not finished both RIASEC and SCCT');
  });

  it('surfaces the server’s message when a rebuild is throttled', async () => {
    vi.mocked(recommendationApi.regenerateForStudent).mockRejectedValue(
      new ApiRequestError(
        'This student’s recommendations were rebuilt very recently. Try again in 42 seconds.',
        429,
      ),
    );

    const user = renderPanel();

    await open(user, 'Ana Dela Cruz');
    await screen.findByText('Ana Career 1');

    await user.click(screen.getByRole('button', { name: /rebuild/i }));

    await waitFor(() => expect(toasts()).toHaveLength(1));
    expect(toasts()[0]).toMatchObject({ tone: 'error' });
    expect(toasts()[0]?.message).toContain('Try again in 42 seconds');

    // The failure did not take the cards down with it — the standing set is still on screen.
    expect(screen.getByText('Ana Career 1')).toBeInTheDocument();
  });

  it('distinguishes a failed load from an empty one', async () => {
    vi.mocked(recommendationApi.getForStudent).mockRejectedValue(
      new ApiRequestError('Student not found.', 404),
    );

    const user = renderPanel();

    await open(user, 'Ana Dela Cruz');

    // D11's rule: this is an alert, not the "finish both assessments" empty state.
    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText(/could not load/i)).toBeInTheDocument();
    expect(screen.queryByText(/Already finished both/)).not.toBeInTheDocument();
  });
});
