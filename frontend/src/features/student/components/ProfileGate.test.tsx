import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createQueryClient } from '@/app/queryClient';
import { ProfileGate } from '@/features/student/components/ProfileGate';
import { studentAssessmentApi } from '@/services/assessmentApi';
import type { ProfileOptions, StudentProfile } from '@/types/assessment';

vi.mock('@/services/assessmentApi');

/**
 * The gate is the only thing standing between a student and an app they can use, so the two
 * things worth pinning are the two ways it could be wrong: letting somebody through who has not
 * answered, and holding somebody who *cannot* answer.
 */

const STRAND_ID = '11111111-1111-4111-8111-111111111111';
const GRADE_LEVEL_ID = '22222222-2222-4222-8222-222222222222';

const options: ProfileOptions = {
  grade_levels: [{ id: GRADE_LEVEL_ID, code: 'G12', name: 'Grade 12' }],
  shs_strands: [{ id: STRAND_ID, code: 'ACAD', name: 'Academic', description: null }],
};

function profileWith(overrides: Partial<StudentProfile> = {}): StudentProfile {
  const base: StudentProfile = {
    id: '33333333-3333-4333-8333-333333333333',
    first_name: 'Juan',
    last_name: 'Dela Cruz',
    birthdate: null,
    gender: null,
    grade_level_id: GRADE_LEVEL_ID,
    shs_strand_id: STRAND_ID,
    grade_level: 'Grade 12',
    strand: 'Academic',
    math_grade: null,
    science_grade: null,
    english_grade: null,
    guardian_name: null,
    guardian_contact: null,
    is_complete_for_recommendations: false,
    missing_for_recommendations: ['subject_grades'],
    derived: { grade_level: true, shs_strand: true, class_name: 'Grade 12 STEM A' },
    profiling: {
      is_complete: false,
      missing: [{ field: 'subject_grades', label: 'At least one subject grade' }],
      required_fields: ['shs_strand_id', 'grade_level_id', 'subject_grades'],
    },
  };

  return { ...base, ...overrides };
}

function renderGate(at = '/student') {
  return render(
    <QueryClientProvider client={createQueryClient()}>
      <MemoryRouter initialEntries={[at]}>
        <ProfileGate />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.mocked(studentAssessmentApi.getProfileOptions).mockReset().mockResolvedValue(options);
  vi.mocked(studentAssessmentApi.getProfile).mockReset().mockResolvedValue(profileWith());
  vi.mocked(studentAssessmentApi.updateProfile).mockReset();
});

describe('the profile gate', () => {
  it('asks for the grades, over a page the student cannot reach', async () => {
    renderGate();

    expect(await screen.findByTestId('profile-gate')).toBeInTheDocument();
    expect(screen.getByLabelText('Mathematics')).toBeInTheDocument();
    expect(screen.getByLabelText('Science')).toBeInTheDocument();
    expect(screen.getByLabelText('English')).toBeInTheDocument();

    // No way out: the "X" is gone and Escape is refused.
    expect(screen.queryByRole('button', { name: 'Close' })).not.toBeInTheDocument();
    await userEvent.keyboard('{Escape}');
    expect(screen.getByTestId('profile-gate')).toBeInTheDocument();
  });

  it('stays put when the student submits nothing, and says why', async () => {
    renderGate();
    await screen.findByTestId('profile-gate');

    await userEvent.click(screen.getByRole('button', { name: 'Save and continue' }));

    expect(await screen.findByText('Fill in at least one grade to continue.')).toBeInTheDocument();
    // The empty PATCH is never sent — the server answers it 200 and the gate would simply return.
    expect(studentAssessmentApi.updateProfile).not.toHaveBeenCalled();
  });

  /** The likeliest mistake on this form: a grade written the way other countries write it. */
  it('catches a grade outside 60–100 before the server has to', async () => {
    renderGate();
    await screen.findByTestId('profile-gate');

    await userEvent.type(screen.getByLabelText('Mathematics'), '9.2');
    await userEvent.click(screen.getByRole('button', { name: 'Save and continue' }));

    expect(
      await screen.findByText('Grades run from 60 to 100 — check what you typed.'),
    ).toBeInTheDocument();
    expect(studentAssessmentApi.updateProfile).not.toHaveBeenCalled();
  });

  it('saves the grades and gets out of the way', async () => {
    const saved = profileWith({
      math_grade: '88.00',
      is_complete_for_recommendations: true,
      missing_for_recommendations: [],
      profiling: { is_complete: true, missing: [], required_fields: [] },
    });

    vi.mocked(studentAssessmentApi.updateProfile).mockResolvedValue(saved);

    renderGate();
    await screen.findByTestId('profile-gate');

    await userEvent.type(screen.getByLabelText('Mathematics'), '88');
    await userEvent.click(screen.getByRole('button', { name: 'Save and continue' }));

    await waitFor(() => expect(screen.queryByTestId('profile-gate')).not.toBeInTheDocument());

    expect(studentAssessmentApi.updateProfile).toHaveBeenCalledWith({
      math_grade: 88,
      science_grade: null,
      english_grade: null,
    });
  });

  it('renders nothing at all once the profile is complete', async () => {
    vi.mocked(studentAssessmentApi.getProfile).mockResolvedValue(
      profileWith({
        math_grade: '88.00',
        is_complete_for_recommendations: true,
        missing_for_recommendations: [],
        profiling: { is_complete: true, missing: [], required_fields: [] },
      }),
    );

    renderGate();

    await waitFor(() => expect(studentAssessmentApi.getProfile).toHaveBeenCalled());
    expect(screen.queryByTestId('profile-gate')).not.toBeInTheDocument();
  });

  /**
   * D11's rule, applied to a modal: a gate raised on a failed request would lock a student out of
   * the whole app over a dropped connection.
   */
  it('renders nothing when the profile could not be loaded', async () => {
    vi.mocked(studentAssessmentApi.getProfile).mockRejectedValue(new Error('offline'));

    renderGate();

    await waitFor(() => expect(studentAssessmentApi.getProfile).toHaveBeenCalled());
    expect(screen.queryByTestId('profile-gate')).not.toBeInTheDocument();
  });

  /** Locking somebody out of an attempt in progress would cost them the attempt. */
  it('never appears over the assessment player', async () => {
    renderGate('/student/attempts/aa000000-0000-4000-8000-000000000001');

    await waitFor(() => expect(studentAssessmentApi.getProfile).toHaveBeenCalled());
    expect(screen.queryByTestId('profile-gate')).not.toBeInTheDocument();
  });

  /**
   * A field the class supplies is one the server answers a student's edit to with a 422 — so
   * holding them for it would be an unanswerable question.
   */
  it('names the counselor and lets the student past when the missing field is not theirs', async () => {
    vi.mocked(studentAssessmentApi.getProfile).mockResolvedValue(
      profileWith({
        shs_strand_id: null,
        strand: null,
        math_grade: '88.00',
        missing_for_recommendations: ['strand'],
        profiling: {
          is_complete: false,
          missing: [{ field: 'shs_strand_id', label: 'Academic track / strand' }],
          required_fields: ['shs_strand_id', 'grade_level_id', 'subject_grades'],
        },
      }),
    );

    renderGate();
    await screen.findByTestId('profile-gate');

    expect(screen.getByText(/only your guidance counselor can fill it in/i)).toBeInTheDocument();
    expect(screen.getByText(/Grade 12 STEM A/)).toBeInTheDocument();
    // No select for it — the server would refuse the edit, so the control is not offered.
    expect(screen.queryByLabelText('Strand')).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Continue without it' }));

    await waitFor(() => expect(screen.queryByTestId('profile-gate')).not.toBeInTheDocument());
  });

  it('asks for the strand itself when the class does not supply it', async () => {
    vi.mocked(studentAssessmentApi.getProfile).mockResolvedValue(
      profileWith({
        shs_strand_id: null,
        strand: null,
        math_grade: '88.00',
        derived: { grade_level: true, shs_strand: false, class_name: 'Grade 12 STEM A' },
        missing_for_recommendations: ['strand'],
        profiling: {
          is_complete: false,
          missing: [{ field: 'shs_strand_id', label: 'Academic track / strand' }],
          required_fields: ['shs_strand_id', 'grade_level_id', 'subject_grades'],
        },
      }),
    );

    renderGate();
    await screen.findByTestId('profile-gate');

    expect(await screen.findByLabelText('Strand')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Continue without it' })).not.toBeInTheDocument();
    // Grades are already on file, so it does not ask for them again.
    expect(screen.queryByLabelText('Mathematics')).not.toBeInTheDocument();
  });
});
