import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createQueryClient } from '@/app/queryClient';
import {
  MappingImportPanel,
  readMappingCsv,
} from '@/features/admin/components/MappingImportPanel';
import { catalogApi } from '@/services/catalogApi';
import type { MappingImportPlan } from '@/types/catalog';

vi.mock('@/services/catalogApi');

/**
 * Importing the program → career mapping (backend 2026-09-22): preview first, apply only a clean
 * file, and read columns by header so an export's extra columns do not get in the way.
 */

const PLAN: MappingImportPlan = {
  programs_in_file: 1,
  adds: [{ program_code: 'BSN', career_title: 'Public Health Nurse', relationship: 'related' }],
  removes: [],
  regrades: [],
  unchanged: 3,
  errors: [],
};

const CSV =
  'program_code,program_name,career_title,career_riasec_code,relationship\r\n' +
  'BSN,BS Nursing,Registered Nurse,SIR,direct\r\n' +
  'BSN,BS Nursing,Public Health Nurse,SIE,related\r\n';

function renderPanel() {
  const onDone = vi.fn();

  render(
    <QueryClientProvider client={createQueryClient()}>
      <MappingImportPanel onDone={onDone} />
    </QueryClientProvider>,
  );

  return { user: userEvent.setup(), onDone };
}

async function upload(user: ReturnType<typeof userEvent.setup>, text: string) {
  const input = document.querySelector('input[type="file"]') as HTMLInputElement;

  await user.upload(input, new File([text], 'mapping.csv', { type: 'text/csv' }));
}

describe('readMappingCsv', () => {
  it('reads columns by header name and ignores the extra export columns', () => {
    expect(readMappingCsv(CSV)).toEqual({
      rows: [
        { program_code: 'BSN', career_title: 'Registered Nurse', relationship: 'direct' },
        { program_code: 'BSN', career_title: 'Public Health Nurse', relationship: 'related' },
      ],
    });
  });

  it('refuses a file without the required columns', () => {
    expect(readMappingCsv('code,title\r\nBSN,Nurse\r\n')).toEqual({
      error: expect.stringContaining('program_code and career_title'),
    });
  });
});

describe('MappingImportPanel', () => {
  beforeEach(() => {
    vi.mocked(catalogApi.importMapping).mockReset();
  });

  it('previews the file first, and applies it only when asked', async () => {
    vi.mocked(catalogApi.importMapping).mockResolvedValue(PLAN);

    const { user, onDone } = renderPanel();

    await upload(user, CSV);

    await waitFor(() =>
      expect(catalogApi.importMapping).toHaveBeenCalledWith(expect.any(Array), false),
    );
    expect(await screen.findByText(/1 program in the/i)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /apply 1 changes/i }));

    await waitFor(() =>
      expect(catalogApi.importMapping).toHaveBeenLastCalledWith(expect.any(Array), true),
    );
    await waitFor(() => expect(onDone).toHaveBeenCalled());
  });

  it('will not apply a file with errors', async () => {
    vi.mocked(catalogApi.importMapping).mockResolvedValue({
      ...PLAN,
      errors: [{ line: 3, message: 'No career is titled "Nurce".' }],
    });

    const { user } = renderPanel();

    await upload(user, CSV);

    expect(await screen.findByText(/line 3: no career is titled/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /apply 1 changes/i })).toBeDisabled();
  });
});
