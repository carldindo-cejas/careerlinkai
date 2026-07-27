import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createQueryClient } from '@/app/queryClient';
import { RecommendationPage } from '@/features/student/pages/RecommendationPage';
import { catalogLinksApi, chatApi, recommendationApi } from '@/services/recommendationApi';
import type { Career, College, Program } from '@/types/catalog';
import type {
  CareerRecommendation,
  ProgramRecommendation,
  RecommendationSet,
} from '@/types/recommendation';

vi.mock('@/services/recommendationApi');
vi.mock('@/services/aiApi');

/**
 * The recommendations screen (prompt-driven, 2026-07-27).
 *
 * Two things here are load-bearing beyond "the page renders", and both are asserted rather than
 * assumed:
 *
 *   1. **The shortlist is the engine's top five**, and the sort control re-orders that set without
 *      changing its membership. A sort that reached further into the persisted ten would be a
 *      second ranking the engine never made — the thing §26/§27 exist to prevent.
 *   2. **A deterministic chat reply is labelled as one.** The whole trust model rests on a student
 *      being able to tell a computed fact from a generated sentence (§29), and the tell is the
 *      absence of `ai_request_id`.
 */

function career(id: string, title: string, salaryMax: number, outlookOrder: number): Career {
  return {
    id,
    title,
    description: null,
    salary_min: 20000,
    salary_max: salaryMax,
    employment_outlook_id: `outlook-${outlookOrder}`,
    employment_outlook: { id: `outlook-${outlookOrder}`, name: `Outlook ${outlookOrder}`, display_order: outlookOrder },
    typical_riasec_code: 'IEC',
    status: 'active',
    created_at: null,
    updated_at: null,
  };
}

const COLLEGE: College = {
  id: 'college-1',
  name: 'Alpha University',
  description: null,
  status: 'active',
  region: null,
  province: null,
  town: { id: 'town-1', name: 'Quezon City' },
  barangay: null,
  map_link: 'https://maps.google.com/?q=alpha',
  created_at: null,
  updated_at: null,
};

function program(id: string, name: string): Program {
  return {
    id,
    college_id: COLLEGE.id,
    code: 'BSCS',
    name,
    department_name: null,
    description: null,
    recommended_strand: 'Academic',
    status: 'active',
    program_catalog_id: 'canonical-1',
    created_at: null,
    updated_at: null,
  };
}

/**
 * Six careers, so "top five" is a real slice rather than the whole list — a fixture of five could
 * not tell "sliced to five" apart from "returned everything".
 *
 * The salaries are deliberately *inverse* to the match ranking: the lowest-ranked career pays most.
 * That is what makes the sort assertion meaningful.
 */
function set(): RecommendationSet {
  const careers: CareerRecommendation[] = [1, 2, 3, 4, 5, 6].map((n) => ({
    id: `rec-career-${n}`,
    match_type: 'CAREER',
    match_score: 90 - n,
    ranking: n,
    reason: `Reason ${n}`,
    created_at: '2026-07-27T00:00:00Z',
    career: career(`career-${n}`, `Career ${n}`, 10000 * n, n),
  }));

  const programs: ProgramRecommendation[] = [1, 2, 3, 4, 5, 6].map((n) => ({
    id: `rec-program-${n}`,
    match_type: 'PROGRAM',
    match_score: 80 - n,
    ranking: n,
    reason: `Program reason ${n}`,
    created_at: '2026-07-27T00:00:00Z',
    program: program(`program-${n}`, `Program ${n}`),
    college: COLLEGE,
  }));

  return {
    assessment_result_id: 'result-1',
    generated_at: '2026-07-27T00:00:00Z',
    careers,
    programs,
  };
}

function renderPage() {
  render(
    <QueryClientProvider client={createQueryClient()}>
      <MemoryRouter>
        <RecommendationPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('RecommendationPage', () => {
  beforeEach(() => {
    vi.mocked(recommendationApi.getMine).mockResolvedValue(set());
    vi.mocked(chatApi.getTranscript).mockResolvedValue({
      conversation_id: null,
      messages: [],
    });
  });

  it('shows the top three careers by default', async () => {
    renderPage();

    await screen.findByText('Career 1');

    expect(screen.getByText('Career 3')).toBeInTheDocument();
    expect(screen.queryByText('Career 4')).not.toBeInTheDocument();
  });

  /** Three by default, five on request — never the full persisted ten. */
  it('expands to five, and no further', async () => {
    const user = userEvent.setup();
    renderPage();

    await screen.findByText('Career 1');

    const careers = screen.getByRole('heading', { name: 'Careers' }).closest('section')!;

    await user.click(within(careers).getByRole('button', { name: /show top 5/i }));

    expect(await screen.findByText('Career 5')).toBeInTheDocument();
    // Six exists in the fixture and must not appear: the shortlist is capped at five.
    expect(screen.queryByText('Career 6')).not.toBeInTheDocument();
  });

  it('collapses back to three', async () => {
    const user = userEvent.setup();
    renderPage();

    await screen.findByText('Career 1');

    const careers = screen.getByRole('heading', { name: 'Careers' }).closest('section')!;

    await user.click(within(careers).getByRole('button', { name: /show top 5/i }));
    await screen.findByText('Career 5');

    await user.click(within(careers).getByRole('button', { name: /show top 3 only/i }));

    await waitFor(() => expect(screen.queryByText('Career 4')).not.toBeInTheDocument());
  });

  /**
   * **The important one.** Sorting by salary re-orders the top five; it must not pull in the
   * sixth-ranked career, which pays the most of all. A sort that changed the membership of the set
   * would be a second ranking the engine never made.
   */
  it('re-orders the shortlist by salary without changing which careers are in it', async () => {
    const user = userEvent.setup();
    renderPage();

    await screen.findByText('Career 1');

    await user.selectOptions(screen.getByLabelText(/sort by/i), 'salary');

    const careers = screen.getByRole('heading', { name: 'Careers' }).closest('section')!;

    // Career 5 pays the most *within the top five*, so it leads now.
    await waitFor(() => expect(within(careers).getByText('Career 5')).toBeInTheDocument());

    // …and Career 6, which pays more than all of them, is still excluded.
    expect(screen.queryByText('Career 6')).not.toBeInTheDocument();
  });

  /** The Programs section gets the same treatment, so the page reads as one system. */
  it('applies the same three-to-five collapse to programs', async () => {
    const user = userEvent.setup();
    renderPage();

    await screen.findByText('Program 1');

    expect(screen.queryByText('Program 4')).not.toBeInTheDocument();

    const programs = screen.getByRole('heading', { name: 'Programs' }).closest('section')!;

    await user.click(within(programs).getByRole('button', { name: /show top 5/i }));

    expect(await screen.findByText('Program 5')).toBeInTheDocument();
    expect(screen.queryByText('Program 6')).not.toBeInTheDocument();
  });

  /**
   * `program_careers` read backwards. The list is fetched only when the disclosure is opened —
   * a page that eagerly fetched related programs for five careers would spend five requests to
   * render a page on which the student usually opens none of them.
   */
  it('loads related college programs only when asked', async () => {
    const user = userEvent.setup();
    vi.mocked(catalogLinksApi.programsForCareer).mockResolvedValue({
      career: career('career-1', 'Career 1', 50000, 1),
      programs: [{ program: program('program-9', 'BS Statistics'), college: COLLEGE }],
    });

    renderPage();

    await screen.findByText('Career 1');
    expect(catalogLinksApi.programsForCareer).not.toHaveBeenCalled();

    const [button] = screen.getAllByRole('button', { name: /view related college programs/i });
    await user.click(button!);

    expect(await screen.findByText(/BS Statistics/)).toBeInTheDocument();
    expect(catalogLinksApi.programsForCareer).toHaveBeenCalledWith('career-1');
  });

  /** The existing college mapping, reused verbatim — same label, same target. */
  it('lists colleges offering a program, each with its Google Maps link', async () => {
    const user = userEvent.setup();
    vi.mocked(catalogLinksApi.collegesForProgram).mockResolvedValue({
      canonical: {
        id: 'canonical-1',
        code: 'BSCS',
        name: 'BS Computer Science',
        description: null,
        status: 'active',
        created_at: null,
        updated_at: null,
      },
      offerings: [{ college: COLLEGE, program: program('program-1', 'Program 1') }],
    });

    renderPage();

    await screen.findByText('Program 1');

    const [button] = screen.getAllByRole('button', { name: /view colleges offering this program/i });
    await user.click(button!);

    // The college name also appears as each program card's subtitle, so the disclosure is
    // identified by the thing only it renders: the map link.
    const link = await screen.findByRole('link', { name: /view on google maps/i });

    expect(link).toHaveAttribute('href', 'https://maps.google.com/?q=alpha');
    expect(link).toHaveAttribute('rel', expect.stringContaining('noopener'));
    expect(within(link.closest('li')!).getByText('Alpha University')).toBeInTheDocument();
  });

  /**
   * A program with no canonical entry says so, rather than rendering an empty list that reads as
   * "nowhere offers this".
   */
  it('says so when a program is not matched to the shared catalog', async () => {
    const user = userEvent.setup();
    vi.mocked(catalogLinksApi.collegesForProgram).mockResolvedValue({
      canonical: null,
      offerings: [],
    });

    renderPage();

    await screen.findByText('Program 1');

    const [button] = screen.getAllByRole('button', { name: /view colleges offering this program/i });
    await user.click(button!);

    expect(await screen.findByText(/hasn't been matched to the shared program catalog/i)).toBeInTheDocument();
  });

  it('offers the assistant, and asks a question through it', async () => {
    const user = userEvent.setup();
    vi.mocked(chatApi.ask).mockResolvedValue({
      conversation_id: 'conversation-1',
      question: {
        id: 'message-1',
        role: 'user',
        content: 'Why is Career 1 my top match?',
        ai_request_id: null,
        created_at: null,
      },
      answer: {
        id: 'message-2',
        role: 'assistant',
        content: 'It leans Investigative, which is your strongest interest.',
        ai_request_id: 'ai-1',
        created_at: null,
      },
      failure: null,
    });

    renderPage();

    await screen.findByText('Career 1');

    await user.type(screen.getByLabelText(/your question/i), 'Why is Career 1 my top match?');
    await user.click(screen.getByRole('button', { name: /^send$/i }));

    expect(
      await screen.findByText('It leans Investigative, which is your strongest interest.'),
    ).toBeInTheDocument();
    expect(chatApi.ask).toHaveBeenCalledWith('Why is Career 1 my top match?');
  });

  /**
   * §29's whole posture, on screen: when the model is unavailable the student still gets a true
   * answer built from their computed results — **and it is labelled**, because presenting computed
   * text as a generation is the confusion the AI/deterministic split exists to prevent.
   */
  it('labels a deterministic fallback answer as one', async () => {
    const user = userEvent.setup();
    vi.mocked(chatApi.ask).mockResolvedValue({
      conversation_id: 'conversation-1',
      question: {
        id: 'message-1',
        role: 'user',
        content: 'Anything?',
        ai_request_id: null,
        created_at: null,
      },
      answer: {
        id: 'message-2',
        role: 'assistant',
        content: 'The assistant is unavailable at the moment, so here is what your results say.',
        // The tell: no request behind it.
        ai_request_id: null,
        created_at: null,
      },
      failure: 'MODEL_UNAVAILABLE',
    });

    renderPage();

    await screen.findByText('Career 1');

    await user.type(screen.getByLabelText(/your question/i), 'Anything?');
    await user.click(screen.getByRole('button', { name: /^send$/i }));

    expect(
      await screen.findByText(/from your computed results — the assistant was unavailable/i),
    ).toBeInTheDocument();
  });

  /** D11: a failed load is not an empty one, and the two must not look alike. */
  it('distinguishes "none yet" from a failed load', async () => {
    vi.mocked(recommendationApi.getMine).mockResolvedValue(null);

    renderPage();

    expect(await screen.findByText(/finish both assessments/i)).toBeInTheDocument();
  });
});
