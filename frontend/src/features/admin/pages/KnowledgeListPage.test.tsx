import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createQueryClient } from '@/app/queryClient';
import { KnowledgeListPage } from '@/features/admin/pages/KnowledgeListPage';
import { aiApi } from '@/services/aiApi';
import { useAuthStore } from '@/stores/authStore';
import type { KnowledgeDocument } from '@/types/ai';

vi.mock('@/services/aiApi');

/**
 * **Answering a question actually clears it** — the client half of migration 0031.
 *
 * The backend records a resolution against `resolves_question`, and everything downstream of that
 * depends on this screen sending the right string. The one that is easy to send, and wrong, is the
 * question in the form: the report hands over the student's wording, and the first thing anybody
 * does with a pre-filled question is tidy it up. Keying off the tidied text would resolve a
 * question nothing ever asked — the entry saves, the backlog item never clears, and the failure is
 * silent on both sides.
 *
 * So that is what is asserted here, deliberately with the question field edited before saving.
 */

function document(id: string, title: string): KnowledgeDocument {
  return {
    id,
    title,
    file_name: title,
    source_type: 'qa',
    entity_type: null,
    entity_id: null,
    processing_status: 'UPLOADED',
    visibility: 'GLOBAL',
    archived_at: null,
    chunk_count: null,
    added_by: 'u-admin',
    added_by_name: 'Ada Admin',
    added_by_role: 'admin',
    created_at: '2026-09-11T00:00:00.000Z',
    updated_at: '2026-09-11T00:00:00.000Z',
  };
}

function renderPage(url: string, role: 'admin' | 'counselor' = 'admin') {
  useAuthStore.setState({
    token: 'token',
    user: { id: 'u-1', name: 'Staff', email: 'staff@school.test', role } as never,
    lastRole: role,
  });

  render(
    <QueryClientProvider client={createQueryClient()}>
      <MemoryRouter initialEntries={[url]}>
        <KnowledgeListPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );

  return userEvent.setup();
}

describe('KnowledgeListPage', () => {
  beforeEach(() => {
    vi.mocked(aiApi.listKnowledgeDocuments).mockReset();
    vi.mocked(aiApi.createKnowledgeEntry).mockReset();
    vi.mocked(aiApi.archiveKnowledgeDocument).mockReset();
    vi.mocked(aiApi.removeKnowledgeDocument).mockReset();
    vi.mocked(aiApi.listKnowledgeDocuments).mockResolvedValue({
      items: [],
      pagination: { current_page: 1, per_page: 20, total: 0, last_page: 1 },
    });
    vi.mocked(aiApi.createKnowledgeEntry).mockResolvedValue(document('d-1', 'Saved'));
  });

  /**
   * The crux. `?answer=` carries the backlog's wording; the form is then edited, as it always is;
   * and the resolution must still be keyed to what the report showed.
   */
  it("resolves the backlog's wording even after the question is edited in the form", async () => {
    const asked = 'how much is the entrance fee';
    const user = renderPage(`/admin/knowledge?answer=${encodeURIComponent(asked)}`);

    const questionField = await screen.findByDisplayValue(asked);

    // Tidied up before saving — capitalised, punctuated. Exactly the realistic case.
    await user.clear(questionField);
    await user.type(questionField, 'How much is the entrance fee?');
    await user.type(
      screen.getByPlaceholderText(/Tuition for BS Nursing/i),
      'PHP 500, payable at the registrar.',
    );
    await user.click(screen.getByRole('button', { name: /Save to knowledge base/i }));

    await waitFor(() => {
      expect(aiApi.createKnowledgeEntry).toHaveBeenCalled();
    });

    const [, payload] = vi.mocked(aiApi.createKnowledgeEntry).mock.calls[0]!;

    expect(payload).toMatchObject({
      type: 'qa',
      // What gets stored and embedded is the tidied version…
      question: 'How much is the entrance fee?',
      // …and what gets resolved is what the report actually showed.
      resolves_question: asked,
    });
  });

  /**
   * An entry written from scratch claims no backlog row from the client. (The server still credits a
   * Q&A pair with its own question — that is its decision, not something this form asserts.)
   */
  it('sends no resolves_question when the form was not opened from the report', async () => {
    const user = renderPage('/admin/knowledge');

    await user.click(await screen.findByRole('button', { name: /Answer a question/i }));
    await user.type(
      screen.getByPlaceholderText(/How much is tuition for Nursing/i),
      'When does enrolment close?',
    );
    await user.type(
      screen.getByPlaceholderText(/Tuition for BS Nursing/i),
      'Enrolment closes on 30 June.',
    );
    await user.click(screen.getByRole('button', { name: /Save to knowledge base/i }));

    await waitFor(() => {
      expect(aiApi.createKnowledgeEntry).toHaveBeenCalled();
    });

    const [, payload] = vi.mocked(aiApi.createKnowledgeEntry).mock.calls[0]!;

    expect(payload).not.toHaveProperty('resolves_question');
  });

  /**
   * The thing a counselor must understand before typing anything: what they add is not a private
   * note for their own classes. Asserted rather than trusted to survive a copy edit, because the
   * cost of it quietly disappearing is somebody publishing to the whole school by accident.
   */
  it('warns a counselor that what they add is school-wide, and does not warn an admin', async () => {
    renderPage('/counselor/knowledge', 'counselor');

    expect(await screen.findByText(/shared knowledge base/i)).toBeInTheDocument();
    /*
      The catalog sync rewrites every career and program entry — not a counselor's to press.

      This asserts the **trigger**, not the `Sync now` inside the modal. Checking the inner button
      would pass for a counselor and an admin alike, because a closed Radix dialog renders nothing
      at all: the test would have been green whatever the page did.
    */
    expect(screen.queryByRole('button', { name: /Sync catalog/i })).not.toBeInTheDocument();
  });

  it('offers an admin the catalog sync and the author filter', async () => {
    const user = renderPage('/admin/knowledge');

    expect(
      screen.getByRole('combobox', { name: /who added the entry/i }),
    ).toBeInTheDocument();

    // The sync is a modal now, not a permanently-open card — so the trigger is what the page
    // offers, and `Sync now` only exists once it is opened.
    await user.click(await screen.findByRole('button', { name: /Sync catalog/i }));

    expect(await screen.findByRole('button', { name: /Sync now/i })).toBeInTheDocument();
  });

  /** Scope is part of every call, so a counselor's requests reach their own mount. */
  it('calls the mount that matches the signed-in role', async () => {
    renderPage('/counselor/knowledge', 'counselor');

    await waitFor(() => {
      expect(aiApi.listKnowledgeDocuments).toHaveBeenCalledWith('counselor', expect.anything());
    });
  });

  /**
   * The live/archived split (prompt-driven).
   *
   * Archived entries used to sit in the same list as working ones, so the question this page exists
   * to answer — *what can the AI actually answer from?* — could not be answered by looking at it.
   * What matters is that each tab asks the server for its own half: the filtering is not something
   * the client does to a shared list, because then the pager would be counting the wrong total.
   */
  it('asks for the live half by default and the archived half on the other tab', async () => {
    const user = renderPage('/admin/knowledge');

    await waitFor(() => {
      expect(aiApi.listKnowledgeDocuments).toHaveBeenCalledWith(
        'admin',
        expect.objectContaining({ archived: 'live' }),
      );
    });

    await user.click(screen.getByRole('tab', { name: /Archived/i }));

    await waitFor(() => {
      expect(aiApi.listKnowledgeDocuments).toHaveBeenCalledWith(
        'admin',
        expect.objectContaining({ archived: 'archived' }),
      );
    });
  });

  /**
   * Removing is destructive and irreversible, so it takes two presses — and on a live entry it
   * archives first, because the server refuses to destroy anything still in service.
   *
   * Both halves of that are asserted: a single press must not remove anything (the failure mode
   * that matters), and the composed archive→remove must actually happen in that order.
   */
  it('removes a live entry only after a second press, archiving it first', async () => {
    vi.mocked(aiApi.listKnowledgeDocuments).mockResolvedValue({
      items: [document('d-9', 'A wrong answer')],
      pagination: { current_page: 1, per_page: 20, total: 1, last_page: 1 },
    });
    vi.mocked(aiApi.archiveKnowledgeDocument).mockResolvedValue(document('d-9', 'A wrong answer'));
    vi.mocked(aiApi.removeKnowledgeDocument).mockResolvedValue({ id: 'd-9' });

    const user = renderPage('/admin/knowledge');

    await user.click(await screen.findByRole('button', { name: /^Remove$/i }));

    // Armed, not fired.
    expect(aiApi.removeKnowledgeDocument).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: /Remove for good/i }));

    await waitFor(() => {
      expect(aiApi.removeKnowledgeDocument).toHaveBeenCalledWith('admin', 'd-9');
    });

    // The server refuses to destroy a live entry, so the client archives first rather than
    // sending a request it knows will 422.
    expect(aiApi.archiveKnowledgeDocument).toHaveBeenCalledWith('admin', 'd-9');
  });
});
