import '@testing-library/jest-dom/vitest';

import { configure } from '@testing-library/react';
import { afterEach, beforeEach } from 'vitest';

/**
 * This file is the **jsdom** project's setup, and nothing else (`vite.config.ts`).
 *
 * It used to open with two shims — a hand-written `DOMMatrix` and the ES2025
 * `Uint8Array.toHex`/`fromHex` pair — both there so pdf.js could initialise inside jsdom. Its own
 * comment named the exit: *"If a test ever needs real geometry, that test needs a real browser."*
 * That is now true: `extractText.test.ts` runs in real Chrome, it was the only consumer of either
 * shim, and both are deleted rather than kept warm for a caller that no longer exists.
 *
 * The rule that replaced them: a gap in the *runner* is a reason to pick a runner that has the
 * API, not a reason to write one. Faking a browser well enough to load a browser library is how
 * this suite ended up green locally and hung in CI for sixteen days.
 */

import { useAuthStore } from '@/stores/authStore';
import { useStudentClassStore } from '@/stores/studentClassStore';

/**
 * **The budget every `findBy*` and `waitFor` in this suite actually runs on — 1,000 ms by default,
 * and the reason a test failed once in nine runs and nobody could name it.**
 *
 * `vite.config.ts` raised `testTimeout` 5 s → 15 s (P3-3) precisely to survive a loaded machine,
 * after four tests timed out — three of them in files that change did not touch. That raise was the
 * right instinct at the wrong layer: **`testTimeout` and testing-library's `asyncUtilTimeout` are
 * independent budgets**, and a query that gives up after one second fails long before a fifteen
 * second test budget is in any danger. Every one of the ~dozens of `findBy*` calls in this suite
 * kept its original one-second ceiling, so the exposure P3-3 set out to close was never closed —
 * it was only made invisible in the aggregate.
 *
 * Measured, not assumed. Running this suite under continuous backend-suite load reproduced it on
 * the **first** run: `CanonicalProgramPage — merge target picker › finds a merge target that is not
 * on the current page` failed after **1,481 ms** on `Unable to find role="button" and name
 * /merge bscs/i`, with the page shell rendered and the table not yet populated. There is no timer
 * and no debounce on that path — a mocked promise, React Query, and a jsdom render, losing to CPU
 * contention alone.
 *
 * 5 s, chosen against both neighbours rather than picked round: ~3.4× the observed loss, so ordinary
 * contention cannot reach it, and still 3× **under** `testTimeout`, so a genuinely stuck query
 * fails with testing-library's "Unable to find …" and its DOM dump — which names the problem —
 * instead of an opaque test timeout, which does not. It is a budget for the *runner*, not a
 * weakened assertion: a query that will never match still fails, five seconds later than it did.
 */
configure({ asyncUtilTimeout: 5_000 });

// Auth state is global and persisted, so it must be reset between tests or a signed-in
// user leaks from one test into the next.
beforeEach(() => {
  window.localStorage.clear();
  useAuthStore.setState({ token: null, user: null });
  useStudentClassStore.setState({ classRoom: null, username: null });
});

afterEach(() => {
  window.localStorage.clear();
});
