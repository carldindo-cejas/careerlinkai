import { Bot, Loader2, MessageSquare, Send, Trash2, User, X } from 'lucide-react';
import { type FormEvent, useEffect, useRef, useState } from 'react';

import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { cn } from '@/components/ui/cn';
import {
  useAskChat,
  useChatTranscript,
  useClearChat,
} from '@/features/student/hooks/useRecommendations';
import { toast } from '@/stores/toastStore';
import type { ChatMessage } from '@/types/recommendation';

/**
 * The recommendations assistant (migration 0019) — a chat panel beside the student's own results.
 *
 * ## What it is allowed to be
 *
 * §3's first principle is that a student is never told "the AI recommends this". Everything in the
 * two columns to the left of this panel is arithmetic (§27) with a stated formula, and this panel
 * does not get to contradict it. So the framing here is deliberate and repeated in the copy: the
 * assistant *explains* results it did not produce.
 *
 * A message with no `ai_request_id` is the deterministic fallback — the server built it from the
 * student's own computed results because the model was unavailable, out of quota, or said something
 * that failed the §34 guardrails. It is labelled, because presenting computed text as a generation
 * (or a generation as computed) is exactly the confusion §29 exists to prevent.
 *
 * ## Layout
 *
 * On `xl` and up it is a sticky right-hand column. Below that it collapses to a floating button
 * that opens a full-height drawer — a 380px chat column beside a card list does not fit a phone,
 * and squeezing it in would cost the recommendations the width they need. The mount is shared, so
 * the transcript does not reset when the viewport crosses the breakpoint.
 */
export function RecommendationChatPanel({ hasRecommendations }: { hasRecommendations: boolean }) {
  const [open, setOpen] = useState(false);

  return (
    <>
      {/* Desktop: a sticky column. `xl` rather than `lg` because the page is already two columns
          of cards, and a third at 1024px leaves all three too narrow to read. */}
      <aside className="hidden xl:block xl:w-[380px] xl:shrink-0">
        <div className="sticky top-6">
          <ChatSurface hasRecommendations={hasRecommendations} className="h-[calc(100vh-6rem)]" />
        </div>
      </aside>

      {/* Below xl: a launcher and a drawer. */}
      <div className="xl:hidden">
        <Button
          className="fixed bottom-5 right-5 z-40 shadow-lg"
          onClick={() => setOpen(true)}
          aria-expanded={open}
        >
          <MessageSquare className="size-4" aria-hidden="true" />
          Ask about my results
        </Button>

        {open ? (
          <div className="fixed inset-0 z-50 flex flex-col bg-black/50" role="dialog" aria-modal="true">
            <button
              type="button"
              className="flex-1"
              aria-label="Close the assistant"
              onClick={() => setOpen(false)}
            />
            <div className="h-[85vh] bg-card">
              <ChatSurface
                hasRecommendations={hasRecommendations}
                className="h-full"
                onClose={() => setOpen(false)}
              />
            </div>
          </div>
        ) : null}
      </div>
    </>
  );
}

function ChatSurface({
  hasRecommendations,
  className,
  onClose,
}: {
  hasRecommendations: boolean;
  className?: string;
  onClose?: () => void;
}) {
  const { data: transcript, isLoading } = useChatTranscript();
  const ask = useAskChat();
  const clear = useClearChat();

  const [draft, setDraft] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);

  const messages = transcript?.messages ?? [];

  // Follow the conversation down as it grows. Depends on the count rather than the array so a
  // re-render that did not add a message does not yank the student away from what they scrolled to.
  //
  // `scrollTo` is feature-detected rather than called: it is absent on elements in jsdom, and — more
  // to the point than the test environment — auto-scrolling is a nicety. A missing method must not
  // take the whole panel down with it, which is exactly what an unguarded call did.
  useEffect(() => {
    const node = scrollRef.current;

    if (node === null) return;

    if (typeof node.scrollTo === 'function') {
      node.scrollTo({ top: node.scrollHeight, behavior: 'smooth' });
    } else {
      node.scrollTop = node.scrollHeight;
    }
  }, [messages.length, ask.isPending]);

  function onSubmit(event: FormEvent) {
    event.preventDefault();

    const message = draft.trim();

    // The double-submit guard, and the same shape as the assessment player's: a disabled button is
    // not enough on its own, because Enter and a click can both arrive before the next render.
    if (message === '' || ask.isPending) return;

    setDraft('');
    ask.mutate(message);
  }

  return (
    <div className={cn('flex flex-col border border-border bg-card', className)}>
      <header className="flex shrink-0 items-start justify-between gap-3 border-b border-border px-4 py-3">
        <div>
          <h2 className="text-sm font-semibold text-foreground">Ask about my results</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Explains your scores — it doesn&apos;t change them.
          </p>
        </div>

        <div className="flex items-center gap-1">
          {messages.length > 0 ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={() =>
                clear.mutate(undefined, {
                  onSuccess: () => toast.info('Conversation cleared.'),
                  onError: () => toast.error('That conversation could not be cleared.'),
                })
              }
              disabled={clear.isPending}
              aria-label="Clear this conversation"
              title="Clear this conversation"
            >
              <Trash2 className="size-4" aria-hidden="true" />
            </Button>
          ) : null}

          {onClose ? (
            <Button variant="ghost" size="sm" onClick={onClose} aria-label="Close the assistant">
              <X className="size-4" aria-hidden="true" />
            </Button>
          ) : null}
        </div>
      </header>

      <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-4">
        {isLoading ? (
          <p className="text-sm text-muted-foreground">Loading your conversation…</p>
        ) : messages.length === 0 ? (
          <EmptyState hasRecommendations={hasRecommendations} onPick={(text) => ask.mutate(text)} />
        ) : (
          <ul className="flex flex-col gap-4">
            {messages.map((message) => (
              <MessageBubble key={message.id} message={message} />
            ))}
          </ul>
        )}

        {ask.isPending ? (
          <p className="mt-4 flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" aria-hidden="true" />
            Thinking…
          </p>
        ) : null}

        {ask.isError ? (
          <Alert tone="danger" className="mt-4">
            {ask.error instanceof Error
              ? ask.error.message
              : 'That message could not be sent. Try again.'}
          </Alert>
        ) : null}
      </div>

      <form onSubmit={onSubmit} className="flex shrink-0 items-end gap-2 border-t border-border p-3">
        <label className="sr-only" htmlFor="chat-message">
          Your question
        </label>
        <textarea
          id="chat-message"
          rows={2}
          value={draft}
          maxLength={1000}
          placeholder="e.g. Why is nursing my top program?"
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            // Enter sends, Shift+Enter is a newline — the convention every chat surface uses.
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              onSubmit(event);
            }
          }}
          className="min-h-[2.75rem] flex-1 resize-none rounded-none border border-input bg-transparent px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
        />
        <Button type="submit" disabled={draft.trim() === '' || ask.isPending} aria-label="Send">
          <Send className="size-4" aria-hidden="true" />
        </Button>
      </form>
    </div>
  );
}

/**
 * The empty state does real work: a blank chat box is an interface that asks the student to
 * already know what it can do. The prompts are the answer to "what can I ask?", and each one is a
 * question this assistant can actually ground in the student's own data.
 */
function EmptyState({
  hasRecommendations,
  onPick,
}: {
  hasRecommendations: boolean;
  onPick: (message: string) => void;
}) {
  if (!hasRecommendations) {
    return (
      <div className="flex flex-col gap-2 text-sm text-muted-foreground">
        <p>
          Once you have finished both assessments your recommendations appear here, and I can talk
          you through them.
        </p>
      </div>
    );
  }

  const suggestions = [
    'Why is this my top career match?',
    'What is the difference between my top two programs?',
    'What subjects should I focus on for these?',
  ];

  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-muted-foreground">
        Ask me anything about your recommendations. I can explain how a score was reached, compare
        two options, or tell you what a program involves.
      </p>
      <ul className="flex flex-col gap-2">
        {suggestions.map((suggestion) => (
          <li key={suggestion}>
            <button
              type="button"
              onClick={() => onPick(suggestion)}
              className="w-full rounded-none border border-border px-3 py-2 text-left text-sm text-foreground/80 transition hover:border-primary"
            >
              {suggestion}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function MessageBubble({ message }: { message: ChatMessage }) {
  const isStudent = message.role === 'user';
  /**
   * The fallback tell. An assistant message with no `ai_request_id` was **not** generated — the
   * server built it from the student's own §27 results because the model could not answer. Saying
   * so is not a disclaimer for its own sake: the whole trust model of this product rests on a
   * student being able to tell a computed fact from a generated sentence.
   */
  const isFallback = !isStudent && message.ai_request_id === null;

  return (
    <li className={cn('flex gap-2.5', isStudent && 'flex-row-reverse')}>
      <span
        className={cn(
          'mt-0.5 flex size-7 shrink-0 items-center justify-center border',
          isStudent ? 'border-primary bg-primary text-primary-foreground' : 'border-border',
        )}
        aria-hidden="true"
      >
        {isStudent ? <User className="size-3.5" /> : <Bot className="size-3.5" />}
      </span>

      <div className={cn('flex max-w-[85%] flex-col gap-1', isStudent && 'items-end')}>
        <span className="sr-only">{isStudent ? 'You said' : 'The assistant said'}</span>
        <div
          className={cn(
            'whitespace-pre-wrap border px-3 py-2 text-sm leading-relaxed',
            isStudent
              ? 'border-primary bg-primary text-primary-foreground'
              : 'border-border bg-muted text-foreground/90',
          )}
        >
          {message.content}
        </div>

        {isFallback ? (
          <p className="text-xs text-muted-foreground">
            From your computed results — the assistant was unavailable.
          </p>
        ) : null}
      </div>
    </li>
  );
}
