import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitForElementToBeRemoved } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createQueryClient } from '@/app/queryClient';
import { ProfilingBanner } from '@/features/student/components/ProfilingBanner';
import { studentAssessmentApi } from '@/services/assessmentApi';
import { paths } from '@/routes/paths';
import type { StudentProfile } from '@/types/assessment';

vi.mock('@/services/assessmentApi');

/**
 * The persistent profiling warning (v1.6).
 *
 * The requirement it exists for is a behaviour, not a component: the banner must **disappear on its
 * own** once profiling is complete. So the tests below are about what makes that true — it is
 * rendered from the server's `profiling.is_complete` and nothing else. There is no dismiss button
 * and no remembered dismissal, deliberately: a warning a student can silence while the thing it
 * warns about is still broken is a warning that has stopped meaning anything.
 */

function profile(overrides: Partial<StudentProfile> = {}): StudentProfile {
  return {
    id: 'pr000000-0000-4000-8000-000000000001',
    first_name: 'Juan',
    last_name: 'Dela Cruz',
    birthdate: null,
    gender: null,
    grade_level: null,
    strand: null,
    gwa: null,
    math_grade: null,
    science_grade: null,
    english_grade: null,
    guardian_name: null,
    guardian_contact: null,
    is_complete_for_recommendations: false,
    missing_for_recommendations: ['strand', 'gwa'],
    profiling: {
      is_complete: false,
      missing: [
        { field: 'strand', label: 'Academic track / strand' },
        { field: 'grade_level', label: 'Grade level' },
        { field: 'gwa', label: 'General weighted average' },
      ],
      required_fields: ['strand', 'grade_level', 'gwa'],
    },
    ...overrides,
  };
}

function renderBanner(initialPath: string = paths.studentDashboard) {
  return render(
    <QueryClientProvider client={createQueryClient()}>
      <MemoryRouter initialEntries={[initialPath]}>
        <ProfilingBanner />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.mocked(studentAssessmentApi).getProfile = vi.fn();
});

describe('ProfilingBanner', () => {
  it('warns, names the missing fields, and offers a way to fix them', async () => {
    vi.mocked(studentAssessmentApi.getProfile).mockResolvedValue(profile());

    renderBanner();

    expect(
      await screen.findByText(/complete your profile to get recommendations/i),
    ).toBeInTheDocument();

    // The labels come from the server, so the banner cannot describe a different rule from the one
    // that decides completeness.
    expect(screen.getByText(/academic track \/ strand/i)).toBeInTheDocument();
    expect(screen.getByText(/general weighted average/i)).toBeInTheDocument();

    expect(screen.getByRole('button', { name: /complete profile/i })).toBeInTheDocument();
  });

  /** The requirement in one assertion: complete profiling means no banner, with nothing dismissed. */
  it('renders nothing once profiling is complete', async () => {
    vi.mocked(studentAssessmentApi.getProfile).mockResolvedValue(
      profile({
        grade_level: 'Grade 12',
        strand: 'Academic',
        gwa: '88.00',
        is_complete_for_recommendations: true,
        missing_for_recommendations: [],
        profiling: {
          is_complete: true,
          missing: [],
          required_fields: ['strand', 'grade_level', 'gwa'],
        },
      }),
    );

    const { container } = renderBanner();

    // Nothing appears at any point — not "appears then vanishes".
    await Promise.resolve();
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByTestId('profiling-banner')).not.toBeInTheDocument();
  });

  /**
   * `StudentProfilePage` refuses to render its form when the profile cannot be read (D11), so a
   * banner pointing there would be sending the student to an error. Silence is the honest state.
   */
  it('renders nothing while the profile is unavailable', async () => {
    vi.mocked(studentAssessmentApi.getProfile).mockRejectedValue(new Error('offline'));

    const { container } = renderBanner();

    await Promise.resolve();
    expect(container).toBeEmptyDOMElement();
  });

  /** On the profile page the button would point at the screen it is sitting on. */
  it('keeps the warning but drops the button on the profile page itself', async () => {
    vi.mocked(studentAssessmentApi.getProfile).mockResolvedValue(profile());

    renderBanner(paths.studentProfile);

    expect(
      await screen.findByText(/complete your profile to get recommendations/i),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /complete profile/i })).not.toBeInTheDocument();
  });

  /**
   * The banner's disappearance is driven by the **query**, not by a prop, so this drives it the way
   * the app does: `StudentProfilePage` invalidates the profile query on save, and the refetch
   * answers differently. Sharing one client across the two renders is what makes that reachable —
   * a fresh client would be testing a remount instead.
   */
  it('disappears once the profile is saved as complete', async () => {
    const getProfile = vi.mocked(studentAssessmentApi.getProfile);
    const queryClient = createQueryClient();

    getProfile.mockResolvedValue(profile());

    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={[paths.studentDashboard]}>
          <ProfilingBanner />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    expect(await screen.findByTestId('profiling-banner')).toBeInTheDocument();

    getProfile.mockResolvedValue(
      profile({
        profiling: {
          is_complete: true,
          missing: [],
          required_fields: ['strand', 'grade_level', 'gwa'],
        },
      }),
    );

    await queryClient.invalidateQueries();

    await waitForElementToBeRemoved(() => screen.queryByTestId('profiling-banner'));
  });
});
