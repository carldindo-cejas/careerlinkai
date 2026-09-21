import { describe, expect, it } from 'vitest';

import { GAP, MARGIN, needsScroll, placeCard, spotlightBox } from './placement';

/**
 * Where the tour card goes. Every case here is a screen the card was capable of falling off.
 */

const LAPTOP = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 780 };
const CARD = { width: 340, height: 200 };

describe('placing the card against something', () => {
  it('puts it under the anchor when there is room, because reading runs downwards', () => {
    const anchor = { top: 120, left: 500, width: 300, height: 80 };
    const placement = placeCard(anchor, CARD, LAPTOP);

    expect(placement.side).toBe('below');
    expect(placement.top).toBe(120 + 80 + GAP);
    // Centred on the anchor: both middles are 650.
    expect(placement.left + CARD.width / 2).toBe(anchor.left + anchor.width / 2);
  });

  it('flips above an anchor near the bottom of the window', () => {
    const anchor = { top: 800, left: 500, width: 300, height: 60 };
    const placement = placeCard(anchor, CARD, LAPTOP);

    expect(placement.side).toBe('above');
    expect(placement.top).toBe(800 - GAP - CARD.height);
  });

  /** A 48px launcher pinned to the right edge — the card lined up on it would hang off. */
  it('pulls the card back inside the window rather than centring it off the edge', () => {
    const anchor = { top: 400, left: 1372, width: 48, height: 48 };
    const placement = placeCard(anchor, CARD, LAPTOP);

    expect(placement.left).toBe(LAPTOP.width - CARD.width - MARGIN);
    expect(placement.left).toBeGreaterThanOrEqual(MARGIN);
  });

  it('does the same on the left edge', () => {
    const anchor = { top: 400, left: 8, width: 48, height: 48 };

    expect(placeCard(anchor, CARD, LAPTOP).left).toBe(MARGIN);
  });

  /**
   * A sidebar is as tall as the window, so neither above nor below can fit. The card has to go
   * *beside* it — the first run of the real tour put it at the bottom left instead, on top of the
   * navigation it was describing.
   */
  it('goes beside an anchor that is as tall as the window', () => {
    const anchor = { top: 0, left: 0, width: 64, height: 900 };
    const placement = placeCard(anchor, CARD, LAPTOP);

    expect(placement.side).toBe('beside');
    expect(placement.left).toBe(64 + GAP);
    // And it does not overlap what it points at, which is the whole point.
    expect(placement.left).toBeGreaterThanOrEqual(anchor.left + anchor.width);
  });

  it('goes beside on the left when the anchor is against the right edge', () => {
    const anchor = { top: 0, left: 1180, width: 260, height: 900 };
    const placement = placeCard(anchor, CARD, LAPTOP);

    expect(placement.side).toBe('beside');
    expect(placement.left + CARD.width).toBeLessThanOrEqual(anchor.left);
  });

  /** Nothing fits anywhere: the card takes the roomier half and stays on screen. */
  it('falls back to a half of the screen when no side has room', () => {
    const anchor = { top: 0, left: 0, width: 1440, height: 900 };
    const placement = placeCard(anchor, CARD, LAPTOP);

    expect(placement.side).toBe('centre');
    expect(placement.top + CARD.height).toBeLessThanOrEqual(LAPTOP.height);
    expect(placement.top).toBeGreaterThanOrEqual(MARGIN);
  });
});

describe('on a phone, where beside and below are the same place', () => {
  const card = { width: PHONE.width - 32, height: 220 };

  it('pins the card to the bottom when the anchor is in the top half', () => {
    const placement = placeCard({ top: 60, left: 16, width: 44, height: 44 }, card, PHONE);

    expect(placement.top).toBe(PHONE.height - card.height - MARGIN);
  });

  it('pins it to the top when the anchor is in the bottom half — so the anchor stays visible', () => {
    const placement = placeCard({ top: 700, left: 320, width: 48, height: 48 }, card, PHONE);

    expect(placement.top).toBe(MARGIN);
  });

  it('never runs off either side', () => {
    const placement = placeCard({ top: 700, left: 320, width: 48, height: 48 }, card, PHONE);

    expect(placement.left).toBeGreaterThanOrEqual(MARGIN);
    expect(placement.left + card.width).toBeLessThanOrEqual(PHONE.width - MARGIN);
  });
});

describe('with nothing to point at', () => {
  /** The opening and closing cards, and any stop whose element is not on the page. */
  it('centres the card', () => {
    const placement = placeCard(null, CARD, LAPTOP);

    expect(placement.side).toBe('centre');
    expect(placement.top).toBe((LAPTOP.height - CARD.height) / 2);
    expect(placement.left).toBe((LAPTOP.width - CARD.width) / 2);
  });

  it('keeps a card taller than the window on screen rather than centring it off the top', () => {
    const placement = placeCard(null, { width: 340, height: 1000 }, LAPTOP);

    expect(placement.top).toBeLessThanOrEqual(MARGIN);
  });
});

describe('the spotlight', () => {
  it('loosens the hole around the anchor so a highlighted button is not strangled', () => {
    expect(spotlightBox({ top: 100, left: 200, width: 48, height: 48 }, 8)).toEqual({
      top: 92,
      left: 192,
      width: 64,
      height: 64,
    });
  });
});

describe('deciding whether to scroll', () => {
  const viewport = { width: 1440, height: 900 };

  it('leaves a fully visible anchor alone', () => {
    expect(needsScroll({ top: 200, left: 0, width: 300, height: 80 }, viewport)).toBe(false);
  });

  it('scrolls to one that is off the bottom', () => {
    expect(needsScroll({ top: 1200, left: 0, width: 300, height: 80 }, viewport)).toBe(true);
  });

  it('scrolls to one that is off the top', () => {
    expect(needsScroll({ top: -200, left: 0, width: 300, height: 80 }, viewport)).toBe(true);
  });

  /**
   * The threshold is not zero on purpose: moving the page because an element is a few pixels under
   * the fold yanks the ground out from under someone mid-read, for nothing.
   */
  it('tolerates an anchor that is barely clipped', () => {
    expect(needsScroll({ top: 830, left: 0, width: 300, height: 76 }, viewport)).toBe(false);
  });

  /** A sidebar taller than the window can never be "fully" visible; that must not loop a scroll. */
  it('does not demand a scroll for an anchor taller than the window', () => {
    expect(needsScroll({ top: 0, left: 0, width: 256, height: 1600 }, viewport)).toBe(false);
  });
});
