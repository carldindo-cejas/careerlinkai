/**
 * **The request the assessment builder actually sends, held once and asserted from both ends.**
 *
 * ASSESSMENT-FIX §1 was a 422 on every "Add question" click, and neither side's tests could have
 * caught it: the frontend's mocked the API away, so the payload was never validated by anything,
 * and the backend's sent a non-empty `question_text` in every single case. Both halves were
 * individually well tested and they disagreed about the contract between them.
 *
 * So the payload lives here rather than as a literal in two suites:
 *
 *   * `frontend/…/QuestionWorkspace.test.tsx` asserts the workspace sends **exactly this** when the
 *     author clicks Add — a change to what the client sends fails there first.
 *   * `backend/test/assessment/builder.test.ts` POSTs **exactly this** through the real HTTP surface
 *     — so the update that makes the frontend test pass again fails here if the server would reject
 *     it.
 *
 * Neither assertion means much alone. Together they are the thing that was missing: a client payload
 * the server would refuse cannot pass CI, whichever side changes first.
 *
 * Deliberately plain TypeScript with no imports — it is read by two packages with different module
 * resolution, different aliases, and different runtimes (one of them workerd).
 */

/** The five-point scale the builder seeds a new Likert item with. */
export const NEW_QUESTION_OPTIONS = [
  { label: 'Strongly Disagree', value: '1', score: 1 },
  { label: 'Disagree', value: '2', score: 2 },
  { label: 'Neutral', value: '3', score: 3 },
  { label: 'Agree', value: '4', score: 4 },
  { label: 'Strongly Agree', value: '5', score: 5 },
];

/**
 * One blank question — the stub the author then types into.
 *
 * **`question_text` is empty and `dimension_codes` is empty, and both are correct.** The builder's
 * UX is insert-a-stub-then-autosave-into-it, so a question with no text yet has to be a legal draft
 * state; and guessing which dimension an item measures would be worse than asking. Neither survives
 * to publication — `AssessmentBuilderService.publish` refuses both, naming the offending items.
 */
export const NEW_QUESTION = {
  question_text: '',
  question_type: 'LIKERT' as const,
  options: NEW_QUESTION_OPTIONS,
  dimension_codes: [] as string[],
};

/** The wire body: `POST /assessment-versions/{id}/questions`. */
export const ADD_QUESTION_REQUEST = { questions: [NEW_QUESTION] };
