import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';


import { describe, expect, it } from 'vitest';

import { anchorSelector, stopFor, TOUR, TOUR_STOPS, type TourStopId } from './stops';

/**
 * The stop table, and the handshake it is half of.
 *
 * The assistant answers a navigation question with a destination id and nothing else. If the
 * server knows an id this table does not, the student gets an answer with no button — graceful,
 * and a half-finished feature. The list below is the same one
 * `backend/test/ai/navigation-intent.test.ts` pins from the other side, so a rename that is only
 * done in one place fails on both.
 */

/** Every destination the server can send, from `backend/src/knowledge/student-destinations.ts`. */
const SERVER_DESTINATIONS = [
  'tour',
  'report-download',
  'profile-strand',
  'profile-grades',
  'profile',
  'recommendations',
  'results',
  'assessments',
  'assistant',
  'notifications',
  'sign-out',
  'dashboard',
];

describe('the handshake with the assistant', () => {
  it('can point at every destination the server can name', () => {
    for (const id of SERVER_DESTINATIONS) {
      expect(stopFor(id), id).not.toBeNull();
    }
  });

  /** An id from a newer server build must degrade to a plain answer, never to a crash. */
  it('returns null for an id this build does not know', () => {
    expect(stopFor('scholarships-page')).toBeNull();
    expect(stopFor('')).toBeNull();
  });
});

describe('the welcome tour', () => {
  it('runs the stops in the order a student actually travels', () => {
    expect(TOUR).toEqual([
      'welcome',
      'nav',
      'nav-dashboard',
      'dashboard',
      'nav-assessments',
      'assessments',
      'nav-results',
      'results',
      'report-download',
      'nav-recommendations',
      'recommendations',
      'nav-profile',
      'profile',
      'assistant',
      'finish',
    ]);
  });

  /**
   * A tour is a cost paid before any value has been delivered, so its length is a decision rather
   * than an accident — and this is where the decision gets made. It was ten; it is fifteen since
   * 2026-09-20, when every destination gained a stop pointing at the menu row that reaches it.
   */
  it('stays short enough to finish', () => {
    expect(TOUR.length).toBeLessThanOrEqual(15);
  });

  /**
   * The point of the 2026-09-20 revision: a student is shown *how to get somewhere* immediately
   * before being taken there. A stop that pointed at a menu row and then walked to a different
   * screen would be worse than no stop at all, so the pairing is pinned rather than assumed.
   */
  it('points at the menu row before opening what it reaches', () => {
    const pairs: [TourStopId, TourStopId][] = [
      ['nav-dashboard', 'dashboard'],
      ['nav-assessments', 'assessments'],
      ['nav-results', 'results'],
      ['nav-recommendations', 'recommendations'],
      ['nav-profile', 'profile'],
    ];

    for (const [row, screen] of pairs) {
      expect(TOUR.indexOf(screen), row).toBe(TOUR.indexOf(row) + 1);
    }
  });

  /**
   * A `nav-*` stop stays on whatever screen the student is already standing on — it is about the
   * menu, not about a destination — so the tour never walks backwards to re-show a screen it has
   * left. Reaching a row's stop must therefore never change the route.
   */
  it('never navigates for a menu-row stop', () => {
    let expected = TOUR_STOPS[TOUR[0]!].path;

    for (const id of TOUR) {
      const stop = TOUR_STOPS[id];

      if (id.startsWith('nav-')) {
        expect(stop.path, id).toBe(expected);
      }

      expected = stop.path;
    }
  });

  it('names a real stop at every position', () => {
    for (const id of TOUR) {
      expect(TOUR_STOPS[id], id).toBeDefined();
    }
  });

  /** It opens and closes with a card that points at nothing, so neither depends on page state. */
  it('opens centred and ends on the assistant', () => {
    expect(TOUR_STOPS[TOUR[0]!].anchors).toEqual([]);
    expect(TOUR[TOUR.length - 1]).toBe('finish');
  });
});

describe('every stop', () => {
  const stops = Object.values(TOUR_STOPS);

  it('has its key and its id in step', () => {
    for (const [key, stop] of Object.entries(TOUR_STOPS)) {
      expect(stop.id, key).toBe(key as TourStopId);
    }
  });

  it('lives on a student route', () => {
    for (const stop of stops) {
      expect(stop.path, stop.id).toMatch(/^\/student/);
    }
  });

  /**
   * An anchored stop can find its element missing — no results yet, no recommendations yet — and
   * what it says then is the whole value of the stop for the student it happens to. A stop that
   * points at something must say what to do when it is not there.
   */
  it('explains itself when its element is missing, if it can be', () => {
    const optional: TourStopId[] = ['assessments', 'results', 'report-download', 'recommendations'];

    for (const id of optional) {
      expect(TOUR_STOPS[id].absentNote, id).toBeTruthy();
    }
  });

  /** The copy is read at a glance over a dimmed screen, by a student, in their second language. */
  it('keeps its copy short', () => {
    for (const stop of stops) {
      expect(stop.title.length, stop.id).toBeLessThanOrEqual(40);
      expect(stop.body.length, stop.id).toBeLessThanOrEqual(260);
    }
  });
});

describe('anchors', () => {
  it('builds the selector the markup is written with', () => {
    expect(anchorSelector('result-cards')).toBe('[data-tour="result-cards"]');
  });

  /**
   * The list is ordered by preference and read first-visible-wins, which is how one table serves a
   * sidebar on a laptop and a drawer button on a phone.
   */
  it('lets the navigation stop match either width', () => {
    expect(TOUR_STOPS.nav.anchors).toEqual(['nav', 'nav-mobile']);
  });

  /**
   * Every anchor a stop names is actually written on something.
   *
   * This is the failure the rest of the suite cannot see. A `data-tour` attribute is a string in
   * one file and a string in another, with no type between them — rename the markup and the tour
   * keeps working, silently, pointing at nothing and falling back to a centred card. Nobody
   * notices until a student is watching.
   *
   * A source scan rather than a render, deliberately: the anchors are spread across six pages and
   * the shell, several of them behind data that has to exist first, and mounting all of that to
   * prove a string is present would be a slower test that failed for more reasons than this one.
   */
  it('is written on something, for every anchor a stop names', () => {
    // From the working directory rather than `import.meta.url`: Vitest rewrites module URLs to its
    // own scheme, so this file cannot locate itself on disk, but it always runs from `frontend/`.
    const source = sourceText(join(process.cwd(), 'src'));
    const named = new Set(Object.values(TOUR_STOPS).flatMap((stop) => stop.anchors));

    for (const anchor of named) {
      // Two spellings, because there are two ways an anchor reaches the DOM. Most are written
      // straight onto an element; the four navigation rows are declared on their `AppNavItem`
      // (`tour: 'nav-results'`) and rendered by one shared `NavRow`, so the literal never appears
      // next to a `data-tour=`. Both are the same commitment — a string in one file that a string
      // in another has to match — and this test exists to catch a rename that was only half done.
      const written =
        source.includes(`data-tour="${anchor}"`) || source.includes(`tour: '${anchor}'`);

      expect(written, anchor).toBe(true);
    }
  });
});

/** Every `.tsx` under `src/`, concatenated. Tests excluded — markup, not fixtures. */
function sourceText(root: string): string {
  const parts: string[] = [];

  const walk = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);

      if (entry.isDirectory()) {
        walk(path);
      } else if (entry.name.endsWith('.tsx') && !entry.name.includes('.test.')) {
        parts.push(readFileSync(path, 'utf8'));
      }
    }
  };

  walk(root);

  return parts.join('\n');
}
