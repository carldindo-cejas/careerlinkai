import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createQueryClient } from '@/app/queryClient';
import { JoinCodeCard } from '@/features/counselor/components/JoinCodeCard';
import type { ClassRoom } from '@/types/class';

vi.mock('@/services/classApi');

const classRoom: ClassRoom = {
  id: '33333333-3333-4333-8333-333333333333',
  counselor_id: '11111111-1111-4111-8111-111111111111',
  name: 'Grade 12 STEM A',
  academic_year: '2026-2027',
  grade_level_id: null,
  shs_strand_id: null,
  grade_level: 'Grade 12',
  shs_strand: null,
  join_code: 'HVJE-5977',
  join_code_expires_at: null,
  status: 'active',
  created_at: null,
  updated_at: null,
};

const JOIN_LINK = `${window.location.origin}/join/HVJE-5977`;

function renderCard() {
  const user = userEvent.setup();

  render(
    <QueryClientProvider client={createQueryClient()}>
      <JoinCodeCard classRoom={classRoom} />
    </QueryClientProvider>,
  );

  return user;
}

describe('JoinCodeCard', () => {
  afterEach(() => {
    // Only the share-sheet test installs this; jsdom has no navigator.share of its own.
    Reflect.deleteProperty(navigator, 'share');
  });

  it('shows the join link that carries the class code', () => {
    renderCard();

    expect(screen.getByText(JOIN_LINK.replace(/^https?:\/\//, ''))).toBeInTheDocument();
  });

  it('copies the join link where the device has no share sheet', async () => {
    const user = renderCard();

    await user.click(screen.getByRole('button', { name: /share/i }));

    await expect(navigator.clipboard.readText()).resolves.toBe(JOIN_LINK);
    expect(await screen.findByRole('button', { name: /link copied/i })).toBeInTheDocument();
  });

  it('hands the join link to the device share sheet when there is one', async () => {
    const share = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'share', { value: share, configurable: true });

    const user = renderCard();

    await user.click(screen.getByRole('button', { name: /share/i }));

    expect(share).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ url: JOIN_LINK }));
  });

  it('treats a dismissed share sheet as a change of mind, not a reason to copy', async () => {
    const share = vi.fn().mockRejectedValue(new DOMException('Share canceled', 'AbortError'));
    Object.defineProperty(navigator, 'share', { value: share, configurable: true });

    const user = renderCard();
    await navigator.clipboard.writeText('untouched');

    await user.click(screen.getByRole('button', { name: /share/i }));

    await expect(navigator.clipboard.readText()).resolves.toBe('untouched');
    expect(screen.queryByRole('button', { name: /link copied/i })).not.toBeInTheDocument();
  });
});
