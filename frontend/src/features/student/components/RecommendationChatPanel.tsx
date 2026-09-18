import { Bot, Loader2, Send, Trash2, User, X } from 'lucide-react';
import {
  type CSSProperties,
  type FormEvent,
  type RefObject,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';

import chatLogoUrl from '@/assets/careerlinkai_logo-256.png';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { cn } from '@/components/ui/cn';
import {
  useAskChat,
  useChatTranscript,
  useClearChat,
  useFlagAnswer,
  useRequestKnowledge,
} from '@/features/student/hooks/useRecommendations';
import { useStudentBrief } from '@/features/student/hooks/useStudentBrief';
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
 * ## What is under each answer
 *
 * Nothing, unless the student can do something about it. The panel used to print a provenance
 * notice under every turn — *"not written by the AI"*, *"Based on: …"* — which was true and, four
 * exchanges into a conversation about somebody's future, was most of the screen. Provenance is
 * still recorded on every message and is what the admin review screens read; it is simply not
 * furniture in a student's conversation any more. `MessageBubble` is where that decision lives.
 *
 * The two controls that remain are both actions: **This answer looks wrong** on a generated
 * answer, and **Request to add to knowledge** on a refusal for want of coverage.
 *
 * ## Layout
 *
 * On `xl` and up it is a sticky right-hand column. Below that it collapses to a floating logo
 * button that opens a full-height drawer — a 380px chat column beside a card list does not fit a
 * phone, and squeezing it in would cost the recommendations the width they need. The mount is
 * shared, so the transcript does not reset when the viewport crosses the breakpoint.
 *
 * The floating trigger is `ChatLauncherButton`, the same 48px mark the rest of the student shell
 * uses (prompt §9).
 */
export function RecommendationChatPanel({ hasRecommendations }: { hasRecommendations: boolean }) {
  const [open, setOpen] = useState(false);
  const asideRef = useRef<HTMLElement>(null);
  const height = useViewportFill(asideRef);

  return (
    <>
      {/* Desktop: a sticky column. `xl` rather than `lg` because the page is already two columns
          of cards, and a third at 1024px leaves all three too narrow to read. */}
      {/* `self-stretch` is load-bearing: the row is `items-start`, which sizes this column to its
          own content and leaves the sticky child no range to travel in — the panel would scroll
          away with the cards. Stretching the column to the full row height gives it that range.
          `top-[4.5rem]` clears the shell's own sticky top bar. */}
      <aside ref={asideRef} className="hidden xl:block xl:w-[380px] xl:shrink-0 xl:self-stretch">
        <div className="sticky top-[4.5rem]">
          <ChatSurface
            hasRecommendations={hasRecommendations}
            className={height === null ? 'h-[calc(100vh-10rem)]' : undefined}
            style={height === null ? undefined : { height }}
          />
        </div>
      </aside>

      {/* Below xl: a launcher and a drawer. */}
      <div className="xl:hidden">
        <ChatLauncherButton open={open} onOpen={() => setOpen(true)} />

        {open ? (
          <div
            className="fixed inset-0 z-50 flex flex-col bg-black/50"
            role="dialog"
            aria-modal="true"
            // A dialog with no name is announced as "dialog" and nothing else. Escape closes it
            // because a modal that can only be dismissed by finding the X is a trap for anyone
            // navigating by keyboard.
            aria-label="Ask about my results"
            onKeyDown={(event) => {
              if (event.key === 'Escape') setOpen(false);
            }}
          >
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

/**
 * The assistant on every other student page (AI-COVERAGE-PLAN.md Phase 4).
 *
 * 38 of the first 58 production questions came from students who had not finished both
 * assessments — and the only place the assistant existed was the recommendations page. This is the
 * same conversation, opened from a button on the dashboard, assessments and results pages. The
 * recommendations page keeps its column and does not render this.
 *
 * A bottom sheet on a phone, a right-hand drawer from `sm` up.
 */
export function StudentChatLauncher() {
  const [open, setOpen] = useState(false);
  const brief = useStudentBrief();
  const hasRecommendations = brief.data?.has_recommendations ?? false;

  return (
    <>
      <ChatLauncherButton open={open} onOpen={() => setOpen(true)} />

      {open ? (
        <div
          className="fixed inset-0 z-50 flex flex-col bg-black/50 sm:flex-row"
          role="dialog"
          aria-modal="true"
          aria-label="Ask CareerLinkAI"
          onKeyDown={(event) => {
            if (event.key === 'Escape') setOpen(false);
          }}
        >
          <button
            type="button"
            className="flex-1"
            aria-label="Close the assistant"
            onClick={() => setOpen(false)}
          />
          <div className="h-[85vh] bg-card sm:h-full sm:w-105">
            <ChatSurface
              hasRecommendations={hasRecommendations}
              className="h-full"
              onClose={() => setOpen(false)}
            />
          </div>
        </div>
      ) : null}
    </>
  );
}

/**
 * **The trigger: the CareerLinkAI mark, and almost nothing else** (prompt §9).
 *
 * It was a full-width primary button reading "Ask CareerLinkAI", pinned bottom-right — about 190×40
 * of filled steel sitting permanently over the dashboard. On a 360 px phone that is a slab across
 * the bottom of every student screen, and it covered the last card in whatever list was underneath.
 *
 * Now it is a 48 px circle carrying the logo. The reasoning behind each decision:
 *
 *   * **The mark, not a generic speech bubble.** The product's own identity is what says *which*
 *     assistant this is, and it is already the mark on the sign-in page, the shell and the landing
 *     page. A `MessageSquare` icon would have said "a chat" and named nobody.
 *   * **48 px, which is above the 44 px touch minimum** — smaller would have traded one usability
 *     problem for another.
 *   * **The name is not gone, it moved.** `aria-label` and `title` both carry "Ask CareerLinkAI",
 *     so a screen reader announces the same sentence the button used to print, a hover says it, and
 *     an `sm`-and-up tooltip renders it beside the mark. An icon-only control with no accessible
 *     name is unusable, which is the failure mode this change has to avoid.
 *   * **Bottom-right, above the safe-area inset**, clear of the iOS home indicator — and small
 *     enough that what it now overlaps is page padding rather than content.
 *
 * Shared by both launchers, so the trigger cannot drift between the recommendations page and the
 * rest of the student shell.
 */
function ChatLauncherButton({ open, onOpen }: { open: boolean; onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-expanded={open}
      aria-haspopup="dialog"
      aria-label="Ask CareerLinkAI"
      title="Ask CareerLinkAI"
      className={cn(
        'group fixed z-40 flex size-12 items-center justify-center rounded-full',
        'border border-border bg-card shadow-lg transition',
        'hover:border-primary hover:shadow-xl',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
        // `max(1.25rem, …)` so it clears the home indicator on a phone and sits at a normal inset
        // everywhere else.
        'bottom-[max(1.25rem,env(safe-area-inset-bottom))] right-5',
      )}
    >
      <img src={chatLogoUrl} alt="" aria-hidden="true" className="size-8 object-contain" />
      {/*
        The label, on hover and focus, from `sm` up. `pointer-events-none` so it can never sit
        between a pointer and the button it describes; hidden below `sm` because a tooltip anchored
        to the right edge of a 320 px screen has nowhere to go.
      */}
      <span
        className={cn(
          'pointer-events-none absolute right-full mr-3 hidden whitespace-nowrap rounded-none',
          'border border-border bg-card px-2 py-1 text-xs text-foreground/80 opacity-0 transition-opacity',
          'group-hover:opacity-100 group-focus-visible:opacity-100 sm:block',
        )}
        aria-hidden="true"
      >
        Ask CareerLinkAI
      </span>
    </button>
  );
}

/** The main column's bottom padding (`sm:p-6`) — the chat ends there, not at the window's edge. */
const PAGE_BOTTOM_GAP = 24;
/** Below this the transcript is too short to read; a short window scrolls instead. */
const MIN_HEIGHT = 384;

/**
 * The chat's height: from where its column starts to the bottom of the window.
 *
 * It was a fixed `100vh - 6rem`, which ignored everything above the column — the back link, the
 * page padding, the profiling banner — so the column ran past the window and dragged the page into
 * a scroll of blank space under a short list. Measured instead, the page is exactly as tall as its
 * content. Re-measured on resize and whenever the page above it changes height (the banner
 * arriving once the profile loads).
 */
function useViewportFill(ref: RefObject<HTMLElement | null>): number | null {
  const [height, setHeight] = useState<number | null>(null);

  useLayoutEffect(() => {
    const node = ref.current;

    if (node === null) return;

    const measure = () => {
      // Hidden below xl — nothing to size, and a zero-height box would measure as the top.
      if (node.offsetParent === null) return;

      const top = node.getBoundingClientRect().top + window.scrollY;

      setHeight(Math.max(MIN_HEIGHT, Math.floor(window.innerHeight - top - PAGE_BOTTOM_GAP)));
    };

    measure();
    window.addEventListener('resize', measure);

    const observer =
      typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : null;
    const main = node.closest('main');

    if (observer && main?.parentElement) observer.observe(main.parentElement);

    return () => {
      window.removeEventListener('resize', measure);
      observer?.disconnect();
    };
  }, [ref]);

  return height;
}

function ChatSurface({
  hasRecommendations,
  className,
  style,
  onClose,
}: {
  hasRecommendations: boolean;
  className?: string | undefined;
  style?: CSSProperties | undefined;
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
    <div className={cn('flex flex-col border border-border bg-card', className)} style={style}>
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

      {/*
        `role="log"` — a transcript that grows at the bottom, which is precisely what the role
        describes, and it carries an implicit polite live region. Without it an assistant reply
        arrives in total silence: the student sends a question, the panel scrolls itself, and
        nothing tells them the answer is there. It sits on this container rather than on the `<ul>`
        inside it because the `<ul>` does not exist until the first message lands, and a live
        region that is *mounted* holding content announces nothing.
      */}
      <div
        ref={scrollRef}
        role="log"
        aria-label="Conversation"
        className="flex-1 overflow-y-auto px-4 py-4"
      >
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
  // Starter questions come from the Student Brief (AI-COVERAGE-PLAN.md Phase 4): each one is
  // answered from the catalog or the student's own results, with no model call. A student with no
  // recommendations still gets questions — catalog questions do not depend on their results.
  const brief = useStudentBrief();
  const suggestions =
    brief.data?.suggestions ??
    (hasRecommendations
      ? ['What are my top 5 careers?', 'Which of my top careers pays the best?', 'What can you do?']
      : ['What can you do?', 'What colleges are in Bohol?']);

  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-muted-foreground">
        {hasRecommendations
          ? 'Ask me anything about your recommendations. I can explain how a score was reached, compare two options, or tell you what a program involves.'
          : 'Ask me about colleges, programs and careers in Bohol. Once you finish both assessments, I can explain your recommendations too.'}
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
  const flag = useFlagAnswer();
  const requestKnowledge = useRequestKnowledge();
  const isStudent = message.role === 'user';

  /**
   * ## What sits under an answer, and what no longer does
   *
   * Two notices used to: *"A standard reply from CareerLinkAI — not written by the AI"* on any
   * un-generated reply, and *"Based on: …"* naming the entries a sourced answer cited. Both were
   * true, and both were provenance metadata printed under every single turn of a conversation a
   * student is having about their own future. Four exchanges in, the panel was more footnote than
   * answer. The provenance has not gone anywhere — `ai_request_id`, `sources` and the chunk trail
   * are all still on the row, and the admin screens that act on them read the row, not this panel.
   *
   * What is left is the one line a student can *act* on, which is the only thing that earned a
   * permanent place under an answer:
   *
   *   - a generated answer gets **This answer looks wrong** — a report that leads an admin
   *     straight to the passage that produced it;
   *   - a no-coverage refusal gets **Request to add to knowledge**, which is new (migration 0030)
   *     and is the missing half of that refusal. The assistant already says "ask your counselor,
   *     and they can add it here for next time"; this is the student saying yes without having to
   *     go and find one.
   *
   * Nothing else — a Gate 1 answer in an admin's own words, an off-domain redirect, the
   * deterministic fallback — carries a control, because there is nothing for the student to do
   * about any of them.
   */
  const isGenerated = !isStudent && message.ai_request_id !== null;
  const canRequestKnowledge = !isStudent && message.knowledge_request === 'OFFERED';
  const hasRequestedKnowledge = !isStudent && message.knowledge_request === 'REQUESTED';

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

        {/*
          Where a looked-up or grounded answer came from (AI-COVERAGE-PLAN.md Phase 4) — one short
          line, only when a source is named and the answer kind was recorded, so a refusal and every
          message written before answer kinds existed stay as they were.
        */}
        {!isStudent && message.sources.length > 0 && message.answer_kind ? (
          <p className="text-xs text-muted-foreground">From: {message.sources.join(' · ')}</p>
        ) : null}

        {/*
          Reporting a wrong answer (Phase 4). Offered only on generated answers: the flag's value is
          the chunk trail on the answer's `ai_requests` row — an admin follows it to the passage
          that produced it — and a reply with no such row would file a review item into a queue
          built around a join that cannot find it.

          One direction only, and it does not undo. An item that can vanish before anyone looks at
          it is worse than a stale one.
        */}
        {isGenerated ? (
          message.feedback === 'DOWN' ? (
            <p className="text-xs text-muted-foreground">
              Reported — a counselor will look at this.
            </p>
          ) : (
            <button
              type="button"
              className="self-start text-xs text-muted-foreground underline-offset-4 hover:underline focus-visible:underline focus-visible:outline-none"
              disabled={flag.isPending}
              onClick={() => flag.mutate(message.id)}
            >
              This answer looks wrong
            </button>
          )
        ) : null}

        {/*
          The refusal's second half (migration 0030). The question is already in the admin's
          backlog — every one of these refusals logged it — so this is not what records it. It is
          the student saying the gap matters to them, which is what lifts it above the questions
          the retrieval merely missed.
        */}
        {/*
          Migration 0033: the other end of that request. Before it, "Requested" was the last thing a
          student ever heard — the answer could be written the same afternoon and nothing here would
          change. Now the line says so (and the bell carries a notification), because a request that
          is acted on silently looks, from this side, exactly like one that was ignored.
        */}
        {hasRequestedKnowledge && message.knowledge_answered_at ? (
          <p className="text-xs font-medium text-foreground">
            Answered — ask your question again to see it.
          </p>
        ) : hasRequestedKnowledge ? (
          <p className="text-xs text-muted-foreground">
            Requested — your school has been asked to answer this.
          </p>
        ) : canRequestKnowledge ? (
          <button
            type="button"
            className="self-start text-xs text-muted-foreground underline-offset-4 hover:underline focus-visible:underline focus-visible:outline-none"
            disabled={requestKnowledge.isPending}
            onClick={() => requestKnowledge.mutate(message.id)}
          >
            Request to add to knowledge
          </button>
        ) : null}
      </div>
    </li>
  );
}
