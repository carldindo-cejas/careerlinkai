import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createQueryClient } from '@/app/queryClient';
import { ScoringFormulaPage } from '@/features/admin/pages/ScoringFormulaPage';
import { formulaApi } from '@/services/platformApi';
import { ApiRequestError } from '@/types/api';
import type { ScoringFormula, ScoringFormulaResponse } from '@/types/formula';

vi.mock('@/services/platformApi');

/**
 * The §27 formula screen.
 *
 * This is the one admin screen whose mistakes are invisible on the screen itself: every number here
 * is multiplied into a score somebody else reads, days later, on a different page. So the three
 * things asserted are the three that would be silent failures.
 *
 * 1. **The unit conversion.** The screen edits percentages; the engine multiplies by fractions. A
 *    form that posted `60` where the server expected `0.6` would validate cleanly on both sides —
 *    the sum rule would simply be checked against the wrong scale — and then score every student
 *    out of six thousand.
 * 2. **The sum rule.** Weights are shares of one score. A set summing to 90 does not soften the
 *    matches, it rescales the whole system against an "out of 100" label that has become a lie.
 * 3. **That editing does something visible.** An administrator has no other way to tell whether a
 *    weight they typed reached anything at all.
 */

const DEFAULTS: ScoringFormula = {
  career: { riasecCompatibility: 0.6, careerConfidence: 0.3, studentPreference: 0.1 },
  program: {
    riasecCompatibility: 0.35,
    careerAlignment: 0.25,
    careerConfidence: 0.2,
    academicFit: 0.1,
    strandAlignment: 0.1,
  },
  positionWeights: [0.5, 0.3, 0.2],
  careerAlignmentDepth: [0.6, 0.25, 0.15],
  neutrals: {
    studentPreference: 70,
    riasec: 50,
    academicUnknown: 60,
    strandUnknown: 70,
    strandMismatch: 40,
    strandAligned: 100,
  },
  academic: { floor: 75, ceiling: 95 },
  linkWeights: { direct: 1, related: 0.7, conditional: 0.5 },
  topN: 10,
};

function response(overrides: Partial<ScoringFormulaResponse> = {}): ScoringFormulaResponse {
  return {
    formula: structuredClone(DEFAULTS),
    is_default: true,
    updated_at: null,
    updated_by_name: null,
    defaults: structuredClone(DEFAULTS),
    students_with_recommendations: 42,
    ...overrides,
  };
}

async function renderPage(data: ScoringFormulaResponse = response()) {
  vi.mocked(formulaApi.get).mockResolvedValue(data);
  vi.mocked(formulaApi.save).mockResolvedValue(data.formula);

  render(
    <QueryClientProvider client={createQueryClient()}>
      <ScoringFormulaPage />
    </QueryClientProvider>,
  );

  await screen.findByRole('heading', { name: /recommendation formula/i });

  return userEvent.setup();
}

/** The RIASEC field of the career section — the first of the two fields with this label. */
function careerRiasecInput(): HTMLInputElement {
  return screen.getAllByLabelText('RIASEC interest fit')[0] as HTMLInputElement;
}

/** The first card's Save button — every card carries one, and each saves the whole formula. */
function saveButton(): HTMLButtonElement {
  return screen.getAllByRole('button', { name: /save formula/i })[0] as HTMLButtonElement;
}

/** Save, then answer the password prompt that stands in front of every write. */
async function saveWithPassword(user: ReturnType<typeof userEvent.setup>, password = 'Secret123') {
  await user.click(saveButton());
  const dialog = await screen.findByRole('dialog');
  await user.type(within(dialog).getByLabelText('Your password'), password);
  await user.click(within(dialog).getByRole('button', { name: /save formula/i }));
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('reading the formula', () => {
  it('says plainly how many students are not covered by a change', async () => {
    await renderPage();

    // The caveat is the whole reason the count is on the wire: a re-weighting is not retroactive,
    // and an admin who does not know that discovers it from a confused counselor.
    expect(screen.getByText(/42 students are/)).toBeInTheDocument();
  });

  it('marks a customised deployment, and names who changed it', async () => {
    await renderPage(
      response({
        is_default: false,
        updated_by_name: 'Maria Santos',
        updated_at: '2026-09-20T02:00:00.000Z',
      }),
    );

    expect(screen.getByText('Customised')).toBeInTheDocument();
    expect(screen.getByText(/Maria Santos/)).toBeInTheDocument();
  });
});

describe('saving', () => {
  it('sends fractions, not the percentages the screen edits', async () => {
    const user = await renderPage();

    // 60 → 45 in the career section, with the 15 points moved onto SCCT confidence so the set
    // still sums to 100.
    await user.clear(careerRiasecInput());
    await user.type(careerRiasecInput(), '45');
    await user.clear(screen.getAllByLabelText('SCCT career confidence')[0]!);
    await user.type(screen.getAllByLabelText('SCCT career confidence')[0]!, '45');

    await waitFor(() => expect(saveButton()).toBeEnabled());
    await saveWithPassword(user);

    await waitFor(() => expect(formulaApi.save).toHaveBeenCalled());

    const [sent, password] = vi.mocked(formulaApi.save).mock.calls[0]!;

    expect(password).toBe('Secret123');

    expect(sent.career.riasecCompatibility).toBeCloseTo(0.45, 10);
    expect(sent.career.careerConfidence).toBeCloseTo(0.45, 10);
    // Untouched fields travel unchanged rather than being rebuilt from the screen.
    expect(sent.career.studentPreference).toBeCloseTo(0.1, 10);
    expect(sent.neutrals.strandMismatch).toBe(40);
  });

  it('refuses a weight set that does not add up to 100%', async () => {
    const user = await renderPage();

    await user.clear(careerRiasecInput());
    await user.type(careerRiasecInput(), '45');

    // 45 + 30 + 10 = 85. Saving that would quietly rescale every career score in the system.
    await waitFor(() => expect(saveButton()).toBeDisabled());
    expect(screen.getByText(/career match weights must add up to 100%/i)).toBeInTheDocument();
    expect(formulaApi.save).not.toHaveBeenCalled();
  });

  it('balances a broken set back to 100% while keeping its ratios', async () => {
    const user = await renderPage();

    await user.clear(careerRiasecInput());
    await user.type(careerRiasecInput(), '45');

    await user.click((await screen.findAllByRole('button', { name: /balance to 100%/i }))[0]!);

    await waitFor(() => expect(saveButton()).toBeEnabled());
    await saveWithPassword(user);

    await waitFor(() => expect(formulaApi.save).toHaveBeenCalled());
    const sent = vi.mocked(formulaApi.save).mock.calls[0]![0];

    // 45 : 30 : 10 rescaled onto 1 — the administrator's proportions, not a redistribution the
    // screen invented.
    expect(sent.career.riasecCompatibility).toBeCloseTo(45 / 85, 6);
    expect(sent.career.careerConfidence).toBeCloseTo(30 / 85, 6);
    expect(
      sent.career.riasecCompatibility + sent.career.careerConfidence + sent.career.studentPreference,
    ).toBeCloseTo(1, 10);
  });

  it('asks for the password first, and keeps the prompt open when it is wrong', async () => {
    const user = await renderPage();
    vi.mocked(formulaApi.save).mockRejectedValue(
      new ApiRequestError('The given data was invalid.', 422, {
        current_password: ['Your password is incorrect.'],
      }),
    );

    await user.clear(careerRiasecInput());
    await user.type(careerRiasecInput(), '50');
    await user.clear(screen.getAllByLabelText('SCCT career confidence')[0]!);
    await user.type(screen.getAllByLabelText('SCCT career confidence')[0]!, '40');

    await user.click(saveButton());

    // Opening the prompt sends nothing — the password is the gate, not a formality after the fact.
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    expect(formulaApi.save).not.toHaveBeenCalled();

    await user.type(screen.getByLabelText('Your password'), 'WrongPassword1');
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: /save formula/i }));

    expect(await screen.findByText('Your password is incorrect.')).toBeInTheDocument();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('will not save an unchanged formula', async () => {
    await renderPage();

    for (const button of screen.getAllByRole('button', { name: /save formula/i })) {
      expect(button).toBeDisabled();
    }
  });

  it('offers Save in every formula card, and any of them saves the whole formula', async () => {
    const user = await renderPage();

    // Four cards (career, program, academic band, link weights) plus the action bar.
    expect(screen.getAllByRole('button', { name: /save formula/i })).toHaveLength(5);

    const floor = screen.getByLabelText('Floor grade');
    await user.clear(floor);
    await user.type(floor, '70');

    // The academic card's own button, for an edit made in that card.
    const buttons = screen.getAllByRole('button', { name: /save formula/i });
    await user.click(buttons[2]!);
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText('Your password'), 'Secret123');
    await user.click(within(dialog).getByRole('button', { name: /save formula/i }));

    await waitFor(() => expect(formulaApi.save).toHaveBeenCalled());
    const [sent] = vi.mocked(formulaApi.save).mock.calls[0]!;

    expect(sent.academic.floor).toBe(70);
    expect(sent.career.riasecCompatibility).toBeCloseTo(0.6, 10);
  });
});

describe('what the screen leaves out', () => {
  it('does not offer the position, depth or missing-signal settings, nor a worked example', async () => {
    await renderPage();

    for (const heading of [
      /holland code positions/i,
      /career alignment depth/i,
      /when a signal is missing/i,
      /what this does to a score/i,
    ]) {
      expect(screen.queryByRole('heading', { name: heading })).not.toBeInTheDocument();
    }
  });
});
