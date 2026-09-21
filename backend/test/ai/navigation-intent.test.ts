import { describe, expect, it } from 'vitest';

import { normaliseQuestion } from '@/lib/grounding';
import {
  destinationFor,
  navigationReply,
  STUDENT_DESTINATIONS,
  TAKE_ME_THERE_OFFER,
} from '@/knowledge/student-destinations';

/**
 * The navigation gate (migration 0038) — *"where do I download my results?"*
 *
 * Two failure modes matter here and they pull in opposite directions, so nearly every test below
 * is one of a pair:
 *
 *   1. **Missing a navigation question** costs a student a model call and a paragraph describing a
 *      menu they are already looking at. Annoying, recoverable.
 *   2. **Claiming one that is not** costs a student their actual answer — *"where can I study
 *      nursing?"* answered with a description of the sidebar. That is the expensive direction, and
 *      it is why the matcher needs both a navigational phrasing *and* a named destination.
 */

/** What the gate sees: the service normalises before calling it. */
function ask(question: string): string | null {
  return destinationFor(normaliseQuestion(question))?.id ?? null;
}

describe('recognising that a student is asking where something is', () => {
  it.each([
    ['Where do I see my results?', 'results'],
    ['where can i find my scores', 'results'],
    ['Take me to my results', 'results'],
    ['saan ko makita ang resulta ko', 'results'],
    ['How do I download my results?', 'report-download'],
    ['where do i print my report', 'report-download'],
    ['how can i export my scores as a pdf', 'report-download'],
    ['Where are my recommendations?', 'recommendations'],
    ['take me to my matches', 'recommendations'],
    ['How do I start the assessment?', 'assessments'],
    ['where do i continue the test', 'assessments'],
    ['How do I change my strand?', 'profile-strand'],
    ['where can i update my grades', 'profile-grades'],
    ['Where is my profile?', 'profile'],
    ['how do i find the notifications', 'notifications'],
    ['where is the sign out button', 'sign-out'],
    ['take me to the dashboard', 'dashboard'],
  ])('%s → %s', (question, expected) => {
    expect(ask(question)).toBe(expected);
  });

  /**
   * The download sits *on* the results page, so "download my results" names both. The more
   * specific one has to win, which is what the table's ordering is for.
   */
  it('prefers the control over the page that holds it', () => {
    expect(ask('how do i download my results')).toBe('report-download');
    expect(ask('where do i see my results')).toBe('results');
  });
});

describe('the questions this gate must keep its hands off', () => {
  /**
   * Every one of these has navigational *phrasing* and names no destination. They are the catalog
   * gate's, and answering them with a description of a menu would be the worst outcome this gate
   * can produce.
   */
  it.each([
    'Where can I study nursing?',
    'where can i study bs information technology',
    'Where is Holy Name University?',
    'how do i get to bisu calape',
    'where can i work as a civil engineer',
    'Which colleges are in Tagbilaran?',
  ])('leaves %s to the catalog', (question) => {
    expect(ask(question)).toBeNull();
  });

  /**
   * And these name a destination with no navigational phrasing — a student asking *about* the
   * thing, not for the way there. "What are my results?" must still print the actual scores.
   */
  it.each([
    'What are my results?',
    'what is my holland code',
    'why is nursing my top program',
    'what are my top 5 careers',
    'how are my scores calculated',
    'what does my strand mean',
  ])('leaves %s to the results gate', (question) => {
    expect(ask(question)).toBeNull();
  });
});

describe('asking for help with the product itself', () => {
  it.each([
    'show me around',
    'give me a tour',
    'how do i use this',
    'how does this app work',
    'i am lost',
    'i dont know what to do',
    'walk me through the app',
  ])('offers the tour for %s', (question) => {
    expect(ask(question)).toBe('tour');
  });

  it('asks to start the tour rather than offering to travel to it', () => {
    const tour = STUDENT_DESTINATIONS.find((destination) => destination.id === 'tour')!;

    expect(navigationReply(tour)).toContain('Want me to start it?');
    expect(navigationReply(tour)).not.toContain(TAKE_ME_THERE_OFFER);
  });
});

describe('the answer itself', () => {
  it('ends every destination with a question rather than a navigation', () => {
    for (const destination of STUDENT_DESTINATIONS) {
      expect(navigationReply(destination).trimEnd(), destination.id).toMatch(/\?$/);
    }
  });

  /**
   * The panel renders `content` verbatim in a `whitespace-pre-wrap` div. There is no markdown
   * renderer behind it, so an asterisk or an underscore reaches the student as itself.
   */
  it('writes plain text, because the panel has no markdown renderer', () => {
    for (const destination of STUDENT_DESTINATIONS) {
      expect(destination.says, destination.id).not.toMatch(/\*\*|__|\[.+\]\(.+\)/);
    }
  });

  it('keeps ids unique — they are the whole contract with the client', () => {
    const ids = STUDENT_DESTINATIONS.map((destination) => destination.id);

    expect(new Set(ids).size).toBe(ids.length);
  });

  /**
   * The client's `features/student/tour/stops.ts` resolves each of these to a route and an
   * element. A new destination here with no stop there renders an answer with no button — which
   * is graceful, and still a half-finished feature. This list is the handshake; the frontend pins
   * the same one.
   */
  it('ships exactly the destinations the client knows how to point at', () => {
    expect(STUDENT_DESTINATIONS.map((destination) => destination.id)).toEqual([
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
    ]);
  });
});
