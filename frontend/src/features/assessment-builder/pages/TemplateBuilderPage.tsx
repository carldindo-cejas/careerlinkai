import { useRef, useState } from 'react';
import { useParams } from 'react-router-dom';

import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { QuestionWorkspace } from '@/features/assessment-builder/components/QuestionWorkspace';
import {
  useAddDimensions,
  useBuilderTemplate,
  useCreateVersion,
  useGenerateFromDescription,
  useGenerateFromDocument,
  useGenerationStatus,
  usePublishVersion,
  useVersionReview,
  type GenerationProgress,
} from '@/features/assessment-builder/hooks/useBuilder';
import { extractText, ExtractionError } from '@/features/admin/utils/extractText';
import type { BuilderDimension, BuilderTemplate, VersionReview } from '@/types/builder';

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
    return <p className="text-sm text-muted-foreground">Loading template…</p>;
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
        <h1 className="flex items-center gap-2 text-xl font-semibold text-foreground">
          {template.title}
          <Badge>{template.category}</Badge>
          <Badge>{template.ownership === 'GLOBAL' ? 'Global' : 'Private'}</Badge>
        </h1>
        <p className="text-sm text-muted-foreground">
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
        <VersionWorkspace
          key={activeVersionId}
          versionId={activeVersionId}
          templateId={template.id}
          /* The template owns the dimensions (they are shared by every version, §12), so they are
             passed down rather than re-fetched inside the workspace. */
          dimensions={template.dimensions ?? []}
        />
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
          <p className="text-sm text-muted-foreground">None yet — this would publish as an ungraded survey.</p>
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
          <p className="text-sm text-muted-foreground">
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
          <p className="text-sm text-muted-foreground">No versions yet — create one to start adding questions.</p>
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

function VersionWorkspace({
  versionId,
  templateId,
  dimensions,
}: {
  versionId: string;
  templateId: string;
  dimensions: BuilderDimension[];
}) {
  const { data: review, isLoading, isError, error } = useVersionReview(versionId);

  if (isLoading) {
    return <p className="text-sm text-muted-foreground">Loading version…</p>;
  }

  if (isError || !review) {
    return <Alert>We could not load this version. {error?.message}</Alert>;
  }

  const draft = review.status === 'DRAFT';

  return (
    <>
      {draft ? <GeneratePanel review={review} /> : null}

      {/*
        The workspace replaces what used to be two cards — a read-only review list and a separate
        "add a question by hand" form. Splitting them meant an author added an item at the bottom of
        the page and then scrolled up to find it, could not reorder anything, and could only edit the
        question *text*: type, options and the scoring mapping were all fixed at creation. One
        editable surface is what the §31 review step and manual authoring were always describing.

        `key` on the version id so switching versions resets the selection rather than pointing the
        editor at a question that belongs to a different version.
      */}
      <QuestionWorkspace
        key={review.id}
        review={review}
        dimensions={dimensions}
        editable={draft}
      />

      {draft ? <PublishCard review={review} templateId={templateId} /> : null}
    </>
  );
}

/**
 * §31's two entry modes, side by side. Mode A reuses the §33 browser extraction utility.
 *
 * Mode A has three phases the reviewer should be able to tell apart, because they fail for
 * completely different reasons: parsing the file (a scanned PDF has no text layer), posting the
 * extracted text (auth, rate limit, a version that published underneath them), and then the queued
 * generation itself. They used to share one `extracting` boolean and one "Extracting text…" line,
 * so a slow upload read as a slow parse.
 */
type DocumentPhase = 'idle' | 'extracting' | 'queuing';

function GeneratePanel({ review }: { review: VersionReview }) {
  const generateFromDescription = useGenerateFromDescription(review.id);
  const generateFromDocument = useGenerateFromDocument(review.id);
  const [description, setDescription] = useState('');
  const [aiRequestId, setAiRequestId] = useState<string | null>(null);
  const [extractionProblem, setExtractionProblem] = useState<string | null>(null);
  const [documentPhase, setDocumentPhase] = useState<DocumentPhase>('idle');
  const fileInput = useRef<HTMLInputElement>(null);

  const status = useGenerationStatus(aiRequestId, review.id);
  const busy = documentPhase !== 'idle' || generateFromDescription.isPending || status.isPolling;

  async function handleFile(file: File) {
    setExtractionProblem(null);
    // A retry must not leave the previous attempt's outcome on screen while the new one runs.
    setAiRequestId(null);
    setDocumentPhase('extracting');

    try {
      const text = await extractText(file);

      setDocumentPhase('queuing');

      const queued = await generateFromDocument.mutateAsync(text);

      setAiRequestId(queued.ai_request_id);
    } catch (cause) {
      setExtractionProblem(
        cause instanceof ExtractionError || cause instanceof Error
          ? cause.message
          : 'The generation request failed.',
      );
    } finally {
      setDocumentPhase('idle');

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
              disabled={busy || description.trim().length < 20}
              onClick={() => {
                setExtractionProblem(null);
                setAiRequestId(null);

                void generateFromDescription
                  .mutateAsync(description.trim())
                  .then((queued) => setAiRequestId(queued.ai_request_id))
                  // The mutation's own `isError` renders the message; this keeps the rejection
                  // from surfacing as an unhandled promise rejection in the console.
                  .catch(() => undefined);
              }}
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
            className="block text-sm text-muted-foreground file:mr-3 file:rounded-none file:border-0 file:bg-secondary file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-foreground/80 hover:file:bg-secondary"
            disabled={busy}
            onChange={(event) => {
              const file = event.target.files?.[0];

              if (file) {
                void handleFile(file);
              }
            }}
          />
          {documentPhase === 'extracting' ? (
            <p className="mt-1 text-sm text-muted-foreground" role="status" aria-live="polite">
              Reading the document in your browser…
            </p>
          ) : null}
          {documentPhase === 'queuing' ? (
            <p className="mt-1 text-sm text-muted-foreground" role="status" aria-live="polite">
              Text extracted — sending it for generation…
            </p>
          ) : null}
        </div>

        {generateFromDescription.isError ? <Alert>{generateFromDescription.error.message}</Alert> : null}
        {generateFromDocument.isError ? <Alert>{generateFromDocument.error.message}</Alert> : null}
        {extractionProblem ? <Alert>{extractionProblem}</Alert> : null}

        {aiRequestId !== null ? <GenerationProgressPanel progress={status} /> : null}
      </CardContent>
    </Card>
  );
}

/**
 * The live state of one queued generation (§20's poll, rendered).
 *
 * Every branch here is reachable and terminal-or-progressing — there is no "and otherwise keep
 * spinning" fallthrough, which is what the previous version amounted to: anything that was not
 * DRAFTED, FAILED or VALIDATION_FAILED (including a status the client did not recognise, or a poll
 * that had stopped answering) rendered as "Generating…", indefinitely and identically to real
 * progress. A spinner has to be a claim the code can defend.
 */
function GenerationProgressPanel({ progress }: { progress: GenerationProgress }) {
  const { data, isPolling, timedOut, pollError } = progress;

  if (timedOut) {
    return (
      <Alert>
        Generation did not finish in time and has been abandoned. Nothing was drafted — please
        request a fresh generation. If this keeps happening, the AI queue consumer may not be
        running in this environment.
      </Alert>
    );
  }

  if (pollError !== null) {
    return (
      <Alert>
        We lost contact with the server while waiting for this draft — {pollError.message}. The
        generation may still complete; reload this page to check.
      </Alert>
    );
  }

  if (data?.status === 'FAILED' || data?.status === 'VALIDATION_FAILED') {
    return (
      <Alert>
        Generation failed and nothing was drafted —{' '}
        {data.failure_reason ?? 'the model was unavailable'} You can request a fresh generation.
      </Alert>
    );
  }

  if (data?.status === 'DRAFTED') {
    return (
      <div className="flex flex-col gap-1 rounded-none border border-border bg-muted p-3 text-sm text-foreground/80">
        <p>
          Draft ready: <strong>{data.question_count} question(s)</strong> added below for review.
          Confirm each scoring mapping before publishing.
        </p>
        {(data.suggested_dimensions?.length ?? 0) > 0 ? (
          <p className="text-muted-foreground">
            The AI also suggested dimensions (inert until you add one yourself):{' '}
            {data.suggested_dimensions!.map((suggestion) => suggestion.name).join(', ')}
          </p>
        ) : null}
      </div>
    );
  }

  if (isPolling) {
    return (
      <div
        className="flex items-center gap-2 rounded-none bg-muted p-3 text-sm text-foreground/80"
        role="status"
        aria-live="polite"
      >
        <span
          aria-hidden
          className="size-3 shrink-0 animate-spin rounded-full border-2 border-foreground/25 border-t-foreground/70"
        />
        <span>
          {data?.status === 'PROCESSING'
            ? 'Drafting your questions — the model is working. They appear below when they land.'
            : 'Queued for generation — waiting for a worker to pick this up.'}
        </span>
      </div>
    );
  }

  return null;
}

/*
  `ReviewCard`, `QuestionRow` and `ManualQuestionCard` lived here and are now `QuestionWorkspace`.

  They were three components doing one job badly: a read-only list, an inline text-only editor, and
  a bottom-of-page "add a question" form. Reordering was impossible, a question's type and options
  were fixed at creation, and confirming a mapping meant hunting for the item it belonged to. The
  workspace is one editable surface with the same rules behind it — MANUAL means confirmed (§25),
  a published version is frozen (invariant 1), and there is still no "confirm all" shortcut (§31).
*/

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
          <p className="text-sm text-muted-foreground">
            Published. This version is now frozen and can be assigned to classes.
          </p>
        </CardContent>
      ) : null}
    </Card>
  );
}
