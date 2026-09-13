import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createQueryClient } from '@/app/queryClient';
import { AiInsightsPage } from '@/features/admin/pages/AiInsightsPage';
import { aiApi } from '@/services/aiApi';
import { useAuthStore } from '@/stores/authStore';
import type { AiInsights, ResolvedQuestion, UnansweredQuestion } from '@/types/ai';

vi.mock('@/services/aiApi');

/**
 * **The backlog can be cleared, says when it has not been, and no longer arrives all at once.**
 *
 * Three things are worth locking down on this screen, and none of them is the list markup.
 *
 * The first is the *asked-again* row (migration 0031). It is the rarest state and the only one
 * where the obvious action is the wrong one: an answer already exists and is not being retrieved,
 * so writing a second entry adds a duplicate and fixes nothing. If that explanation ever goes
 * missing the screen still looks correct and quietly trains people to duplicate their own answers.
 *
 * The second is that dismissing — the one action here that never lapses on its own — is offered
 * only to whoever the *server* says may do it, rather than to whoever the client thinks is an admin.
 *
 * The third arrived with the tabs: **a tab that is not open must not be fetched, and a page turn
 * must ask the server for that page.** Both are the whole reason the single endpoint was split, and
 * both fail silently — a screen that eagerly fetches all four tabs looks identical to one that does
 * not, right up until the catalog scan is running on every visit.
 */

function header(overrides: Partial<AiInsights> = {}): AiInsights {
  return {
    corpus: { entries: 0, chunks: 0, embedded: 0, failed: 0 },
    counts: { unanswered: 0, resolved: 0, flagged: 0 },
    can: { dismiss_questions: true, sync_catalog: true, see_all_knowledge: true },
    ...overrides,
  };
}

function page<T>(
  items: T[],
  pagination: Partial<{ current_page: number; last_page: number; total: number }> = {},
) {
  return {
    items,
    pagination: {
      current_page: 1,
      per_page: 25,
      total: items.length,
      last_page: 1,
      ...pagination,
    },
  };
}

function unanswered(overrides: Partial<UnansweredQuestion> = {}): UnansweredQuestion {
  return {
    key: 'is there a dorm',
    question: 'Is there a dorm?',
    asks: 1,
    requests: 0,
    last_asked_at: '2026-09-10T00:00:00.000Z',
    answered_at: null,
    ...overrides,
  };
}

function resolved(overrides: Partial<ResolvedQuestion> = {}): ResolvedQuestion {
  return {
    id: 'r-9',
    question: 'What documents do I bring?',
    resolution: 'ANSWERED',
    document_id: 'd-9',
    document_title: null,
    live: true,
    resolved_by: 'u-2',
    resolved_by_name: 'Cara Counselor',
    resolved_by_role: 'counselor',
    resolved_at: '2026-09-01T00:00:00.000Z',
    ...overrides,
  };
}

const EMPTY_COVERAGE = {
  careers: { total: 0, covered: 0 },
  programs: { total: 0, covered: 0 },
  gaps: [],
};

function renderPage(role: 'admin' | 'counselor' = 'admin') {
  useAuthStore.setState({
    token: 'token',
    user: { id: 'u-1', name: 'Staff', email: 'staff@school.test', role } as never,
    lastRole: role,
  });

  render(
    <QueryClientProvider client={createQueryClient()}>
      <MemoryRouter>
        <AiInsightsPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );

  return userEvent.setup();
}

describe('AiInsightsPage', () => {
  beforeEach(() => {
    vi.mocked(aiApi.aiInsights).mockReset().mockResolvedValue(header());
    vi.mocked(aiApi.unansweredQuestions).mockReset().mockResolvedValue(page<UnansweredQuestion>([]));
    vi.mocked(aiApi.resolvedQuestions).mockReset().mockResolvedValue(page<ResolvedQuestion>([]));
    vi.mocked(aiApi.flaggedAnswers).mockReset().mockResolvedValue([]);
    vi.mocked(aiApi.catalogCoverage).mockReset().mockResolvedValue(EMPTY_COVERAGE);
    vi.mocked(aiApi.dismissQuestion).mockReset().mockResolvedValue({ id: 'r-1', question: 'q' });
    vi.mocked(aiApi.reopenQuestion).mockReset().mockResolvedValue({ id: 'r-1' });
  });

  /**
   * The row that must never lose its explanation. "Asked again" alone reads as "answer it", which
   * is exactly the duplicate the flag exists to prevent.
   */
  it('tells someone not to write a second entry for a question that is already answered', async () => {
    vi.mocked(aiApi.unansweredQuestions).mockResolvedValue(
      page([unanswered({ asks: 2, answered_at: '2026-09-01T00:00:00.000Z' })]),
    );

    renderPage();

    expect(await screen.findByText(/Already answered on/i)).toBeInTheDocument();
    expect(screen.getByText(/rather than adding a second one/i)).toBeInTheDocument();
    // The button names the different action, too.
    expect(screen.getByRole('button', { name: /Answer again/i })).toBeInTheDocument();
  });

  /**
   * A dismissal never expires by itself, so it gets more friction than a single click — and less
   * than a modal, because it is undone from the other tab in one.
   */
  it('asks for confirmation before dismissing a question', async () => {
    vi.mocked(aiApi.unansweredQuestions).mockResolvedValue(
      page([unanswered({ key: 'asdfgh', question: 'asdfgh' })]),
    );

    const user = renderPage();
    const button = await screen.findByRole('button', { name: /Not a question/i });

    await user.click(button);

    expect(aiApi.dismissQuestion).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: /Sure/i }));

    await waitFor(() => {
      expect(aiApi.dismissQuestion).toHaveBeenCalledWith('asdfgh');
    });
  });

  /**
   * The permission comes from the server's `can`, not from the role — the two agree today, and
   * hard-coding the role here is how they stop agreeing the first time the rule gets a nuance.
   */
  it('hides dismissing from anyone the server says may not dismiss', async () => {
    vi.mocked(aiApi.aiInsights).mockResolvedValue(
      header({ can: { dismiss_questions: false, sync_catalog: false, see_all_knowledge: false } }),
    );
    vi.mocked(aiApi.unansweredQuestions).mockResolvedValue(
      page([unanswered({ key: 'is there a shuttle', question: 'Is there a shuttle?' })]),
    );

    renderPage('counselor');

    expect(await screen.findByRole('button', { name: /Answer this/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Not a question/i })).not.toBeInTheDocument();
    // …and the catalog tab, which only an admin can act on, is not offered either.
    expect(screen.queryByRole('tab', { name: /Catalog coverage/i })).not.toBeInTheDocument();
  });

  /**
   * A resolution that has lapsed is otherwise completely silent: the question simply reappears on
   * the other tab with no indication that an answer somebody wrote stopped counting.
   */
  it('explains a resolution whose entry is no longer live', async () => {
    vi.mocked(aiApi.resolvedQuestions).mockResolvedValue(page([resolved({ live: false })]));

    const user = renderPage();

    await user.click(await screen.findByRole('tab', { name: /Already dealt with/i }));

    expect(await screen.findByText(/archived or failed to process/i)).toBeInTheDocument();
    // Attribution travels, so an admin knows who to talk to.
    expect(screen.getByText(/Cara Counselor \(counselor\)/i)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /Put back/i }));

    await waitFor(() => {
      expect(aiApi.reopenQuestion).toHaveBeenCalledWith('admin', 'r-9');
    });
  });

  it('points out likely rephrasings of a question', async () => {
    vi.mocked(aiApi.unansweredQuestions).mockResolvedValue(
      page([
        unanswered({ key: 'a', question: 'Where is Holy Name University located?', asks: 4 }),
        unanswered({ key: 'b', question: 'HNU located' }),
      ]),
    );

    renderPage();

    expect(await screen.findAllByText(/Possibly also asked as 1 other question/i)).toHaveLength(2);
  });

  /**
   * **Answering happens here now, not on another screen** (prompt-driven).
   *
   * "Answer this" used to navigate to /knowledge with the question in the query string. It worked,
   * and it cost the reader their place: a backlog is worked through in order, so answering the
   * fourth question meant leaving, writing, and coming back to page one of a list that had since
   * re-sorted. The form opens under the row instead.
   *
   * The assertion that matters is not that a textarea appeared — it is that saving still keys the
   * resolution to **the report's wording**, which is the whole mechanism that takes the row off the
   * list. That was previously guaranteed by a `?answer=` round trip through the URL; now it is this
   * component's job, and nothing else would notice if it got it wrong.
   */
  it('answers a question in place, keyed to the wording the report showed', async () => {
    const asked = 'how much is the entrance fee';

    vi.mocked(aiApi.unansweredQuestions).mockResolvedValue(
      page([unanswered({ key: asked, question: asked })]),
    );
    vi.mocked(aiApi.createKnowledgeEntry).mockReset().mockResolvedValue({ id: 'd-1' } as never);

    const user = renderPage();

    await user.click(await screen.findByRole('button', { name: /Answer this/i }));
    await user.type(
      screen.getByPlaceholderText(/Answer it the way you would say it/i),
      'PHP 500, payable at the registrar.',
    );
    await user.click(screen.getByRole('button', { name: /Save answer/i }));

    await waitFor(() => {
      expect(aiApi.createKnowledgeEntry).toHaveBeenCalled();
    });

    const [, payload] = vi.mocked(aiApi.createKnowledgeEntry).mock.calls[0]!;

    expect(payload).toMatchObject({
      type: 'qa',
      question: asked,
      answer: 'PHP 500, payable at the registrar.',
      resolves_question: asked,
    });
  });

  /**
   * The rephrasings arrive unticked and only what the author ticks is claimed — the matcher cannot
   * tell the same course in Cebu from the one in Bohol, and a wrong resolution hides a real gap
   * from the one screen built to show it.
   *
   * This test used to live on the knowledge page, because that is where the form used to be.
   */
  it('claims only the rephrasings the author ticked', async () => {
    const asked = 'Where is Holy Name University located?';

    vi.mocked(aiApi.unansweredQuestions).mockResolvedValue(
      page([
        unanswered({ key: 'a', question: asked, asks: 4 }),
        unanswered({ key: 'b', question: 'HNU located' }),
      ]),
    );
    vi.mocked(aiApi.createKnowledgeEntry).mockReset().mockResolvedValue({ id: 'd-1' } as never);

    const user = renderPage();

    const [answerThis] = await screen.findAllByRole('button', { name: /Answer this/i });

    await user.click(answerThis!);

    const sibling = await screen.findByRole('checkbox', { name: 'HNU located' });

    expect(sibling).not.toBeChecked();

    await user.click(sibling);
    await user.type(
      screen.getByPlaceholderText(/Answer it the way you would say it/i),
      'Along J.A. Clarin Street, Tagbilaran City.',
    );
    await user.click(screen.getByRole('button', { name: /Save answer/i }));

    await waitFor(() => {
      expect(aiApi.createKnowledgeEntry).toHaveBeenCalled();
    });

    const [, payload] = vi.mocked(aiApi.createKnowledgeEntry).mock.calls[0]!;

    expect(payload).toMatchObject({ resolves_question: asked, also_resolves: ['HNU located'] });
  });

  /** One form at a time: two half-written answers on screen is two things to lose track of. */
  it('opens one answer form at a time', async () => {
    vi.mocked(aiApi.unansweredQuestions).mockResolvedValue(
      page([
        unanswered({ key: 'a', question: 'When does enrolment close?' }),
        unanswered({ key: 'b', question: 'Is there a shuttle?' }),
      ]),
    );

    const user = renderPage();

    const buttons = await screen.findAllByRole('button', { name: /Answer this/i });

    await user.click(buttons[0]!);
    expect(screen.getAllByPlaceholderText(/Answer it the way you would say it/i)).toHaveLength(1);

    await user.click(screen.getAllByRole('button', { name: /Answer this/i })[0]!);
    expect(screen.getAllByPlaceholderText(/Answer it the way you would say it/i)).toHaveLength(1);
  });
});

/** The tabs, and the two properties that make splitting the endpoint worth anything. */
describe('AiInsightsPage — tabs and paging', () => {
  beforeEach(() => {
    vi.mocked(aiApi.aiInsights)
      .mockReset()
      .mockResolvedValue(header({ counts: { unanswered: 30, resolved: 4, flagged: 2 } }));
    vi.mocked(aiApi.unansweredQuestions)
      .mockReset()
      .mockResolvedValue(page([unanswered()], { total: 30, last_page: 2 }));
    vi.mocked(aiApi.resolvedQuestions).mockReset().mockResolvedValue(page([resolved()]));
    vi.mocked(aiApi.flaggedAnswers).mockReset().mockResolvedValue([]);
    vi.mocked(aiApi.catalogCoverage).mockReset().mockResolvedValue(EMPTY_COVERAGE);
  });

  /**
   * **The reason the single endpoint was split.** Catalog coverage scans every career and program;
   * it has no business running to render the backlog, which is what the reader came for nine visits
   * out of ten. An eager fetch looks identical on screen, so only a test catches this.
   */
  it('fetches only the open tab', async () => {
    renderPage();

    await screen.findByText('Is there a dorm?');

    expect(aiApi.unansweredQuestions).toHaveBeenCalled();
    expect(aiApi.catalogCoverage).not.toHaveBeenCalled();
    expect(aiApi.flaggedAnswers).not.toHaveBeenCalled();
  });

  it('fetches a tab the first time it is opened', async () => {
    const user = renderPage();

    await user.click(await screen.findByRole('tab', { name: /Catalog coverage/i }));

    await waitFor(() => expect(aiApi.catalogCoverage).toHaveBeenCalledWith('admin'));
  });

  it('shows the backlog size on the tab before it is opened', async () => {
    renderPage();

    expect(await screen.findByRole('tab', { name: /Unanswered, 30/i })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /Already dealt with, 4/i })).toBeInTheDocument();
  });

  /** A pager that does not ask the server for the page is a pager that shows page one forever. */
  it('asks the server for the next page', async () => {
    const user = renderPage();

    await user.click(await screen.findByRole('button', { name: /Next/i }));

    await waitFor(() => expect(aiApi.unansweredQuestions).toHaveBeenCalledWith('admin', 2));
  });

  /**
   * A tab somebody clicked that renders nothing reads as a broken screen. The resolved list used
   * to return null when empty, which was right when it was one card in a stack and is wrong now.
   */
  it('says so rather than rendering nothing when a tab is empty', async () => {
    vi.mocked(aiApi.resolvedQuestions).mockResolvedValue(page<ResolvedQuestion>([]));

    const user = renderPage();

    await user.click(await screen.findByRole('tab', { name: /Already dealt with/i }));

    expect(await screen.findByText(/Nothing dealt with yet/i)).toBeInTheDocument();
  });
});
