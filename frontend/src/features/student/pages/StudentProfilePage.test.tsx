import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createQueryClient } from '@/app/queryClient';
import { StudentProfilePage } from '@/features/student/pages/StudentProfilePage';
import { studentAssessmentApi } from '@/services/assessmentApi';
import type { ProfileOptions, StudentProfile } from '@/types/assessment';

vi.mock('@/services/assessmentApi');

/**
 * The name card (prompt-driven, 2026-09-20).
 *
 * The rest of this form is covered by the backend's profile suite, which is where the rules
 * actually live. What is worth pinning *here* is the part that is a UI decision rather than a
 * server rule: what the form sends, and what it tells the student before they send it.
 */

const STRAND_ID = '11111111-1111-4111-8111-111111111111';
const GRADE_LEVEL_ID = '22222222-2222-4222-8222-222222222222';

const options: ProfileOptions = {
  grade_levels: [{ id: GRADE_LEVEL_ID, code: 'G12', name: 'Grade 12' }],
  shs_strands: [{ id: STRAND_ID, code: 'ACAD', name: 'Academic', description: null }],
};

function profileWith(overrides: Partial<StudentProfile> = {}): StudentProfile {
  return {
    id: '33333333-3333-4333-8333-333333333333',
    first_name: 'Juan',
    last_name: 'Dela Cruz',
    birthdate: null,
    gender: null,
    grade_level_id: GRADE_LEVEL_ID,
    shs_strand_id: STRAND_ID,
    grade_level: 'Grade 12',
    strand: 'Academic',
    math_grade: '88.00',
    science_grade: null,
    english_grade: null,
    guardian_name: null,
    guardian_contact: null,
    is_complete_for_recommendations: true,
    missing_for_recommendations: [],
    derived: { grade_level: true, shs_strand: true, class_name: 'Grade 12 STEM A' },
    profiling: { is_complete: true, missing: [], required_fields: [] },
    ...overrides,
  };
}

function renderPage() {
  return render(
    <QueryClientProvider client={createQueryClient()}>
      <MemoryRouter>
        <StudentProfilePage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.mocked(studentAssessmentApi.getProfileOptions).mockReset().mockResolvedValue(options);
  vi.mocked(studentAssessmentApi.getProfile).mockReset().mockResolvedValue(profileWith());
  vi.mocked(studentAssessmentApi.updateProfile)
    .mockReset()
    .mockImplementation(async (payload) => profileWith(payload as Partial<StudentProfile>));
});

describe('changing your own name', () => {
  it('sends the corrected name', async () => {
    renderPage();

    const first = await screen.findByLabelText('First name');

    expect(first).toHaveValue('Juan');
    expect(screen.getByLabelText('Last name')).toHaveValue('Dela Cruz');

    await userEvent.clear(first);
    await userEvent.type(first, 'Juana');
    await userEvent.click(screen.getByRole('button', { name: 'Save profile' }));

    await waitFor(() => expect(studentAssessmentApi.updateProfile).toHaveBeenCalled());
    expect(vi.mocked(studentAssessmentApi.updateProfile).mock.calls[0]?.[0]).toMatchObject({
      first_name: 'Juana',
      last_name: 'Dela Cruz',
    });
  });

  /**
   * The form posts every field it renders, so an unchanged name would ride along on every grade
   * edit — and the audit log should record renames, not saves.
   */
  it('leaves the name out of a save that did not change it', async () => {
    renderPage();

    const maths = await screen.findByLabelText('Mathematics');

    await userEvent.clear(maths);
    await userEvent.type(maths, '91');
    await userEvent.click(screen.getByRole('button', { name: 'Save profile' }));

    await waitFor(() => expect(studentAssessmentApi.updateProfile).toHaveBeenCalled());

    const payload = vi.mocked(studentAssessmentApi.updateProfile).mock.calls[0]?.[0] ?? {};

    expect(payload).not.toHaveProperty('first_name');
    expect(payload).not.toHaveProperty('last_name');
    expect(payload).toMatchObject({ math_grade: 91 });
  });

  /** A mononym is a legitimate name (§13.1), and `null` is what says so on the wire. */
  it('sends null rather than an empty string when the last name is cleared', async () => {
    renderPage();

    await userEvent.clear(await screen.findByLabelText('Last name'));
    await userEvent.click(screen.getByRole('button', { name: 'Save profile' }));

    await waitFor(() => expect(studentAssessmentApi.updateProfile).toHaveBeenCalled());
    expect(vi.mocked(studentAssessmentApi.updateProfile).mock.calls[0]?.[0]).toMatchObject({
      last_name: null,
    });
  });

  /**
   * Both consequences, before the save rather than after it. The username line stops a student
   * believing they have just changed how they sign in; the counselor line is the thing they are
   * entitled to know before they act, not to discover afterwards.
   */
  it('says the username does not change and the counselor is told', async () => {
    renderPage();

    await screen.findByLabelText('First name');

    expect(screen.getByText(/Your username stays the same/i)).toBeInTheDocument();
    expect(screen.getByText(/guidance counselor is told/i)).toBeInTheDocument();
  });

  it('renders the server’s field error against the field that caused it', async () => {
    vi.mocked(studentAssessmentApi.updateProfile).mockRejectedValue({
      response: { data: { errors: { first_name: ['Enter your first name.'] } } },
    });

    renderPage();

    await userEvent.clear(await screen.findByLabelText('First name'));
    await userEvent.click(screen.getByRole('button', { name: 'Save profile' }));

    expect(await screen.findByText('Enter your first name.')).toBeInTheDocument();
  });
});
