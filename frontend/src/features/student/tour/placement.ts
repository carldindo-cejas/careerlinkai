/**
 * Where the tour card goes, given what it is pointing at.
 *
 * Pure arithmetic, in a file of its own, because it is the part that is easy to get subtly wrong
 * and impossible to notice in a browser you happen to have open at one size. Every rule below
 * exists to prevent one specific bad outcome, and each is pinned by a test.
 */

export interface Box {
  top: number;
  left: number;
  width: number;
  height: number;
}

export interface Viewport {
  width: number;
  height: number;
}

export interface Placement {
  top: number;
  left: number;
  /** Which side of the anchor the card ended up on — the arrow, and the tests, read this. */
  side: 'below' | 'above' | 'beside' | 'centre';
}

/** Breathing room between the card and the thing it points at. */
export const GAP = 14;
/** The card never touches an edge; on a phone this is also the page's own side gutter. */
export const MARGIN = 16;
/** Below this the screen is too narrow to place a card beside anything — it gets pinned instead. */
export const NARROW = 640;

/**
 * Place the card against an anchor, or centre it when there is nothing to point at.
 *
 * The order of preference is **below, then above, then centred**, and it is not symmetric on
 * purpose: reading order runs downwards, so a card under the thing it describes is read second,
 * which is the order the student needs. Above is the fallback for an anchor near the bottom of the
 * window — the print button on a short results page, most often.
 *
 * Centred is not a failure state. It is what a stop with no anchor gets (the opening and closing
 * cards), and what a stop whose element is genuinely not on the page gets — a student with no
 * results still needs to be told where results will appear.
 */
export function placeCard(
  anchor: Box | null,
  card: { width: number; height: number },
  viewport: Viewport,
): Placement {
  if (anchor === null) {
    return {
      top: clamp((viewport.height - card.height) / 2, MARGIN, viewport.height - card.height - MARGIN),
      left: clamp((viewport.width - card.width) / 2, MARGIN, viewport.width - card.width - MARGIN),
      side: 'centre',
    };
  }

  /*
    On a phone the card is very nearly as wide as the window, so "beside" and "below" are the same
    place and the only real choice is which end of the screen it sits at. Pinning it to the far end
    from the anchor keeps the highlighted element visible, which is the entire point of pointing at
    it — a card centred over its own anchor is a tour that hides what it is describing.
  */
  if (viewport.width < NARROW) {
    const anchorIsHigh = anchor.top + anchor.height / 2 < viewport.height / 2;
    const left = clamp((viewport.width - card.width) / 2, MARGIN, viewport.width - card.width - MARGIN);

    return anchorIsHigh
      ? { top: viewport.height - card.height - MARGIN, left, side: 'below' }
      : { top: MARGIN, left, side: 'above' };
  }

  // Horizontally: centred on the anchor, then pushed back inside the window. A card lined up with
  // a 48px button at the far right of the screen would otherwise hang half off it.
  const left = clamp(
    anchor.left + anchor.width / 2 - card.width / 2,
    MARGIN,
    Math.max(MARGIN, viewport.width - card.width - MARGIN),
  );

  const below = anchor.top + anchor.height + GAP;

  if (below + card.height <= viewport.height - MARGIN) {
    return { top: below, left, side: 'below' };
  }

  const above = anchor.top - GAP - card.height;

  if (above >= MARGIN) {
    return { top: above, left, side: 'above' };
  }

  /*
    Neither above nor below fits, which on a real screen means one thing: the anchor is as tall as
    the window. The sidebar is exactly that, and it is stop two of the tour.

    So try *beside* before giving up. This is the case the first version of this function did not
    have, and the cost of not having it was visible the moment the tour ran: the card fell back to
    the bottom-left and sat on top of the navigation it was describing — a tour pointing at
    something it was itself covering.
  */
  const roomRight = viewport.width - (anchor.left + anchor.width);
  const roomLeft = anchor.left;
  const needed = card.width + GAP + MARGIN;

  if (Math.max(roomRight, roomLeft) >= needed) {
    return {
      // Vertically centred on the anchor rather than on the window: for an anchor that *is* the
      // window this is the same place, and for a merely tall one it points at the right part of it.
      top: clamp(
        anchor.top + anchor.height / 2 - card.height / 2,
        MARGIN,
        Math.max(MARGIN, viewport.height - card.height - MARGIN),
      ),
      left:
        roomRight >= needed
          ? anchor.left + anchor.width + GAP
          : anchor.left - GAP - card.width,
      side: 'beside',
    };
  }

  /*
    Nothing fits anywhere — a small window with a large anchor in the middle of it. The card takes
    the roomier half and the spotlight keeps part of the anchor visible in the other. `side` stays
    honest about it, so nothing draws an arrow to a place it is not pointing.
  */
  const roomAbove = anchor.top;
  const roomBelow = viewport.height - (anchor.top + anchor.height);

  return {
    top:
      roomBelow >= roomAbove
        ? clamp(viewport.height - card.height - MARGIN, MARGIN, viewport.height)
        : MARGIN,
    left,
    side: 'centre',
  };
}

/**
 * The spotlight's hole: the anchor, loosened a little so a highlighted button does not look
 * strangled by its own outline.
 */
export function spotlightBox(anchor: Box, padding = 8): Box {
  return {
    top: anchor.top - padding,
    left: anchor.left - padding,
    width: anchor.width + padding * 2,
    height: anchor.height + padding * 2,
  };
}

/**
 * Whether the anchor is far enough out of view to be worth scrolling to.
 *
 * The threshold is not zero, and that is the point: scrolling the page because an element is four
 * pixels under the fold moves the ground under a student mid-read for no gain. Only an anchor that
 * is substantially off screen earns a scroll.
 */
export function needsScroll(anchor: Box, viewport: Viewport): boolean {
  const visibleTop = Math.max(anchor.top, 0);
  const visibleBottom = Math.min(anchor.top + anchor.height, viewport.height);
  const visible = Math.max(0, visibleBottom - visibleTop);

  return visible < Math.min(anchor.height, viewport.height * 0.5) * 0.9;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
