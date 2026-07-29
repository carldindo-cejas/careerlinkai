import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createQueryClient } from '@/app/queryClient';
import { AssessmentManagementPage } from '@/features/assessment-builder/pages/AssessmentManagementPage';
import { assessmentAdminApi } from '@/services/assessmentAdminApi';
import { useAuthStore } from '@/stores/authStore';
import { useToastStore } from '@/stores/toastStore';
import { ApiRequestError } from '@/types/api';
import type { UserRole } from '@/types/user';

vi.mock('@/services/assessmentAdminApi');

/**
 * "Install RIASEC & SCCT" (audit F1, P1-4).
 *
 * F1 was an endpoint no interface could reach — the two curated instruments could only be installed
 * by `curl`, so a fresh deployment had no assessments and no way to get any. The button closed that.
 * These are the tests it shipped without.
 *
 * Two of the four claims below are the ones worth the file:
 *
 *   1. **It is gated on the signed-in user's role, not on the route.** The page is shared by the
 *      admin and counselor shells, so `base` is sitting right there and reads like the obvious
 *      condition — but it is a fact about the URL, not about the caller. An admin browsing the
 *      counselor shell is still an admin and the endpoint still authorizes them. Gating on `base`
 *      would look correct in every screenshot and be wrong for the one person who can use it.
 *   2. **`created: false` is not reported as success.** The call is idempotent, which is what makes
 *      it safe to offer unconditionally — but an admin who pressed a button expecting something to
 *      happen is owed the difference between "installed" and "already there, nothing changed".
 */

function signedInAs(role: UserRole) {
  useAuthStore.setState({
    token: 'test-token',
    user: {
      id: 'user-1',
      name: 'Test User',
      email: 'test@school.ph',
      role,
      status: 'active',
      must_change_password: false,
      email_verified_at: null,
      last_login_at: null,
      created_at: null,
    },
  });
}

const EMPTY_LIST = {
  items: [],
  pagination: { current_page: 1, per_page: 20, total: 0, last_page: 1 },
};

/**
 * `shell` is the route the page is mounted under. It is a parameter rather than a constant because
 * the admin-in-the-counselor-shell case is precisely what claim 1 above is about.
 */
function renderPage(shell: '/admin' | '/counselor' = '/admin') {
  render(
    <QueryClientProvider client={createQueryClient()}>
      <MemoryRouter initialEntries={[`${shell}/assessment-templates`]}>
        <AssessmentManagementPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );

  return userEvent.setup();
}

const installButton = () => screen.findByRole('button', { name: /install riasec & scct/i });

function toasts() {
  return useToastStore.getState().toasts;
}

describe('AssessmentManagementPage — install the curated instruments', () => {
  beforeEach(() => {
    useToastStore.setState({ toasts: [] });

    vi.mocked(assessmentAdminApi.list).mockReset().mockResolvedValue(EMPTY_LIST);
    vi.mocked(assessmentAdminApi.seedInstruments).mockReset();

    // The two taxonomy lookups belong to the create/edit form this page mounts, not to the button
    // under test — but an auto-mock resolves `undefined`, which TanStack rejects loudly on every
    // test. Answered with empty lists so the run stays readable.
    vi.mocked(assessmentAdminApi.listTypes).mockReset().mockResolvedValue([]);
    vi.mocked(assessmentAdminApi.listScorings).mockReset().mockResolvedValue([]);

    signedInAs('admin');
  });

  it('offers the button to an administrator', async () => {
    renderPage();

    expect(await installButton()).toBeInTheDocument();
  });

  it('never offers it to a counselor, who the endpoint would 403', async () => {
    signedInAs('counselor');

    renderPage('/counselor');

    // Waited for rather than asserted immediately: the page resolves its list first, and an
    // assertion that ran before the first paint would pass whatever the gate did.
    expect(await screen.findByRole('heading', { name: 'Assessments' })).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /install riasec & scct/i }),
    ).not.toBeInTheDocument();
  });

  /** The regression this file exists to catch: gating on the route rather than on the role. */
  it('still offers it to an administrator browsing the counselor shell', async () => {
    renderPage('/counselor');

    expect(await installButton()).toBeInTheDocument();
  });

  it('reports a fresh install as news', async () => {
    vi.mocked(assessmentAdminApi.seedInstruments).mockResolvedValue({
      riasecVersionId: 'version-riasec',
      scctVersionId: 'version-scct',
      created: true,
    });

    const user = renderPage();

    await user.click(await installButton());

    await waitFor(() => expect(toasts()).toHaveLength(1));
    expect(toasts()[0]).toMatchObject({ tone: 'success' });
    expect(toasts()[0]?.message).toBe('RIASEC and SCCT installed and published.');
  });

  it('says plainly that nothing changed when they were already installed', async () => {
    vi.mocked(assessmentAdminApi.seedInstruments).mockResolvedValue({
      riasecVersionId: 'version-riasec',
      scctVersionId: 'version-scct',
      created: false,
    });

    const user = renderPage();

    await user.click(await installButton());

    await waitFor(() => expect(toasts()).toHaveLength(1));
    // A toast reading "installed and published" here would be a claim that work was done — and the
    // admin's next move on a fresh deployment depends on knowing which of the two happened.
    expect(toasts()[0]?.message).toBe('RIASEC and SCCT are already installed — nothing changed.');
    expect(toasts()[0]?.message).not.toContain('installed and published');
  });

  it('surfaces the server’s reason when the install fails', async () => {
    vi.mocked(assessmentAdminApi.seedInstruments).mockRejectedValue(
      new ApiRequestError('The instrument bank is locked while a migration runs.', 409),
    );

    const user = renderPage();

    await user.click(await installButton());

    await waitFor(() => expect(toasts()).toHaveLength(1));
    expect(toasts()[0]).toMatchObject({
      tone: 'error',
      message: 'The instrument bank is locked while a migration runs.',
    });

    // The button survives its own failure — this is the screen's only route to the instruments.
    expect(await installButton()).toBeEnabled();
  });
});
