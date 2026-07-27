import { AnimatePresence, motion, Reorder, useDragControls } from 'framer-motion';
import {
  AlertTriangle,
  Check,
  CircleDot,
  Copy,
  GripVertical,
  Loader2,
  Plus,
  Square,
  Trash2,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { cn } from '@/components/ui/cn';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import {
  useAddQuestions,
  useConfirmMapping,
  useDeleteQuestion,
  useDuplicateQuestion,
  useReorderQuestions,
} from '@/features/assessment-builder/hooks/useBuilder';
import { useQuestionAutosave } from '@/features/assessment-builder/hooks/useQuestionAutosave';
import { toast } from '@/stores/toastStore';
import type {
  AuthorQuestion,
  BuilderDimension,
  QuestionOptionDraft,
  QuestionType,
  VersionReview,
} from '@/types/builder';

/**
 * The assessment builder's editing workspace (prompt-driven, v1.6).
 *
 * **A familiar shape, not a copied one.** Counselors have all used a form builder, so the layout is
 * the one they already know — a question list on the left, one large editable question in the
 * middle, add/duplicate/delete/required where the hand expects them. What it deliberately does not
 * do is imitate a particular product's visuals: this is CareerLinkAI's design system (square
 * corners, the steel palette, the same Card/Input/Button primitives as every other screen), because
 * a builder that looked like a different application inside this one would be its own kind of
 * confusion.
 *
 * Three things here exist for reasons specific to *this* system rather than to form builders:
 *
 *   * **The mapping is a first-class field, not a setting.** What a question measures decides how a
 *     student is scored, and §25 requires a human to confirm it. So it sits in the editor beside
 *     the question text, and the navigator marks any item whose mapping is still unconfirmed — that
 *     list is the publish gate, made visible.
 *   * **Option scores are shown.** The player hides them on purpose (a student who can see that
 *     "Agree" is worth 5 stops answering honestly); the author must see them or they cannot author.
 *   * **Everything is disabled on a published version.** Invariant 1 freezes a published version
 *     forever, and the workspace renders read-only rather than offering controls the server refuses.
 */

const QUESTION_TYPES: { value: QuestionType; label: string; hint: string }[] = [
  { value: 'LIKERT', label: 'Likert scale', hint: 'Ordered agreement — the usual survey item.' },
  { value: 'MULTIPLE_CHOICE', label: 'Multiple choice', hint: 'One answer from a set.' },
  { value: 'BOOLEAN', label: 'Yes / No', hint: 'Two options.' },
];

/** The 5-point scale §22 uses, and the sensible default for a new item. */
const LIKERT_OPTIONS: QuestionOptionDraft[] = [
  { label: 'Strongly Disagree', value: '1', score: 1 },
  { label: 'Disagree', value: '2', score: 2 },
  { label: 'Neutral', value: '3', score: 3 },
  { label: 'Agree', value: '4', score: 4 },
  { label: 'Strongly Agree', value: '5', score: 5 },
];

const BOOLEAN_OPTIONS: QuestionOptionDraft[] = [
  { label: 'No', value: 'no', score: 0 },
  { label: 'Yes', value: 'yes', score: 1 },
];

const CHOICE_OPTIONS: QuestionOptionDraft[] = [
  { label: 'Option 1', value: '1', score: 1 },
  { label: 'Option 2', value: '2', score: 2 },
];

function defaultOptionsFor(type: QuestionType): QuestionOptionDraft[] {
  switch (type) {
    case 'BOOLEAN':
      return BOOLEAN_OPTIONS;
    case 'MULTIPLE_CHOICE':
      return CHOICE_OPTIONS;
    case 'LIKERT':
    default:
      return LIKERT_OPTIONS;
  }
}

interface QuestionWorkspaceProps {
  review: VersionReview;
  dimensions: BuilderDimension[];
  /** False on a PUBLISHED or ARCHIVED version — invariant 1 reaches every row beneath it. */
  editable: boolean;
}

export function QuestionWorkspace({ review, dimensions, editable }: QuestionWorkspaceProps) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [preview, setPreview] = useState(false);

  const addQuestions = useAddQuestions(review.id);
  const duplicate = useDuplicateQuestion(review.id);
  const remove = useDeleteQuestion(review.id);
  const reorder = useReorderQuestions(review.id);

  const questions = review.questions;

  /**
   * Keep a valid selection without fighting the user.
   *
   * Selecting the first question when nothing is selected is a convenience; re-selecting when the
   * current one *disappears* (deleted, or the version reloaded) is a correctness fix — otherwise the
   * editor renders an empty pane and the author thinks the page broke.
   */
  useEffect(() => {
    if (questions.length === 0) {
      setSelectedId(null);

      return;
    }

    if (selectedId === null || !questions.some((question) => question.id === selectedId)) {
      setSelectedId(questions[0]!.id);
    }
  }, [questions, selectedId]);

  const selected = questions.find((question) => question.id === selectedId) ?? null;

  async function handleAdd() {
    try {
      await addQuestions.mutateAsync([
        {
          question_text: '',
          question_type: 'LIKERT',
          options: LIKERT_OPTIONS,
          // No mapping by default: an item that measures nothing is a legitimate state while it is
          // being written, and guessing a dimension for the author would be worse than asking.
          dimension_codes: [],
        },
      ]);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not add the question.');
    }
  }

  async function handleDuplicate(question: AuthorQuestion) {
    try {
      const copy = await duplicate.mutateAsync(question.id);

      setSelectedId(copy.id);
      toast.success('Question duplicated.');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not duplicate the question.');
    }
  }

  async function handleDelete(question: AuthorQuestion) {
    if (
      !window.confirm(
        `Remove question ${question.order_number}? This version is still a draft, so nothing a student has answered is affected.`,
      )
    ) {
      return;
    }

    try {
      await remove.mutateAsync(question.id);
      toast.success('Question removed.');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not remove the question.');
    }
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,18rem)_minmax(0,1fr)]">
      <QuestionNavigator
        questions={questions}
        selectedId={selectedId}
        editable={editable}
        onSelect={setSelectedId}
        onReorder={(ids) => reorder.mutate(ids)}
        onAdd={handleAdd}
        isAdding={addQuestions.isPending}
      />

      <div className="min-w-0">
        {selected === null ? (
          <EmptyWorkspace editable={editable} onAdd={handleAdd} isAdding={addQuestions.isPending} />
        ) : (
          <QuestionEditor
            /* Remounting on selection is what resets the local draft state to the new question —
               far simpler, and less error-prone, than syncing every field in an effect. */
            key={selected.id}
            versionId={review.id}
            question={selected}
            dimensions={dimensions}
            editable={editable}
            preview={preview}
            onTogglePreview={() => setPreview((value) => !value)}
            onDuplicate={() => handleDuplicate(selected)}
            onDelete={() => handleDelete(selected)}
            isDuplicating={duplicate.isPending}
            isDeleting={remove.isPending}
          />
        )}
      </div>
    </div>
  );
}

// --- The left panel ----------------------------------------------------------------------------

function QuestionNavigator({
  questions,
  selectedId,
  editable,
  onSelect,
  onReorder,
  onAdd,
  isAdding,
}: {
  questions: AuthorQuestion[];
  selectedId: string | null;
  editable: boolean;
  onSelect: (id: string) => void;
  onReorder: (ids: string[]) => void;
  onAdd: () => void;
  isAdding: boolean;
}) {
  /**
   * Local order, so the list follows the cursor at 60fps.
   *
   * `Reorder.Group` needs to own the array it animates; the server round trip happens on drop
   * (`onDragEnd`), not on every frame. It is re-synced from props whenever the server's order
   * changes — including when the optimistic update in `useReorderQuestions` is rolled back.
   */
  const [order, setOrder] = useState(questions);

  useEffect(() => {
    setOrder(questions);
  }, [questions]);

  const unconfirmed = useMemo(
    () =>
      new Set(
        questions
          .filter((question) => question.dimensions.some((mapping) => !mapping.confirmed))
          .map((question) => question.id),
      ),
    [questions],
  );

  return (
    <aside className="flex max-h-[calc(100vh-12rem)] flex-col border border-border bg-background lg:sticky lg:top-24">
      <div className="flex items-center justify-between border-b border-border px-3 py-2.5">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {questions.length} question{questions.length === 1 ? '' : 's'}
        </p>
        {editable ? (
          <Button variant="ghost" size="sm" onClick={onAdd} loading={isAdding}>
            <Plus className="size-4" aria-hidden="true" />
            Add
          </Button>
        ) : null}
      </div>

      {questions.length === 0 ? (
        <p className="px-3 py-6 text-center text-sm text-muted-foreground">
          No questions yet.
        </p>
      ) : (
        <Reorder.Group
          axis="y"
          values={order}
          onReorder={setOrder}
          className="flex-1 overflow-y-auto"
          /* The drag is a mouse gesture; the list is still a list for a keyboard and a screen
             reader, which is why each row is a real button that selection works through. */
          as="ul"
        >
          {order.map((question, index) => (
            <NavigatorRow
              key={question.id}
              question={question}
              position={index + 1}
              selected={question.id === selectedId}
              editable={editable}
              needsConfirmation={unconfirmed.has(question.id)}
              onSelect={() => onSelect(question.id)}
              onDragEnd={() => onReorder(order.map((item) => item.id))}
            />
          ))}
        </Reorder.Group>
      )}
    </aside>
  );
}

function NavigatorRow({
  question,
  position,
  selected,
  editable,
  needsConfirmation,
  onSelect,
  onDragEnd,
}: {
  question: AuthorQuestion;
  position: number;
  selected: boolean;
  editable: boolean;
  needsConfirmation: boolean;
  onSelect: () => void;
  onDragEnd: () => void;
}) {
  /**
   * Drag from the handle only.
   *
   * Without `dragControls` the whole row is draggable, and selecting a question by clicking it
   * becomes a tiny accidental drag half the time. The handle makes reordering deliberate and leaves
   * the rest of the row behaving like the button it is.
   */
  const controls = useDragControls();

  return (
    <Reorder.Item
      value={question}
      dragListener={false}
      dragControls={controls}
      onDragEnd={onDragEnd}
      as="li"
      className={cn(
        'flex items-start gap-1.5 border-b border-border px-2 py-2 transition-colors last:border-b-0',
        selected ? 'bg-secondary' : 'hover:bg-secondary/50',
      )}
    >
      {editable ? (
        <button
          type="button"
          aria-label={`Reorder question ${position}`}
          className="mt-0.5 cursor-grab touch-none text-muted-foreground/60 hover:text-foreground active:cursor-grabbing"
          onPointerDown={(event) => controls.start(event)}
        >
          <GripVertical className="size-4" aria-hidden="true" />
        </button>
      ) : (
        <span className="w-4" />
      )}

      <button
        type="button"
        onClick={onSelect}
        aria-current={selected ? 'true' : undefined}
        className="min-w-0 flex-1 text-left"
      >
        <span className="flex items-center gap-1.5">
          <span className="text-xs font-semibold tabular-nums text-muted-foreground">
            {position}.
          </span>
          {question.required ? null : (
            <span className="text-[10px] uppercase tracking-wide text-muted-foreground/60">
              optional
            </span>
          )}
          {needsConfirmation ? (
            <AlertTriangle
              className="size-3 text-accent"
              aria-label="Scoring mapping not confirmed"
            />
          ) : null}
        </span>
        <span className="mt-0.5 line-clamp-2 block text-sm text-foreground/90">
          {question.question_text.trim() === '' ? (
            <span className="italic text-muted-foreground">Untitled question</span>
          ) : (
            question.question_text
          )}
        </span>
      </button>
    </Reorder.Item>
  );
}

function EmptyWorkspace({
  editable,
  onAdd,
  isAdding,
}: {
  editable: boolean;
  onAdd: () => void;
  isAdding: boolean;
}) {
  return (
    <div className="flex min-h-64 flex-col items-center justify-center gap-3 border border-dashed border-border p-10 text-center">
      <p className="text-sm text-muted-foreground">
        {editable
          ? 'This version has no questions yet. Add one, or draft a set with AI above.'
          : 'This version has no questions.'}
      </p>
      {editable ? (
        <Button onClick={onAdd} loading={isAdding}>
          <Plus className="size-4" aria-hidden="true" />
          Add the first question
        </Button>
      ) : null}
    </div>
  );
}

// --- The editor --------------------------------------------------------------------------------

function QuestionEditor({
  versionId,
  question,
  dimensions,
  editable,
  preview,
  onTogglePreview,
  onDuplicate,
  onDelete,
  isDuplicating,
  isDeleting,
}: {
  versionId: string;
  question: AuthorQuestion;
  dimensions: BuilderDimension[];
  editable: boolean;
  preview: boolean;
  onTogglePreview: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
  isDuplicating: boolean;
  isDeleting: boolean;
}) {
  const autosave = useQuestionAutosave(versionId, question.id);
  const confirmMapping = useConfirmMapping(versionId);

  /**
   * Local state for the fields being typed into, seeded once from the server (the component is
   * remounted per question by its `key`). The server is still the source of truth — every change
   * goes through `autosave`, and `useUpdateQuestion` writes the server's answer back into the cache.
   */
  const [text, setText] = useState(question.question_text);
  const [type, setType] = useState<QuestionType>(question.question_type);
  const [required, setRequired] = useState(question.required);
  const [section, setSection] = useState(question.section_label ?? '');
  const [options, setOptions] = useState<QuestionOptionDraft[]>(
    question.options.map((option) => ({
      label: option.label,
      value: option.value,
      score: option.score,
    })),
  );
  const [codes, setCodes] = useState<string[]>(
    question.dimensions.map((mapping) => mapping.code),
  );

  function patch(changes: Parameters<typeof autosave.save>[0]) {
    if (!editable) {
      return;
    }

    autosave.save(changes);
  }

  /**
   * Changing the type **replaces the options with that type's defaults**.
   *
   * Keeping five Likert options under a Yes/No item would produce a question whose type and content
   * disagree — and the player renders from the options, so the student would see the type change do
   * nothing. Swapping them is the only interpretation of the act that has an effect.
   */
  function changeType(next: QuestionType) {
    const defaults = defaultOptionsFor(next);

    setType(next);
    setOptions(defaults);
    patch({ question_type: next, options: defaults });
  }

  function changeOption(index: number, changes: Partial<QuestionOptionDraft>) {
    const next = options.map((option, position) =>
      position === index ? { ...option, ...changes } : option,
    );

    setOptions(next);
    patch({ options: next });
  }

  function addOption() {
    const next = [
      ...options,
      { label: `Option ${options.length + 1}`, value: String(options.length + 1), score: 0 },
    ];

    setOptions(next);
    patch({ options: next });
  }

  function removeOption(index: number) {
    // Two is the server's floor, and the reason is real: a question with one answer measures
    // nothing. Refusing here keeps the auto-save from firing a request that can only 422.
    if (options.length <= 2) {
      toast.info('A question needs at least two options.');

      return;
    }

    const next = options.filter((_, position) => position !== index);

    setOptions(next);
    patch({ options: next });
  }

  function toggleDimension(code: string) {
    const next = codes.includes(code)
      ? codes.filter((existing) => existing !== code)
      : [...codes, code];

    setCodes(next);
    patch({ dimension_codes: next });
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            Question {question.order_number}
          </h2>
          <Badge tone={question.source === 'AI_GENERATED' ? 'outline' : undefined}>
            {question.source === 'AI_GENERATED' ? 'AI draft' : 'Manual'}
          </Badge>
          <SaveIndicator status={autosave.status} editable={editable} />
        </div>

        <div className="flex items-center gap-1">
          <Button variant="secondary" size="sm" onClick={onTogglePreview}>
            {preview ? 'Back to editing' : 'Preview'}
          </Button>
          {editable ? (
            <>
              <Button
                variant="ghost"
                size="sm"
                title="Duplicate this question"
                aria-label="Duplicate this question"
                loading={isDuplicating}
                onClick={onDuplicate}
              >
                <Copy className="size-4" aria-hidden="true" />
              </Button>
              <Button
                variant="ghost"
                size="sm"
                title="Remove this question"
                aria-label="Remove this question"
                loading={isDeleting}
                onClick={onDelete}
              >
                <Trash2 className="size-4 text-destructive" aria-hidden="true" />
              </Button>
            </>
          ) : null}
        </div>
      </div>

      {autosave.status === 'error' && autosave.error !== null ? (
        <Alert>
          {autosave.error.message} Your change is still here and will be retried on the next edit —
          do not retype it.
        </Alert>
      ) : null}

      <AnimatePresence mode="wait" initial={false}>
        {preview ? (
          <motion.div
            key="preview"
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            transition={{ duration: 0.15 }}
          >
            <QuestionPreview
              text={text}
              type={type}
              required={required}
              section={section}
              options={options}
            />
          </motion.div>
        ) : (
          <motion.div
            key="editor"
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            transition={{ duration: 0.15 }}
            className="flex flex-col gap-5 border border-border bg-background p-5"
          >
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="question-text">Question</Label>
              <Textarea
                id="question-text"
                value={text}
                rows={3}
                disabled={!editable}
                placeholder="e.g. I review my notes within a day of each class."
                className="text-base"
                onChange={(event) => {
                  setText(event.target.value);
                  patch({ question_text: event.target.value });
                }}
                onBlur={autosave.flush}
              />
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="question-type">Question type</Label>
                <Select
                  id="question-type"
                  value={type}
                  disabled={!editable}
                  onChange={(event) => changeType(event.target.value as QuestionType)}
                >
                  {QUESTION_TYPES.map((entry) => (
                    <option key={entry.value} value={entry.value}>
                      {entry.label}
                    </option>
                  ))}
                </Select>
                <p className="text-xs text-muted-foreground">
                  {QUESTION_TYPES.find((entry) => entry.value === type)?.hint}
                </p>
              </div>

              <div className="flex flex-col gap-1.5">
                <Label htmlFor="question-section">Section heading (optional)</Label>
                <Input
                  id="question-section"
                  value={section}
                  disabled={!editable}
                  placeholder="Study habits"
                  onChange={(event) => {
                    setSection(event.target.value);
                    patch({
                      section_label: event.target.value.trim() === '' ? null : event.target.value,
                    });
                  }}
                  onBlur={autosave.flush}
                />
                {/* A deliberate, limited disclosure — it groups items without revealing what any
                    single one scores. Saying so stops it being used as a dimension label. */}
                <p className="text-xs text-muted-foreground">
                  Shown to students as a heading. Never name the dimension here.
                </p>
              </div>
            </div>

            <OptionsEditor
              type={type}
              options={options}
              editable={editable}
              onChange={changeOption}
              onAdd={addOption}
              onRemove={removeOption}
              onBlur={autosave.flush}
            />

            <MappingEditor
              question={question}
              dimensions={dimensions}
              codes={codes}
              editable={editable}
              onToggle={toggleDimension}
              onConfirm={(mappingId) => confirmMapping.mutate(mappingId)}
              isConfirming={confirmMapping.isPending}
            />

            <label className="flex w-fit items-center gap-2 text-sm text-foreground">
              <input
                type="checkbox"
                checked={required}
                disabled={!editable}
                className="size-4 accent-primary"
                onChange={(event) => {
                  setRequired(event.target.checked);
                  patch({ required: event.target.checked });
                  // A toggle has no "pause in typing" to wait for, so it saves at once.
                  autosave.flush();
                }}
              />
              Required
              <span className="text-xs text-muted-foreground">
                — a student cannot submit while a required question is unanswered.
              </span>
            </label>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function OptionsEditor({
  type,
  options,
  editable,
  onChange,
  onAdd,
  onRemove,
  onBlur,
}: {
  type: QuestionType;
  options: QuestionOptionDraft[];
  editable: boolean;
  onChange: (index: number, changes: Partial<QuestionOptionDraft>) => void;
  onAdd: () => void;
  onRemove: (index: number) => void;
  onBlur: () => void;
}) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <Label>Answer options</Label>
        <p className="text-xs text-muted-foreground">
          Scores are what the student’s answer is worth. Students never see them.
        </p>
      </div>

      <ul className="flex flex-col gap-2">
        {options.map((option, index) => (
          <li key={index} className="flex items-center gap-2">
            {type === 'MULTIPLE_CHOICE' || type === 'BOOLEAN' ? (
              <CircleDot className="size-4 shrink-0 text-muted-foreground/50" aria-hidden="true" />
            ) : (
              <Square className="size-4 shrink-0 text-muted-foreground/50" aria-hidden="true" />
            )}
            <Input
              value={option.label}
              disabled={!editable}
              aria-label={`Option ${index + 1} label`}
              className="flex-1"
              onChange={(event) =>
                // `value` is the stored answer key. It tracks the label rather than being a second
                // field to fill in — an author thinks in labels, and a divergent pair is a way to
                // get a scored answer whose key means nothing.
                onChange(index, {
                  label: event.target.value,
                  value: event.target.value.trim() === '' ? String(index + 1) : event.target.value,
                })
              }
              onBlur={onBlur}
            />
            <Input
              type="number"
              step="0.5"
              value={option.score}
              disabled={!editable}
              aria-label={`Option ${index + 1} score`}
              className="w-24"
              onChange={(event) => onChange(index, { score: Number(event.target.value) })}
              onBlur={onBlur}
            />
            {editable ? (
              <Button
                variant="ghost"
                size="sm"
                aria-label={`Remove option ${index + 1}`}
                onClick={() => onRemove(index)}
              >
                <Trash2 className="size-4" aria-hidden="true" />
              </Button>
            ) : null}
          </li>
        ))}
      </ul>

      {editable ? (
        <Button variant="secondary" size="sm" className="w-fit" onClick={onAdd}>
          <Plus className="size-4" aria-hidden="true" />
          Add option
        </Button>
      ) : null}
    </div>
  );
}

/**
 * What this question measures — the §25 mapping, edited in place.
 *
 * A checkbox set rather than a dropdown because a question can load onto more than one dimension,
 * and because the whole list of what the instrument measures should be visible while deciding. An
 * AI-proposed mapping the author has not touched keeps its unconfirmed state and gets a Confirm
 * button; one the author ticks here is confirmed by the act of ticking it (they are the human §25
 * asks for).
 */
function MappingEditor({
  question,
  dimensions,
  codes,
  editable,
  onToggle,
  onConfirm,
  isConfirming,
}: {
  question: AuthorQuestion;
  dimensions: BuilderDimension[];
  codes: string[];
  editable: boolean;
  onToggle: (code: string) => void;
  onConfirm: (mappingId: string) => void;
  isConfirming: boolean;
}) {
  const unconfirmed = question.dimensions.filter((mapping) => !mapping.confirmed);

  if (dimensions.length === 0) {
    return (
      <div className="flex flex-col gap-1.5">
        <Label>What this measures</Label>
        <p className="text-sm text-muted-foreground">
          This assessment has no dimensions, so it will publish as an ungraded survey. Add
          dimensions above to score it.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <Label>What this question measures</Label>

      <div className="flex flex-wrap gap-2">
        {dimensions.map((dimension) => {
          const checked = codes.includes(dimension.code);

          return (
            <label
              key={dimension.code}
              className={cn(
                'flex cursor-pointer items-center gap-2 border px-3 py-1.5 text-sm transition-colors',
                checked
                  ? 'border-primary bg-primary/10 text-foreground'
                  : 'border-border text-muted-foreground hover:bg-secondary',
                !editable && 'cursor-not-allowed opacity-60',
              )}
            >
              <input
                type="checkbox"
                checked={checked}
                disabled={!editable}
                /* Explicit, because the visible label is a code and a name in two spans — a screen
                   reader should hear the claim being made, not "TM Time Management". */
                aria-label={`Measures ${dimension.name}`}
                className="size-3.5 accent-primary"
                onChange={() => onToggle(dimension.code)}
              />
              <span className="font-mono text-xs">{dimension.code}</span>
              <span>{dimension.name}</span>
            </label>
          );
        })}
      </div>

      {unconfirmed.length > 0 ? (
        <div className="mt-1 flex flex-col gap-2 border border-accent/30 bg-accent/5 p-3">
          <p className="text-sm text-foreground">
            <AlertTriangle className="mr-1 inline size-4 text-accent" aria-hidden="true" />
            {unconfirmed.length === 1 ? 'This mapping was' : 'These mappings were'} proposed by AI
            and {unconfirmed.length === 1 ? 'has' : 'have'} not been confirmed. This version cannot
            publish until a person confirms {unconfirmed.length === 1 ? 'it' : 'each one'}.
          </p>
          <div className="flex flex-wrap gap-2">
            {unconfirmed.map((mapping) => (
              <Button
                key={mapping.mapping_id}
                variant="secondary"
                size="sm"
                disabled={isConfirming || !editable}
                onClick={() => onConfirm(mapping.mapping_id)}
              >
                <Check className="size-4" aria-hidden="true" />
                Confirm “{mapping.name}”
              </Button>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

/**
 * The question as a student will see it — **including what they will not see**.
 *
 * Scores and dimensions are absent here, exactly as `serializeQuestion` omits them from the player
 * payload. That is the preview's real job: an author who has been staring at "Agree (4)" all
 * afternoon should be able to check that the item still reads as a neutral question.
 */
function QuestionPreview({
  text,
  type,
  required,
  section,
  options,
}: {
  text: string;
  type: QuestionType;
  required: boolean;
  section: string;
  options: QuestionOptionDraft[];
}) {
  return (
    <div className="border border-border bg-background p-5">
      <p className="mb-3 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        Student’s view
      </p>

      {section.trim() === '' ? null : (
        <p className="mb-3 border-b border-border pb-2 text-sm font-semibold text-foreground">
          {section}
        </p>
      )}

      <p className="text-base text-foreground">
        {text.trim() === '' ? (
          <span className="italic text-muted-foreground">Untitled question</span>
        ) : (
          text
        )}
        {required ? <span className="ml-1 text-destructive">*</span> : null}
      </p>

      <ul className="mt-4 flex flex-col gap-2">
        {options.map((option, index) => (
          <li key={index}>
            <span className="flex items-center gap-2.5 border border-border px-3 py-2 text-sm text-foreground/90">
              <span
                className={cn(
                  'size-4 shrink-0 border border-muted-foreground/50',
                  type === 'LIKERT' ? 'rounded-none' : 'rounded-full',
                )}
                aria-hidden="true"
              />
              {option.label}
            </span>
          </li>
        ))}
      </ul>

      <p className="mt-4 text-xs text-muted-foreground">
        Scores and dimensions are never sent to a student — that is why they are not shown here.
      </p>
    </div>
  );
}

/** Three states a boolean cannot express: unsaved, writing, safe. */
function SaveIndicator({
  status,
  editable,
}: {
  status: ReturnType<typeof useQuestionAutosave>['status'];
  editable: boolean;
}) {
  if (!editable) {
    return <Badge tone="outline">Read-only</Badge>;
  }

  if (status === 'saving') {
    return (
      <span className="flex items-center gap-1 text-xs text-muted-foreground" role="status">
        <Loader2 className="size-3 animate-spin" aria-hidden="true" />
        Saving…
      </span>
    );
  }

  if (status === 'pending') {
    return <span className="text-xs text-muted-foreground">Unsaved changes…</span>;
  }

  if (status === 'saved') {
    return (
      <span className="flex items-center gap-1 text-xs text-muted-foreground" role="status">
        <Check className="size-3" aria-hidden="true" />
        Saved
      </span>
    );
  }

  return null;
}
