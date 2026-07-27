import { useCallback, useEffect, useRef, useState } from 'react';

import { useUpdateQuestion } from '@/features/assessment-builder/hooks/useBuilder';
import type { QuestionPatch } from '@/types/builder';

/**
 * Auto-saving a question while the author types (prompt-driven, v1.6).
 *
 * The whole difficulty of a draft auto-save is that the two obvious implementations are both wrong.
 * Saving on every keystroke is a request per character. Saving only on blur loses the work of
 * anyone who closes the tab mid-sentence — which is precisely the person auto-save exists for. So:
 * **debounced, coalesced, and flushed on unmount.**
 *
 *   * **Debounced** (`DEBOUNCE_MS`) — a pause in typing is the signal, not a keystroke.
 *   * **Coalesced** — changes made during the wait merge into one patch, so editing the text and
 *     then toggling Required sends one request carrying both rather than two that race. The merge
 *     is what makes the last write win *per field* instead of per request.
 *   * **Flushed on unmount** — switching to another question, or leaving the page, saves what is
 *     pending immediately. Without this the debounce becomes a way to lose the last edit.
 *
 * `status` is what the UI shows, and it distinguishes three states a single boolean cannot: there
 * are unsaved changes, they are being written, or everything is safe. "Saved" must never appear
 * while a pending patch is still sitting in the timer.
 */

/** Long enough that ordinary typing does not trigger it; short enough to feel automatic. */
export const DEBOUNCE_MS = 800;

export type SaveStatus = 'idle' | 'pending' | 'saving' | 'saved' | 'error';

export interface QuestionAutosave {
  /** Queue a change. Merges into whatever is already waiting. */
  save: (patch: QuestionPatch) => void;
  /** Write anything pending now — used when switching questions, and on unmount. */
  flush: () => void;
  status: SaveStatus;
  error: Error | null;
}

export function useQuestionAutosave(
  versionId: string,
  questionId: string | null,
): QuestionAutosave {
  const update = useUpdateQuestion(versionId);
  const [status, setStatus] = useState<SaveStatus>('idle');
  const [error, setError] = useState<Error | null>(null);

  const pending = useRef<QuestionPatch | null>(null);
  const timer = useRef<number | null>(null);

  /**
   * The mutation in a ref.
   *
   * `useMutation` returns a new object each render, so depending on it directly would rebuild
   * `flush` on every render — and `flush` is in an unmount effect's cleanup, which would then run
   * on every render and fire a save after each keystroke. The ref keeps the callbacks stable while
   * still calling the current mutation.
   */
  const mutate = useRef(update.mutateAsync);
  mutate.current = update.mutateAsync;

  /**
   * `write` takes the question id **explicitly** rather than reading a ref, and that is not a
   * stylistic choice — it is the difference between the flush-on-switch working and silently
   * writing one question's text onto another.
   *
   * A ref assigned during render already holds the *new* id by the time an effect cleanup runs
   * (React assigns during render, then commits, then runs the previous cleanup). So the cleanup
   * that is supposed to save the question being left would address the one being opened. Passing
   * the id down from the effect's own closure captures the right one.
   */
  const write = useCallback(async (id: string | null) => {
    const patch = pending.current;

    if (patch === null || id === null) {
      return;
    }

    // Cleared *before* the request, so an edit made while it is in flight queues a fresh patch
    // rather than being wiped by this one's completion.
    pending.current = null;
    setStatus('saving');

    try {
      await mutate.current({ questionId: id, ...patch });

      // Only claim "saved" if nothing new arrived while this was in flight.
      setStatus(pending.current === null ? 'saved' : 'pending');
      setError(null);
    } catch (cause) {
      setStatus('error');
      setError(cause instanceof Error ? cause : new Error('The change could not be saved.'));

      /**
       * **The failed patch goes back in the queue**, merged *under* anything newer so a later edit
       * to the same field still wins. A dropped patch would mean the editor shows text the server
       * does not have, which is the one outcome auto-save must never produce.
       */
      pending.current = { ...patch, ...(pending.current ?? {}) };
    }
  }, []);

  const flush = useCallback(() => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }

    void write(questionId);
  }, [write, questionId]);

  const save = useCallback(
    (patch: QuestionPatch) => {
      pending.current = { ...(pending.current ?? {}), ...patch };
      setStatus('pending');

      if (timer.current !== null) {
        window.clearTimeout(timer.current);
      }

      timer.current = window.setTimeout(() => {
        timer.current = null;
        void write(questionId);
      }, DEBOUNCE_MS);
    },
    [write, questionId],
  );

  /**
   * Flush when the edited question changes, and on unmount.
   *
   * The effect closes over the `questionId` it was created with, so the cleanup saves the question
   * being *left* rather than the one being opened — see `write`.
   */
  useEffect(() => {
    const editing = questionId;

    return () => {
      if (timer.current !== null) {
        window.clearTimeout(timer.current);
        timer.current = null;
      }

      void write(editing);
    };
  }, [questionId, write]);

  return { save, flush, status, error };
}
