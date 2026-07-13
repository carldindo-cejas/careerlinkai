import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createQueryClient } from '@/app/queryClient';
import { CareerForm } from '@/features/admin/components/CareerForm';
import { catalogApi } from '@/services/catalogApi';
import type { Career } from '@/types/catalog';

vi.mock('@/services/catalogApi');

function career(overrides: Partial<Career> = {}): Career {
  return {
    id: '44444444-4444-4444-8444-444444444444',
    title: 'Software Engineer',
    description: null,
    salary_range: null,
    employment_outlook: null,
    typical_riasec_code: 'IEC',
    status: 'active',
    created_at: null,
    updated_at: null,
    ...overrides,
  };
}

function renderForm(props: Partial<React.ComponentProps<typeof CareerForm>> = {}) {
  const onSaved = vi.fn();

  render(
    <QueryClientProvider client={createQueryClient()}>
      <CareerForm onSaved={onSaved} onCancel={vi.fn()} {...props} />
    </QueryClientProvider>,
  );

  return { onSaved, user: userEvent.setup() };
}

describe('CareerForm', () => {
  beforeEach(() => {
    vi.mocked(catalogApi.createCareer).mockReset();
    vi.mocked(catalogApi.updateCareer).mockReset();
  });

  it('creates a career with its Holland code', async () => {
    vi.mocked(catalogApi.createCareer).mockResolvedValue(career());

    const { onSaved, user } = renderForm();

    await user.type(screen.getByLabelText(/^title$/i), 'Software Engineer');
    await user.type(screen.getByLabelText(/riasec code/i), 'IEC');
    await user.click(screen.getByRole('button', { name: /add career/i }));

    await waitFor(() => {
      expect(catalogApi.createCareer).toHaveBeenCalledWith({
        title: 'Software Engineer',
        description: undefined,
        salary_range: undefined,
        employment_outlook: undefined,
        typical_riasec_code: 'IEC',
      });
    });

    expect(onSaved).toHaveBeenCalled();
  });

  /**
   * "IEC" is opaque. Echoing it back in words is what lets an admin who knows the career
   * notice they typed the letters in the wrong order — and the order is data: §27 weights
   * the first letter 0.5 and the third 0.2.
   */
  it('spells the Holland code out as the admin types it', async () => {
    const { user } = renderForm();

    await user.type(screen.getByLabelText(/riasec code/i), 'IEC');

    expect(
      screen.getByText('Investigative · Enterprising · Conventional'),
    ).toBeInTheDocument();
  });

  /**
   * The three ways a code can be wrong. Each one would be *misread* by §27 rather than
   * rejected by it — the engine has no way to tell a bad code from a good one — so none of
   * them may reach the server.
   */
  it.each([
    ['IEX', /only the riasec letters/i],
    ['IIE', /cannot appear twice/i],
  ])('refuses to submit the invalid code %s', async (code, expectedMessage) => {
    const { user } = renderForm();

    await user.type(screen.getByLabelText(/^title$/i), 'Some Career');
    await user.type(screen.getByLabelText(/riasec code/i), code);
    await user.click(screen.getByRole('button', { name: /add career/i }));

    expect(await screen.findByText(expectedMessage)).toBeInTheDocument();
    expect(catalogApi.createCareer).not.toHaveBeenCalled();
  });

  /**
   * §27 defines a weight for three positions and no more, so the input is capped at three
   * — a fourth letter would be read at an index with no weight and silently count for
   * nothing.
   */
  it('caps the code at three letters', async () => {
    const { user } = renderForm();

    const input = screen.getByLabelText(/riasec code/i);
    await user.type(input, 'IECS');

    expect(input).toHaveValue('IEC');
  });

  /**
   * A career with no Holland code is a valid catalog entry — it simply cannot be
   * RIASEC-matched. That is null, not "".
   */
  it('sends a null code when the box is left empty', async () => {
    vi.mocked(catalogApi.createCareer).mockResolvedValue(career({ typical_riasec_code: null }));

    const { user } = renderForm();

    await user.type(screen.getByLabelText(/^title$/i), 'Entrepreneur');
    await user.click(screen.getByRole('button', { name: /add career/i }));

    await waitFor(() => {
      expect(catalogApi.createCareer).toHaveBeenCalledWith(
        expect.objectContaining({ typical_riasec_code: null }),
      );
    });
  });
});
