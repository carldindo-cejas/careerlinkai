import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';

import { BackButton } from '@/routes/BackButton';
import { paths } from '@/routes/paths';
import { useAuthStore } from '@/stores/authStore';
import type { User } from '@/types/user';

/**
 * `back.test.ts` pins down *where* the control goes; this pins down the two things that are the
 * component's own and would survive a correct table: that it renders a real link rather than a
 * button, and that "no step back" means nothing in the DOM — wrapper included, since the layouts
 * that place it are flex columns with a gap, and an empty wrapper would still spend one.
 */

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <BackButton className="mb-4" />
    </MemoryRouter>,
  );
}

const staffUser = (overrides: Partial<User> = {}): User => ({
  id: 'usr_1',
  name: 'A Counselor',
  email: 'counselor@example.test',
  role: 'counselor',
  status: 'active',
  must_change_password: false,
  email_verified_at: null,
  last_login_at: null,
  created_at: null,
  ...overrides,
});

describe('BackButton', () => {
  /**
   * A link, not a button: the destination is a real URL, so middle-click and "open in new tab"
   * behave — and a screen reader announces it as a link in the page's link list.
   */
  it('renders a named link to the step above', () => {
    renderAt('/admin/colleges/col_1');

    expect(screen.getByRole('link', { name: /back to colleges/i })).toHaveAttribute(
      'href',
      paths.adminColleges,
    );
  });

  it('renders nothing at all on a screen with no step back', () => {
    const { container } = renderAt(paths.studentDashboard);

    expect(container).toBeEmptyDOMElement();
  });

  /** The forced rotation reads `must_change_password` off the store, not off the path. */
  it('offers no way out while a temporary password is being rotated', () => {
    useAuthStore.setState({ user: staffUser({ must_change_password: true }) });

    const { container } = renderAt(paths.changePassword);

    expect(container).toBeEmptyDOMElement();
  });

  it('steps a voluntary password change back to the signer-in’s own dashboard', () => {
    useAuthStore.setState({ user: staffUser() });

    renderAt(paths.changePassword);

    expect(screen.getByRole('link', { name: /back to dashboard/i })).toHaveAttribute(
      'href',
      paths.counselorDashboard,
    );
  });
});
