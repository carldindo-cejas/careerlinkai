import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createQueryClient } from '@/app/queryClient';
import { StudentChatLauncher } from '@/features/student/components/RecommendationChatPanel';
import { TOUR } from '@/features/student/tour/stops';
import { chatApi } from '@/services/recommendationApi';
import { useTourStore } from '@/stores/tourStore';
import type { ChatMessage } from '@/types/recommendation';

vi.mock('@/services/recommendationApi');

/**
 * *"Want me to take you there?"* — the navigation offer under an assistant answer (migration 0038).
 *
 * What is under test is the **decision**, not the highlight: pressing yes puts the tour overlay
 * into its single-stop mode and the overlay, which is mounted by the shell, owns everything after
 * that. Keeping the two apart is the point — one component decides what route a stop is on, and it
 * is the one that has to find the element when it gets there.
 */

function answer(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 'cm000000-0000-4000-8000-000000000002',
    role: 'assistant',
    content: 'Your results are on "My results".\n\nWant me to take you there?',
    ai_request_id: null,
    sources: [],
    answer_kind: 'CANNED',
    feedback: null,
    knowledge_request: null,
    nav_target: 'results',
    created_at: '2026-09-18T01:00:00.000Z',
    ...overrides,
  };
}

/** The launcher, already open — the drawer is where a student actually reads an answer. */
async function openChat(message: ChatMessage) {
  vi.mocked(chatApi.getTranscript).mockResolvedValue({
    conversation_id: 'cc000000-0000-4000-8000-000000000001',
    messages: [
      {
        ...answer(),
        id: 'cm000000-0000-4000-8000-000000000001',
        role: 'user',
        content: 'Where do I see my results?',
        answer_kind: null,
        nav_target: null,
      },
      message,
    ],
  });
  vi.mocked(chatApi.getBrief).mockRejectedValue(new Error('not needed'));

  render(
    <QueryClientProvider client={createQueryClient()}>
      <MemoryRouter>
        <StudentChatLauncher />
      </MemoryRouter>
    </QueryClientProvider>,
  );

  await userEvent.click(screen.getByRole('button', { name: /ask careerlinkai/i }));

  // The transcript's own screen-reader label for an answer — present whatever the answer says, so
  // this waits for the reply to be on screen without assuming its wording.
  return screen.findAllByText('The assistant said');
}

beforeEach(() => {
  vi.clearAllMocks();
  useTourStore.setState({ steps: [], index: 0, seenVersion: 1 });
});

describe('an answer that offers to take the student somewhere', () => {
  it('offers, rather than going', async () => {
    await openChat(answer());

    expect(await screen.findByRole('button', { name: /yes, show me/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /no thanks/i })).toBeInTheDocument();
    // Nothing has happened yet. Accepting throws the student off the screen they are on, so it is
    // their decision and not a side effect of having asked a question.
    expect(useTourStore.getState().steps).toEqual([]);
  });

  it('points at exactly that one thing when accepted — not the whole tour', async () => {
    await openChat(answer());

    await userEvent.click(await screen.findByRole('button', { name: /yes, show me/i }));

    expect(useTourStore.getState().steps).toEqual(['results']);
  });

  it('takes the offer away, and sends nothing, when declined', async () => {
    await openChat(answer());

    await userEvent.click(await screen.findByRole('button', { name: /no thanks/i }));

    expect(screen.queryByRole('button', { name: /yes, show me/i })).toBeNull();
    expect(useTourStore.getState().steps).toEqual([]);
  });

  /** The tour is not a place, so the offer says what it actually does. */
  it('starts the whole tour for "show me around"', async () => {
    await openChat(answer({ nav_target: 'tour', content: 'There is a short tour.' }));

    await userEvent.click(await screen.findByRole('button', { name: /start the tour/i }));

    expect(useTourStore.getState().steps).toEqual(TOUR);
  });

  /**
   * A server that learns a new destination before this build does must degrade to plain prose. The
   * sentence has already told the student where to go; only the shortcut is missing.
   */
  it('renders no button for a destination this build does not know', async () => {
    await openChat(answer({ nav_target: 'scholarships-page' }));

    expect(screen.queryByRole('button', { name: /yes, show me/i })).toBeNull();
  });

  it('renders no button on an ordinary answer', async () => {
    await openChat(
      answer({ nav_target: null, content: 'Nursing is your top program because…' }),
    );

    expect(screen.queryByRole('button', { name: /yes, show me/i })).toBeNull();
  });

  /** A transcript cached from before the column existed carries no `nav_target` at all. */
  it('survives a message from before the field existed', async () => {
    const { nav_target: _omitted, ...legacy } = answer();

    await openChat(legacy as ChatMessage);

    expect(screen.queryByRole('button', { name: /yes, show me/i })).toBeNull();
  });
});
