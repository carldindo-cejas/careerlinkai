import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';

import { createQueryClient } from '@/app/queryClient';
import { CURRENT_USER_QUERY_KEY } from '@/features/auth/hooks/useAuth';
import { useAuthTabSync } from '@/features/auth/hooks/useAuthTabSync';
import { AUTH_STORAGE_KEY, useAuthStore } from '@/stores/authStore';
import { STUDENT_CLASS_STORAGE_KEY, useStudentClassStore } from '@/stores/studentClassStore';
import type { User } from '@/types/user';

const admin: User = {
  id: '22222222-2222-4222-8222-222222222222',
  name: 'Ana Reyes',
  email: 'admin@careerlinkai.test',
  role: 'admin',
  status: 'active',
  must_change_password: false,
  email_verified_at: null,
  last_login_at: null,
  created_at: null,
};

/**
 * What another tab does: write storage, and the browser fires `storage` here. jsdom (like a real
 * browser) never fires it in the tab that wrote, so the event is dispatched by hand.
 */
function anotherTabWrites(key: string | null, value?: unknown) {
  if (key && value !== undefined) {
    window.localStorage.setItem(key, JSON.stringify({ state: value, version: 0 }));
  }
  window.dispatchEvent(new StorageEvent('storage', { key }));
}

function mountSignedInAsAdmin() {
  const queryClient = createQueryClient();
  useAuthStore.setState({ token: 'admin-token', user: admin });
  queryClient.setQueryData(CURRENT_USER_QUERY_KEY, admin);
  renderHook(() => useAuthTabSync(queryClient));

  return queryClient;
}

describe('useAuthTabSync', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('adopts a sign-in from another tab and forgets everything fetched as the previous user', () => {
    const queryClient = mountSignedInAsAdmin();

    anotherTabWrites(AUTH_STORAGE_KEY, { token: 'student-token' });

    expect(useAuthStore.getState().token).toBe('student-token');
    expect(useAuthStore.getState().user).toBeNull();
    expect(queryClient.getQueryData(CURRENT_USER_QUERY_KEY)).toBeUndefined();
  });

  it('follows a sign-out in another tab', () => {
    mountSignedInAsAdmin();

    anotherTabWrites(AUTH_STORAGE_KEY, { token: null });

    expect(useAuthStore.getState().token).toBeNull();
  });

  it('signs out when another tab clears storage wholesale', () => {
    mountSignedInAsAdmin();

    window.localStorage.clear();
    anotherTabWrites(null);

    expect(useAuthStore.getState().token).toBeNull();
  });

  it('leaves the session alone when the token did not change or another key did', () => {
    const queryClient = mountSignedInAsAdmin();

    anotherTabWrites(AUTH_STORAGE_KEY, { token: 'admin-token' });
    anotherTabWrites('some-other-app.key', { anything: true });

    expect(useAuthStore.getState().user).toEqual(admin);
    expect(queryClient.getQueryData(CURRENT_USER_QUERY_KEY)).toEqual(admin);
  });

  it('picks up the class another tab joined', async () => {
    mountSignedInAsAdmin();
    const classRoom = { id: 'c1', name: 'Grade 12 — Rizal', academic_year: '2026-2027', grade_level: '12' };

    anotherTabWrites(STUDENT_CLASS_STORAGE_KEY, { classRoom, username: 'juan.delacruz' });

    await expect.poll(() => useStudentClassStore.getState().classRoom).toEqual(classRoom);
    expect(useStudentClassStore.getState().username).toBe('juan.delacruz');
  });
});
