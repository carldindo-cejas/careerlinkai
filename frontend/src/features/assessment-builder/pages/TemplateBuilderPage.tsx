import { useRef, useState } from 'react';
import { useParams } from 'react-router-dom';

import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  useAddDimensions,
  useAddQuestions,
  useBuilderTemplate,
  useConfirmMapping,
  useCreateVersion,
  useGenerateFromDescription,
  useGenerateFromDocument,
  useGenerationStatus,
  usePublishVersion,
  useUpdateQuestion,
  useVersionReview,
} from '@/features/assessment-builder/hooks/useBuilder';
import { extractText, ExtractionError } from '@/features/admin/utils/extractText';
import type { AuthorQuestion, BuilderTemplate, VersionReview } from '@/types/builder';

/**
 * The assessment builder + the §31 review screen (Phase 5b — FULLPLAN §25, §31).
 *
 * One page carries the whole flow because §31 describes one flow: dimensions → a DRAFT
 * version → questions (typed by hand, or drafted by AI from a document or a description) →
 * **per-mapping human confirmation** → publish. The confirm buttons are deliberately one per
 * mapping with no "approve all": the §25 gate's entire point is that a human actually looked
 * at each dimension assignment, and the UI does not offer a way to not look.
 */
export function TemplateBuilderPage() {
  const { templateId } = useParams<{ templateId: string }>();
  const { data: template, isLoading, isError, error } = useBuilderTemplate(templateId!);

  const [selectedVersionId, setSelectedVersionId] = useState<string | null>(null);

  if (isLoading) {
    return <p className="text-sm text-slate-500">Loading template…</p>;
  }

  if (isError || !template) {
    return <Alert>We could not load this template. {error?.message}</Alert>;
  }

  const versions = template.versions ?? [];
  const activeVersionId =
    selectedVersionId ?? versions.find((version) => version.status === 'DRAFT')?.id ?? versions[0]?.id ?? null;

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="flex items-center gap-2 text-xl font-semibold text-slate-900">
          {template.title}
          <Badge>{template.category}</Badge>
          <Badge>{template.ownership === 'GLOBAL' ? 'Global' : 'Private'}</Badge>
        </h1>
        <p className="text-sm text-slate-500">
          Dimensions first, then a version, then questions — by hand or drafted with AI. Nothing
          publishes until every AI-proposed mapping has been confirmed by a person.
        </p>
      </div>

      <DimensionsCard template={template} />
      <VersionsCard
        template={template}
        activeVersionId={activeVersionId}
        onSelect={setSelectedVersionId}
      />

      {activeVersionId !== null ? (
        <VersionWorkspace key={activeVersionId} versionId={activeVersionId} templateId={template.id} />
      ) : null}
    </div>
  );
}

// --- Dimensions --------------------------------------------------------------------------------

function DimensionsCard({ template }: { template: BuilderTemplate }) {
  const addDimensions = useAddDimensions(template.id);
  const [code, setCode] = useState('');
  const [name, setName] = useState('');

  const frozen = (template.versions ?? []).some((version) => version.status === 'PUBLISHED');
  const dimensions = template.dimensions ?? [];

  return (
    <Card>
      <CardHeader>
        <CardTitle>Dimensions</CardTitle>
        <CardDescription>
          What this assessment measures. AI generation maps questions onto exactly these — none
          defined means an ungraded survey. Dimensions freeze permanently once any version
          publishes.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {dimensions.length === 0 ? (
          <p className="text-sm text-slate-500">None yet — this would publish as an ungraded survey.</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {dimensions.map((dimension) => (
              <Badge key={dimension.code}>
                {dimension.code} · {dimension.name}
              </Badge>
            ))}
          </div>
        )}

        {frozen ? (
          <p className="text-sm text-slate-400">
            A version of this template has published, so its dimensions are frozen.
          </p>
        ) : (
          <div className="flex items-end gap-3">
            <div>
              <Label htmlFor="dimension-code">Code</Label>
              <Input
                id="dimension-code"
                value={code}
                placeholder="TM"
                onChange={(event) => setCode(event.target.value.toUpperCase())}
              />
            </div>
            <div className="flex-1">
              <Label htmlFor="dimension-name">Name</Label>
              <Input
                id="dimension-name"
                value={name}
                placeholder="Time Management"
                onChange={(event) => setName(event.target.value)}
              />
            </div>
            <Button
              variant="secondary"
              disabled={addDimensions.isPending || code.trim() === '' || name.trim() === ''}
              onClick={() => {
                addDimensions.mutate([{ code: code.trim(), name: name.trim() }]);
                setCode('');
                setName('');
              }}
            >
              Add dimension
            </Button>
          </div>
        )}

        {addDimensions.isError ? <Alert>{addDimensions.error.message}</Alert> : null}
      </CardContent>
    </Card>
  );
}

// --- Versions ----------------------------------------------------------------------------------

function VersionsCard({
  template,
  activeVersionId,
  onSelect,
}: {
  template: BuilderTemplate;
  activeVersionId: string | null;
  onSelect: (versionId: string) => void;
}) {
  const createVersion = useCreateVersion(template.id);
  const versions = template.versions ?? [];

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between">
        <div>
          <CardTitle>Versions</CardTitle>
          <CardDescription>
            A published version is frozen forever — fix a mistake by publishing the next one.
          </CardDescription>
        </div>
        <Button
          variant="secondary"
          disabled={createVersion.isPending}
          onClick={() => createVersion.mutate()}
        >
          New version
        </Button>
      </CardHeader>
      <CardContent className="flex flex-wrap gap-2">
        {versions.length === 0 ? (
          <p className="text-sm text-slate-500">No versions yet — create one to start adding questions.</p>
        ) : (
          versions.map((version) => (
            <Button
              key={version.id}
              variant={version.id === activeVersionId ? 'primary' : 'secondary'}
              onClick={() => onSelect(version.id)}
            >
              v{version.version_number} · {version.status}
            </Button>
          ))
        )}
        {createVersion.isError ? <Alert>{createVersion.error.message}</Alert> : null}
      </CardContent>
    </Card>
  );
}

// --- The working version: generation, review, manual questions, publish -------------------------

function VersionWorkspace({ versionId, templateId }: { versionId: string; templateId: string }) {
  const { data: review, isLoading, isError, error } = useVersionReview(versionId);

  if (isLoading) {
    return <p className="text-sm text-slate-500">Loading version…</p>;
  }

  if (isError || !review) {
    return <Alert>We could not load this version. {error?.message}</Alert>;
  }

  const draft = review.status === 'DRAFT';

  return (
    <>
      {draft ? <GeneratePanel review={review} /> : null}
      <ReviewCard review={review} draft={draft} />
      {draft ? <ManualQuestionCard review={review} /> : null}
      {draft ? <PublishCard review={review} templateId={templateId} /> : null}
    </>
  );
}

/** §31's two entry modes, side by side. Mode A reuses the §33 browser extraction utility. */
function GeneratePanel({ review }: { review: VersionReview }) {
  const generateFromDescription = useGenerateFromDescription(review.id);
  const generateFromDocument = useGenerateFromDocument(review.id);
  const [description, setDescription] = useState('');
  const [aiRequestId, setAiRequestId] = useState<string | null>(null);
  const [extractionProblem, setExtractionProblem] = useState<string | null>(null);
  const [extracting, setExtracting] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const status = useGenerationStatus(aiRequestId, review.id);

  async function handleFile(file: File) {
    setExtractionProblem(null);
    setExtracting(true);

    try {
      const text = await extractText(file);
      const queued = await generateFromDocument.mutateAsync(text);

      setAiRequestId(queued.ai_request_id);
    } catch (cause) {
      setExtractionProblem(
        cause instanceof ExtractionError || cause instanceof Error
          ? cause.message
          : 'The generation request failed.',
      );
    } finally {
      setExtracting(false);

      if (fileInput.current) {
        fileInput.current.value = '';
      }
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Draft with AI</CardTitle>
        <CardDescription>
          Either mode produces an <strong>unconfirmed draft</strong>: every question lands marked
          AI-generated, and every proposed scoring mapping must be individually confirmed below
          before this version can publish.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div>
          <Label htmlFor="generate-description">From a description</Label>
          <Textarea
            id="generate-description"
            value={description}
            placeholder='e.g. "A 12-question Likert survey about study habits, across Time Management and Focus."'
            onChange={(event) => setDescription(event.target.value)}
          />
          <div className="mt-2">
            <Button
              disabled={generateFromDescription.isPending || description.trim().length < 20}
              onClick={() =>
                void generateFromDescription
                  .mutateAsync(description.trim())
                  .then((queued) => setAiRequestId(queued.ai_request_id))
              }
            >
              {generateFromDescription.isPending ? 'Queuing…' : 'Generate from description'}
            </Button>
          </div>
        </div>

        <div>
          <Label htmlFor="generate-file">From a document (PDF/DOCX — extracted in your browser)</Label>
          <input
            id="generate-file"
            ref={fileInput}
            type="file"
            accept=".pdf,.docx"
            className="block text-sm text-slate-600 file:mr-3 file:rounded-md file:border-0 file:bg-slate-100 file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-slate-700 hover:file:bg-slate-200"
            disabled={extracting || generateFromDocument.isPending}
            onChange={(event) => {
              const file = event.target.files?.[0];

              if (file) {
                void handleFile(file);
              }
            }}
          />
          {extracting ? <p className="text-sm text-slate-500">Extracting text…</p> : null}
        </div>

        {generateFromDescription.isError ? <Alert>{generateFromDescription.error.message}</Alert> : null}
        {generateFromDocument.isError ? <Alert>{generateFromDocument.error.message}</Alert> : null}
        {extractionProblem ? <Alert>{extractionProblem}</Alert> : null}

        {aiRequestId !== null ? (
          <div className="rounded-md bg-slate-50 p-3 text-sm text-slate-700">
            {status.data === undefined || status.data.status === 'PENDING' ? (
              <p>Generating… the draft appears below when it lands (this can take a minute).</p>
            ) : null}
            {status.data?.status === 'DRAFTED' ? (
              <div className="flex flex-col gap-1">
                <p>
                  Draft ready: <strong>{status.data.question_count} question(s)</strong> added below
                  for review.
                </p>
                {(status.data.suggested_dimensions?.length ?? 0) > 0 ? (
                  <p className="text-slate-500">
                    The AI also suggested dimensions (inert until you add one yourself):{' '}
                    {status.data.suggested_dimensions!
                      .map((suggestion) => suggestion.name)
                      .join(', ')}
                  </p>
                ) : null}
              </div>
            ) : null}
            {status.data?.status === 'FAILED' || status.data?.status === 'VALIDATION_FAILED' ? (
              <p>
                Generation failed and nothing was drafted — {status.data.failure_reason ?? 'the model was unavailable'}.
                You can request a fresh generation.
              </p>
            ) : null}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

/** The §31 review list: everything the player payload hides, shown to the person confirming it. */
function ReviewCard({ review, draft }: { review: VersionReview; draft: boolean }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          Questions · v{review.version_number} <Badge>{review.status}</Badge>
        </CardTitle>
        <CardDescription>
          {review.publish_readiness.total > 0
            ? `${review.publish_readiness.confirmed} of ${review.publish_readiness.total} scoring mappings confirmed.`
            : 'No scoring mappings — this version would publish as an ungraded survey.'}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {review.questions.length === 0 ? (
          <p className="text-sm text-slate-500">No questions yet.</p>
        ) : (
          review.questions.map((question) => (
            <QuestionRow key={question.id} question={question} versionId={review.id} draft={draft} />
          ))
        )}
      </CardContent>
    </Card>
  );
}

function QuestionRow({
  question,
  versionId,
  draft,
}: {
  question: AuthorQuestion;
  versionId: string;
  draft: boolean;
}) {
  const confirm = useConfirmMapping(versionId);
  const update = useUpdateQuestion(versionId);
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(question.question_text);

  return (
    <div className="rounded-md border border-slate-200 p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1">
          {editing ? (
            <div className="flex flex-col gap-2">
              <Textarea value={text} onChange={(event) => setText(event.target.value)} />
              <div className="flex gap-2">
                <Button
                  disabled={update.isPending || text.trim().length === 0}
                  onClick={() =>
                    void update
                      .mutateAsync({ questionId: question.id, question_text: text.trim() })
                      .then(() => setEditing(false))
                  }
                >
                  Save
                </Button>
                <Button variant="secondary" onClick={() => setEditing(false)}>
                  Cancel
                </Button>
              </div>
            </div>
          ) : (
            <p className="text-sm text-slate-800">
              {question.order_number}. {question.question_text}
            </p>
          )}

          <p className="mt-1 text-xs text-slate-500">
            {question.options.map((option) => `${option.label} (${option.score})`).join (' · ')}
          </p>
        </div>

        <div className="flex items-center gap-2">
          {question.source === 'AI_GENERATED' ? <Badge>AI draft</Badge> : <Badge>Manual</Badge>}
          {draft && !editing ? (
            <Button variant="secondary" onClick={() => setEditing(true)}>
              Edit
            </Button>
          ) : null}
        </div>
      </div>

      {question.dimensions.length > 0 ? (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          {question.dimensions.map((mapping) => (
            <span key={mapping.mapping_id} className="flex items-center gap-1">
              <Badge tone={mapping.confirmed ? 'success' : undefined}>
                measures {mapping.name}
                {mapping.confirmed ? ' ✓' : ' — unconfirmed'}
              </Badge>
              {draft && !mapping.confirmed ? (
                <Button
                  variant="secondary"
                  disabled={confirm.isPending}
                  onClick={() => confirm.mutate(mapping.mapping_id)}
                >
                  Confirm
                </Button>
              ) : null}
            </span>
          ))}
        </div>
      ) : null}

      {confirm.isError ? <Alert>{confirm.error.message}</Alert> : null}
      {update.isError ? <Alert>{update.error.message}</Alert> : null}
    </div>
  );
}

/** The manual editor — a typed question is confirmed at insert (§25: a human wrote it). */
function ManualQuestionCard({ review }: { review: VersionReview }) {
  const addQuestions = useAddQuestions(review.id);
  const [text, setText] = useState('');
  const [dimensionCode, setDimensionCode] = useState('');

  const LIKERT_OPTIONS = [
    { label: 'Strongly Agree', value: 'strongly_agree', score: 5 },
    { label: 'Agree', value: 'agree', score: 4 },
    { label: 'Neutral', value: 'neutral', score: 3 },
    { label: 'Disagree', value: 'disagree', score: 2 },
    { label: 'Strongly Disagree', value: 'strongly_disagree', score: 1 },
  ];

  return (
    <Card>
      <CardHeader>
        <CardTitle>Add a question by hand</CardTitle>
        <CardDescription>
          A 5-point Likert item. Typed questions need no review step — you are the human.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div>
          <Label htmlFor="manual-question">Question</Label>
          <Textarea
            id="manual-question"
            value={text}
            placeholder="I review my notes within a day of each class."
            onChange={(event) => setText(event.target.value)}
          />
        </div>
        <div className="flex items-end gap-3">
          <div>
            <Label htmlFor="manual-dimension">Dimension code (blank = unscored)</Label>
            <Input
              id="manual-dimension"
              value={dimensionCode}
              placeholder="TM"
              onChange={(event) => setDimensionCode(event.target.value.toUpperCase())}
            />
          </div>
          <Button
            variant="secondary"
            disabled={addQuestions.isPending || text.trim().length === 0}
            onClick={() => {
              addQuestions.mutate([
                {
                  question_text: text.trim(),
                  question_type: 'LIKERT',
                  options: LIKERT_OPTIONS,
                  dimension_codes: dimensionCode.trim() === '' ? [] : [dimensionCode.trim()],
                },
              ]);
              setText('');
            }}
          >
            {addQuestions.isPending ? 'Adding…' : 'Add question'}
          </Button>
        </div>
        {addQuestions.isError ? <Alert>{addQuestions.error.message}</Alert> : null}
      </CardContent>
    </Card>
  );
}

function PublishCard({ review, templateId }: { review: VersionReview; templateId: string }) {
  const publish = usePublishVersion(review.id, templateId);
  const { remaining, total, confirmed } = review.publish_readiness;
  const blocked = remaining > 0 || review.questions.length === 0;

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between">
        <div>
          <CardTitle>Publish v{review.version_number}</CardTitle>
          <CardDescription>
            {review.questions.length === 0
              ? 'A version needs at least one question.'
              : remaining > 0
                ? `${remaining} of ${total} mappings still need a human confirmation.`
                : total > 0
                  ? `All ${confirmed} mappings confirmed — ready to publish.`
                  : 'Ungraded survey — ready to publish once the questions read well.'}
          </CardDescription>
        </div>
        <Button disabled={blocked || publish.isPending} onClick={() => publish.mutate()}>
          {publish.isPending ? 'Publishing…' : 'Publish'}
        </Button>
      </CardHeader>
      {publish.isError ? (
        <CardContent>
          <Alert>{publish.error.message}</Alert>
        </CardContent>
      ) : null}
      {publish.isSuccess ? (
        <CardContent>
          <p className="text-sm text-slate-600">
            Published. This version is now frozen and can be assigned to classes.
          </p>
        </CardContent>
      ) : null}
    </Card>
  );
}
