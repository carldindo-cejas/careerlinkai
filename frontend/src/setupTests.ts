import '@testing-library/jest-dom/vitest';

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
