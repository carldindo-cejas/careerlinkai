import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BulkImportPanel } from '@/features/admin/components/BulkImportPanel';
import type { AddressRow, BulkItem, BulkResult } from '@/types/address';

/**
 * The bulk-import staging area. The rules under test are the ones a bad paste would trip: the
 * preview must dedupe within the paste, the confirm gate must be able to stop the write, and only
 * the *checked* rows may be sent.
 */

function result(names: string[]): BulkResult<AddressRow> {
  return {
    created: names.map((name, index) => ({
      id: `id-${index}`,
      code: null,
      name,
      created_at: null,
      updated_at: null,
    })),
    skipped: [],
  };
}

function renderPanel() {
  const onImport = vi.fn<(items: BulkItem[]) => Promise<BulkResult<AddressRow>>>();

  render(<BulkImportPanel noun="region" onImport={onImport} isImporting={false} />);

  return { onImport, user: userEvent.setup() };
}

describe('BulkImportPanel', () => {
  beforeEach(() => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('parses one name per line and dedupes case-insensitively before previewing', async () => {
    const { user } = renderPanel();

    await user.type(
      screen.getByLabelText(/regions to import/i),
      'NCR\n\ncar\nCAR\n  Calabarzon  ',
    );
    await user.click(screen.getByRole('button', { name: /preview/i }));

    // Blank line dropped, "car"/"CAR" collapsed to one, "Calabarzon" trimmed → 3 rows.
    expect(screen.getByText('3 of 3 selected')).toBeInTheDocument();
    expect(screen.getByText('NCR')).toBeInTheDocument();
    expect(screen.getByText('Calabarzon')).toBeInTheDocument();
  });

  it('sends only the checked rows, and only after the confirm gate passes', async () => {
    const { onImport, user } = renderPanel();
    onImport.mockResolvedValue(result(['NCR']));

    await user.type(screen.getByLabelText(/regions to import/i), 'NCR\nCAR');
    await user.click(screen.getByRole('button', { name: /preview/i }));

    // Uncheck CAR — its checkbox is the second in the preview list.
    const checkboxes = screen.getAllByRole('checkbox');
    await user.click(checkboxes[1]!);

    await user.click(screen.getByRole('button', { name: /add 1 region/i }));

    await waitFor(() => {
      expect(onImport).toHaveBeenCalledWith([{ name: 'NCR' }]);
    });
  });

  it('does not import when the confirmation is dismissed', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    const { onImport, user } = renderPanel();

    await user.type(screen.getByLabelText(/regions to import/i), 'NCR');
    await user.click(screen.getByRole('button', { name: /preview/i }));
    await user.click(screen.getByRole('button', { name: /add 1 region/i }));

    expect(onImport).not.toHaveBeenCalled();
  });

  it('disables Add when everything is deselected', async () => {
    const { onImport, user } = renderPanel();

    await user.type(screen.getByLabelText(/regions to import/i), 'NCR\nCAR');
    await user.click(screen.getByRole('button', { name: /preview/i }));
    await user.click(screen.getByRole('button', { name: /deselect all/i }));

    expect(screen.getByRole('button', { name: /add region/i })).toBeDisabled();
    expect(onImport).not.toHaveBeenCalled();
  });

  it('shows a hint and no form when no parent is selected', () => {
    render(
      <BulkImportPanel
        noun="province"
        onImport={vi.fn()}
        isImporting={false}
        disabledHint="Choose a region first"
      />,
    );

    expect(screen.getByText('Choose a region first')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /preview/i })).not.toBeInTheDocument();
  });
});
