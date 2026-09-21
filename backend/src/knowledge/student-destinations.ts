/**
 * Where things are, in a student's own words (migration 0038).
 *
 * ## The question this answers
 *
 * A guidance assistant sitting on a dashboard gets asked about the dashboard. Not often, and never
 * in the words the interface uses: *"where do I download my results"*, *"paano ko makita ang
 * recommendations ko"*, *"how do I change my strand"*, *"I dont know what to do here"*. Before
 * this file those went to retrieval, which has nothing about this product's own navigation in it,
 * and came back as a refusal or — worse — a fluent paragraph describing a menu the student was
 * already staring at.
 *
 * Prose is the wrong medium for *"it is over there"*. So these questions get a deterministic
 * answer that names the screen, says what is on it, and then **asks**: *Want me to take you
 * there?* The `id` travels to the client on the message row, the client turns it into a route and
 * an element, and pressing the button walks the student to it and points at it.
 *
 * ## The contract with the client
 *
 * `id` is the whole contract. The client's `features/student/tour/stops.ts` maps each one to a
 * path and an on-screen anchor; an id it does not recognise renders as an ordinary answer with no
 * button, which is a graceful failure rather than a broken one — the sentence has already told the
 * student where to go. Rename an id here and you must rename it there; a test on each side pins
 * the list so the rename cannot be half-done.
 *
 * ## Why this is a table and not a prompt instruction
 *
 * Because a model asked "where is my profile?" will answer it, confidently, from the shape of
 * every other web app it has read. The screens it describes will be plausible and will not be
 * ours. §3's whole position is that a student is never handed a confident guess, and the layout of
 * our own product is the last place to start making exceptions.
 */

/** One place a student can be sent, and what is there when they arrive. */
export interface StudentDestination {
  /**
   * The stable id shared with the client. Kebab-case, and it names the *thing* rather than the
   * route — `report-download` is a button, `results` is a page, and both are somewhere a student
   * can be taken.
   */
  id: string;
  /** How the interface itself labels it. It appears in the sentence, so it must match the screen. */
  label: string;
  /**
   * The answer: where it is, and what is on it. Plain text — the panel renders `content` verbatim
   * in a `whitespace-pre-wrap` div, so there is no markdown to lean on and an asterisk is an
   * asterisk.
   */
  says: string;
  /** What the question has to name for this destination to be the answer. */
  match: RegExp;
  /**
   * The closing question, when *"Want me to take you there?"* is the wrong one to ask. Only the
   * tour needs it — it is not a place — and the button's own label comes from the client, so this
   * is the sentence and nothing more.
   */
  offer?: string;
}

/**
 * Asking for a way somewhere, rather than asking about the thing itself.
 *
 * Both halves are required — this phrasing **and** a destination below — and that is the whole
 * safety story. *"Where can I study nursing?"* has the phrasing and names no destination, so it
 * goes to the catalog gate as it always did. *"What are my results?"* names a destination and has
 * no phrasing, so it is still answered with the actual scores. Only a question that is asking to
 * be *taken* somewhere is treated as one.
 */
const WANTS_A_WAY_THERE =
  /\b(?:where (?:can|do|would|will|should) i|where is|where s|wheres|where are|how (?:do|can|could|would) i (?:find|get to|see|view|open|access|download|print|export|start|take|begin|resume|continue|change|update|edit|fix|check|read|reach)|how (?:to|do you) (?:find|get to|see|view|open|download|print|start|take|change|update)|take me to|bring me to|go to|open (?:my|the)|show me (?:my|the|where)|point me|navigate|which (?:page|screen|tab|menu)|what page|saan|asa|paano (?:ko )?(?:makita|mahanap|mabuksan|ma download))\b/;

/**
 * *"Show me around."* Asked on its own, with no destination named, and the only honest answer is
 * the tour itself. Checked before `WANTS_A_WAY_THERE` because none of these phrasings ask for a
 * *place* — they ask for help using the thing.
 */
const WANTS_THE_TOUR =
  /\b(?:give me a tour|a tour|the tour|tour of|show me around|walk me through|how (?:do|does) (?:i use|this (?:work|app|site|website|system)|the (?:app|site|system))|how to use (?:this|the app|the site|careerlinkai)|i (?:am|m) (?:lost|confused|new here)|i (?:dont|do not) know (?:what to do|where to (?:start|go|click)|how to use)|new here|first time here|guide me|teach me (?:how to use|the app))\b/;

/**
 * Ordered most specific first, and the order is load-bearing.
 *
 * *"How do I download my results?"* names both the download and the results page. The download is
 * the better answer — it is the thing they asked for, and it lives on the results page anyway — so
 * it has to be tried first. Every pair where one destination sits inside another is sorted the
 * same way.
 */
export const STUDENT_DESTINATIONS: StudentDestination[] = [
  {
    id: 'tour',
    label: 'the quick tour',
    says: 'There is a short tour that walks you through every part of your dashboard — where your assessments are, where your results and recommendations live, and what each screen is for. It takes about a minute, and you can skip it at any point.',
    // Reached through WANTS_THE_TOUR, never through a destination match: nobody asks "where is the
    // tour". The pattern is here so the table keeps one entry per id.
    match: /\btour\b/,
    offer: 'Want me to start it?',
  },
  {
    id: 'report-download',
    label: 'Print results',
    says: 'You can save or print your results as a PDF. Open "My results" from the menu, then use the "Print results" button at the top right — it puts your RIASEC and SCCT reports on one sheet you can hand to your counselor or your parents. Each result card also has its own "Export" button if you only want one of them.',
    match:
      /\b(?:download|downloading|pdf|print|printing|printed|export|exporting|save (?:my |the |a )?(?:results?|report|copy)|hard copy|soft copy)\b/,
  },
  {
    id: 'profile-strand',
    label: 'Academic track',
    says: 'Your strand is on "My profile" — press your name at the top right of the screen, then "My profile". It is the first card, "Academic track". Change it there and press Save, then rebuild your recommendations so your program matches use the new one.',
    match: /\bstrand\b|\b(?:academic )?track\b/,
  },
  {
    id: 'profile-grades',
    label: 'Subject grades',
    says: 'Your Math, Science and English grades are on "My profile" — press your name at the top right, then "My profile". They are 10% of every program match, so filling them in makes your program list more accurate. A blank grade is never counted against you.',
    match: /\b(?:grades?|math|science|english|gwa|average|subject scores?)\b/,
  },
  {
    id: 'profile',
    label: 'My profile',
    says: 'Your profile is behind your name at the top right of the screen — press it, then "My profile". It holds your strand, your grade level and your subject grades, which are what your program recommendations are matched against.',
    match: /\b(?:profile|my (?:details|info|information)|account|grade level)\b/,
  },
  {
    id: 'recommendations',
    label: 'My recommendations',
    says: 'Your recommendations are on "My recommendations" — the fourth item in the menu on the left (on a phone, tap the menu button at the top left first). It ranks careers and programs against your own results, and every card says why it is there. They appear once you have finished both the RIASEC and the SCCT assessment.',
    match:
      /\b(?:recommendations?|recommended|matches|my matches|top careers?|top programs?|suggested (?:careers?|programs?|courses?)|rekomendasyon)\b/,
  },
  {
    id: 'results',
    label: 'My results',
    says: 'Your results are on "My results" — the third item in the menu on the left (on a phone, tap the menu button at the top left first). It shows your RIASEC interest profile, your SCCT career confidence, and every other assessment you have finished. Every score is out of 100, and there is no pass mark.',
    match:
      /\b(?:results?|scores?|my score|holland code|riasec|scct|resulta|marka)\b/,
  },
  {
    id: 'assessments',
    label: 'My assessments',
    says: 'Your assessments are on "My assessments" — the second item in the menu on the left (on a phone, tap the menu button at the top left first). Anything your counselor has assigned is listed there with a "Start" or "Continue" button. You can stop halfway and come back; your answers are saved as you go.',
    match:
      /\b(?:assessments?|test|tests|exam|exams|quiz|questionnaire|survey|answer(?:ing)? (?:the )?questions?|pagsusulit)\b/,
  },
  {
    id: 'assistant',
    label: 'Ask CareerLinkAI',
    says: 'You are already in it — this is the assistant. You can open it from any screen with the round CareerLinkAI button in the bottom right corner. Ask it about your scores, about a career or a program, or about where something is.',
    match: /\b(?:chat|assistant|ask (?:you|careerlinkai)|this (?:chat|assistant|bot)|bot)\b/,
  },
  {
    id: 'notifications',
    label: 'Notifications',
    says: 'Notifications are the bell at the top right of every screen. It is where you are told that an assessment has been assigned to you, or that a question you asked the school has been answered.',
    match:
      /\b(?:notifications?|bell|alerts?|announcements?|messages? from (?:my )?(?:school|counselor))\b/,
  },
  {
    id: 'sign-out',
    label: 'Sign out',
    says: 'Sign out is at the very bottom of the menu on the left, under your name. Use it before you leave a shared computer — it also clears your class from this browser, so the next student does not see it.',
    match: /\b(?:sign out|signout|log out|logout|sign off|exit)\b/,
  },
  {
    id: 'dashboard',
    label: 'Dashboard',
    says: 'The dashboard is the first item in the menu on the left, and it is where you land when you sign in. It answers one question: what should I do next. The four boxes across the top count your assessments, the ones you have finished, your results, and whether your recommendations are ready.',
    match: /\b(?:dashboard|home|main (?:page|screen)|front page|start (?:page|screen))\b/,
  },
];

/**
 * The destination a question is asking to be taken to, or null.
 *
 * Null is the ordinary answer and the safe one: everything that is not plainly a navigation
 * question carries on down the pipeline exactly as it did before this gate existed.
 *
 * `asked` is already normalised (`normaliseQuestion`) — lower case, no punctuation, no
 * diacritics — because every pattern above is written against that shape.
 */
export function destinationFor(asked: string): StudentDestination | null {
  if (asked === '') return null;

  if (WANTS_THE_TOUR.test(asked)) {
    return STUDENT_DESTINATIONS.find((destination) => destination.id === 'tour') ?? null;
  }

  if (!WANTS_A_WAY_THERE.test(asked)) return null;

  return STUDENT_DESTINATIONS.find((destination) => destination.match.test(asked)) ?? null;
}

/** The offer that turns an answer into a button, for everything that is a place. */
export const TAKE_ME_THERE_OFFER = 'Want me to take you there?';

/**
 * The whole reply for one destination: what is there, then the offer.
 *
 * The offer is a real question rather than an announcement, because the button beside it is a
 * *navigation* — pressing it takes the student off the screen they are on, mid-conversation. That
 * is not something to do to somebody who only wanted to know where a thing was.
 */
export function navigationReply(destination: StudentDestination): string {
  return `${destination.says}\n\n${destination.offer ?? TAKE_ME_THERE_OFFER}`;
}
