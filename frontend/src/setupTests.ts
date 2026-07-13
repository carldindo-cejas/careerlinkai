import '@testing-library/jest-dom/vitest';

import { afterEach, beforeEach } from 'vitest';

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
