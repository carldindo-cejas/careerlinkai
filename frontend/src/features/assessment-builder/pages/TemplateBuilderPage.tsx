import { Copy } from 'lucide-react';
import { useRef, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';

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
  useArchiveVersion,
  useBuilderTemplate,
  useCreateVersion,
  useDuplicateVersion,
  useGenerateFromDescription,
  useGenerateFromDocument,
  useGenerationStatus,
  usePublishVersion,
  useRestoreVersion,
  useVersionReview,
  type GenerationProgress,
} from '@/features/assessment-builder/hooks/useBuilder';
import { useCopyAssessment } from '@/features/assessment-builder/hooks/useAssessments';
import { extractText, ExtractionError } from '@/features/admin/utils/extractText';
import { toast } from '@/stores/toastStore';
import type { BuilderDimension, BuilderTemplate, VersionReview } from '@/types/builder';

/**
 * The assessment builder + the §31 review screen (Phase 5b — FULLPLAN §25, §31).
 *
 * One page carries the whole flow because §31 describes one flow: dimensions → a DRAFT
 * version → questions (typed by hand, or drafted by AI from a document or a description) →
 * **per-mapping human confirmation** → publish. The confirm buttons are deliberately one per
 * mapping with no "approve all": the §25 gate's entire point is that a human actually looked
 * at each dimension assignment, and the UI does not offer a way to not look.
 *
 * ## Who can be here, and what they can do
 *
 * Since backend 0037 a counselor may **open** a curated global instrument — they assign it, they
 * answer students' questions about it, and they can now take their own copy — but may not write to
 * it. The server says which of those applies, on the payload, as `can_manage`; this page renders
 * from that answer rather than re-deriving it from `ownership`. A rule written twice is a rule that
 * eventually disagrees with itself, and the copy that cannot be enforced is the one that drifts.
 *
 * Read-only here means every authoring control is absent and **Make my own copy** is offered in
 * their place — which is the honest next step, not a consolation: the copy is a new instrument the
 * counselor owns outright, carrying these same sixty questions as a draft they can edit.
 */
export function TemplateBuilderPage() {
  const { templateId } = useParams<{ templateId: string }>();
  const { data: template, isLoading, isError, error } = useBuilderTemplate(templateId!);
  const navigate = useNavigate();
  const location = useLocation();
  const base = location.pathname.startsWith('/admin') ? '/admin' : '/counselor';
  const copy = useCopyAssessment();

  const [selectedVersionId, setSelectedVersionId] = useState<string | null>(null);

  if (isLoading) {
    return <p className="text-sm text-muted-foreground">Loading template…</p>;
  }

  if (isError || !template) {
    return <Alert>We could not load this template. {error?.message}</Alert>;
  }

  /**
   * **Absent means no.** `can_manage` is optional on the type because one caller (the assign
   * picker's list) serializes templates without permissions — and "not stated" must read as refused
   * rather than as permitted, or a payload shape change would quietly unlock the authoring controls.
   */
  const canManage = template.can_manage === true;
  const canCopy = template.can_copy === true;

  const versions = template.versions ?? [];
  const activeVersionId =
    selectedVersionId ?? versions.find((version) => version.status === 'DRAFT')?.id ?? versions[0]?.id ?? null;

  async function onCopy() {
    if (template === undefined) return;

    try {
      const result = await copy.mutateAsync(template.id);

      toast.success(
        `Copied into “${result.assessment.title}” — ${result.question_count} questions, as a draft you own.`,
      );

      navigate(`${base}/assessment-templates/${result.assessment.id}`);
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : 'The copy could not be made.');
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          {/* `flex-wrap` and `break-words`: a long instrument title plus two badges does not fit on
              one line at 360 px, and a heading that overflows takes the page's width with it. */}
          <h1 className="flex flex-wrap items-center gap-2 text-xl font-semibold text-foreground">
            <span className="break-words">{template.title}</span>
            <Badge>{template.category}</Badge>
            <Badge>{template.ownership === 'GLOBAL' ? 'Shared' : 'Private'}</Badge>
          </h1>
          <p className="text-sm text-muted-foreground">
            {canManage
              ? 'Dimensions first, then a version, then questions — by hand or drafted with AI. Nothing publishes until every AI-proposed mapping has been confirmed by a person.'
              : 'You can read this instrument and assign it to your classes. Editing it means taking your own copy.'}
          </p>
        </div>

        {canCopy ? (
          <Button variant={canManage ? 'secondary' : 'primary'} loading={copy.isPending} onClick={() => void onCopy()}>
            <Copy className="size-4" aria-hidden="true" />
            Make my own copy
          </Button>
        ) : null}
      </div>

      {/*
        The read-only explanation, once, at the top — rather than a disabled control on every card
        saying it separately. Someone who cannot edit this page needs to know *why* and *what
        instead*, and both fit in a sentence.
      */}
      {canManage ? null : (
        <Alert tone="info">
          This is a shared instrument managed by an administrator, so it is read-only here. Make your
          own copy to edit the questions — the copy keeps every question, option and scoring mapping,
          as a draft that belongs to you.
        </Alert>
      )}

      <DimensionsCard template={template} canManage={canManage} />
      <VersionsCard
        template={template}
        activeVersionId={activeVersionId}
        onSelect={setSelectedVersionId}
        canManage={canManage}
      />

      {activeVersionId !== null ? (
        <VersionWorkspace
          key={activeVersionId}
          versionId={activeVersionId}
          templateId={template.id}
          onSelectVersion={setSelectedVersionId}
          canManage={canManage}
          /* The template owns the dimensions (they are shared by every version, §12), so they are
             passed down rather than re-fetched inside the workspace. */
          dimensions={template.dimensions ?? []}
        />
      ) : null}
    </div>
  );
}

// --- Dimensions --------------------------------------------------------------------------------

function DimensionsCard({
  template,
  canManage,
}: {
  template: BuilderTemplate;
  canManage: boolean;
}) {
  const addDimensions = useAddDimensions(template.id);
  const [code, setCode] = useState('');
  const [name, setName] = useState('');

  // Two different reasons the form is absent, and they are not the same sentence: frozen means
  // "nobody can change these any more" (§12), read-only means "not you, not this instrument".
  const frozen =
    !canManage || (template.versions ?? []).some((version) => version.status === 'PUBLISHED');
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
            {canManage
              ? 'A version of this template has published, so its dimensions are frozen.'
              : 'What this instrument measures. Read-only — take your own copy to change it.'}
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

/**
 * The version list — **and the only place an already-published instrument becomes editable again.**
 *
 * "New version" and "Edit a copy" are two different acts and the card offers both, because
 * collapsing them is what made the curated RIASEC and SCCT instruments effectively read-only:
 * their single version is PUBLISHED and therefore frozen (invariant 1), and the only button on
 * offer produced an *empty* v2. Correcting one item meant retyping sixty. "Edit a copy" duplicates
 * the version whole — every question, option, mapping and the scoring config — into a DRAFT, then
 * selects it, so the author lands in the ordinary workspace with the real content in front of them.
 *
 * The frozen version itself is never touched, and remains the one assigned classes are sitting.
 */
function VersionsCard({
  template,
  activeVersionId,
  onSelect,
  canManage,
}: {
  template: BuilderTemplate;
  activeVersionId: string | null;
  onSelect: (versionId: string) => void;
  canManage: boolean;
}) {
  const createVersion = useCreateVersion(template.id);
  const duplicateVersion = useDuplicateVersion(template.id);
  const archiveVersion = useArchiveVersion(template.id);
  const restoreVersion = useRestoreVersion(template.id);
  const versions = template.versions ?? [];
  const busy =
    createVersion.isPending ||
    duplicateVersion.isPending ||
    archiveVersion.isPending ||
    restoreVersion.isPending;

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between">
        <div>
          <CardTitle>Versions</CardTitle>
          <CardDescription>
            {canManage
              ? 'A published version is frozen forever — edit a copy of it and publish that as the next one. "New version" starts empty instead, for a genuinely new edition.'
              : 'Every edition of this instrument. Students always sit the published one.'}
          </CardDescription>
        </div>
        {canManage ? (
          <Button
            variant="secondary"
            disabled={busy}
            onClick={() => createVersion.mutate()}
          >
            New version
          </Button>
        ) : null}
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        {versions.length === 0 ? (
          <p className="text-sm text-muted-foreground">No versions yet — create one to start adding questions.</p>
        ) : (
          <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
            {versions.map((version) => (
              <div key={version.id} className="flex flex-wrap items-center gap-1">
                <Button
                  variant={version.id === activeVersionId ? 'primary' : 'secondary'}
                  onClick={() => onSelect(version.id)}
                >
                  v{version.version_number} · {version.status}
                </Button>
                {/* Only on a frozen version, and only for someone who may write to this template.
                    A DRAFT is already editable in place, and offering to copy it there would invite
                    two half-finished drafts of the same edition. */}
                {canManage && version.status !== 'DRAFT' ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    title={`Copy v${version.version_number}'s questions into a new draft you can edit`}
                    disabled={busy}
                    onClick={() => {
                      void duplicateVersion
                        .mutateAsync(version.id)
                        .then((draft) => onSelect(draft.id))
                        // The mutation's own `isError` renders the message; this keeps the
                        // rejection out of the console as an unhandled promise rejection.
                        .catch(() => undefined);
                    }}
                  >
                    {duplicateVersion.isPending ? 'Copying…' : 'Edit a copy'}
                  </Button>
                ) : null}

                {/*
                  **Archive one edition, published included** (prompt §4).

                  Nothing is deleted: every attempt names its own `assessment_version_id`, so a
                  student's result from last year still resolves to the exact questions it was
                  produced against. What archiving changes is that nobody can *start* it — which is
                  what an author wants of v1 once v2 is out, and is why this is not the same act as
                  archiving the whole instrument.

                  The confirmation says the one thing that is easy to assume wrongly: attempts
                  already under way are untouched. Ending those is closing the assignment (§21).
                */}
                {canManage ? (
                  version.status === 'ARCHIVED' ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      title={`Bring v${version.version_number} back`}
                      disabled={busy}
                      onClick={() => {
                        void restoreVersion.mutateAsync(version.id).catch(() => undefined);
                      }}
                    >
                      Restore
                    </Button>
                  ) : (
                    <Button
                      variant="ghost"
                      size="sm"
                      title={`Retire v${version.version_number} — students can no longer start it`}
                      disabled={busy}
                      onClick={() => {
                        if (
                          !window.confirm(
                            `Archive v${version.version_number}? Students will no longer be able to start it. Results already recorded against it are unchanged, and anyone part-way through keeps their attempt.`,
                          )
                        ) {
                          return;
                        }

                        void archiveVersion.mutateAsync(version.id).catch(() => undefined);
                      }}
                    >
                      Archive
                    </Button>
                  )
                ) : null}
              </div>
            ))}
          </div>
        )}
        {createVersion.isError ? <Alert>{createVersion.error.message}</Alert> : null}
        {duplicateVersion.isError ? <Alert>{duplicateVersion.error.message}</Alert> : null}
        {archiveVersion.isError ? <Alert>{archiveVersion.error.message}</Alert> : null}
        {restoreVersion.isError ? <Alert>{restoreVersion.error.message}</Alert> : null}
      </CardContent>
    </Card>
  );
}

// --- The working version: generation, review, manual questions, publish -------------------------

function VersionWorkspace({
  versionId,
  templateId,
  dimensions,
  onSelectVersion,
  canManage,
}: {
  versionId: string;
  templateId: string;
  dimensions: BuilderDimension[];
  onSelectVersion: (versionId: string) => void;
  canManage: boolean;
}) {
  const duplicateVersion = useDuplicateVersion(templateId);
  const { data: review, isLoading, isError, error } = useVersionReview(versionId);

  if (isLoading) {
    return <p className="text-sm text-muted-foreground">Loading version…</p>;
  }

  if (isError || !review) {
    return <Alert>We could not load this version. {error?.message}</Alert>;
  }

  /**
   * Editable means **both**: this version is a draft (invariant 1 — a published version is frozen
   * forever), and this caller may write to this template at all (0037). The two are independent, and
   * an editor that checked only the first would put a working question editor in front of a
   * counselor whose every keystroke the server 404s.
   */
  const draft = review.status === 'DRAFT' && canManage;

  /**
   * **§5's permanent rule, honoured in the UI as well as the server.** RIASEC and SCCT can never be
   * AI-generated or AI-edited by any principal, and `authorizeGenerateWithAi` refuses them with a
   * 403. Now that a curated instrument can have a DRAFT version — the copy this page's "Edit a
   * copy" makes — a category-blind `draft` check would put the "Draft with AI" panel in front of an
   * author whose every click it 403s. The rule is enforced on the server; this stops the UI from
   * offering an act the system will refuse.
   */
  const aiAllowed = review.template.category === 'CUSTOM';

  return (
    <>
      {/*
        **The read-only explanation, at the point of confusion.**

        Landing on RIASEC shows sixty questions that will not respond to a click, and the reason —
        this version published, and a published version is frozen — is otherwise only inferable from
        a `PUBLISHED` badge three cards up. Saying it here, next to the way out, is what turns
        "these are locked" into "these are edited by copying". The button is the same act as the
        version list's "Edit a copy"; it is repeated because this is where someone discovers they
        need it.
      */}
      {draft || !canManage ? null : (
        <Card>
          <CardHeader className="flex-row flex-wrap items-center justify-between gap-3">
            <div>
              <CardTitle>
                v{review.version_number} is {review.status.toLowerCase()} and
                read-only
              </CardTitle>
              <CardDescription>
                Students who sat this version keep the instrument their answers
                were scored against, so it can never change. Copy it into a
                draft to edit the questions, then publish that draft as the next
                version.
              </CardDescription>
            </div>
            <Button
              disabled={duplicateVersion.isPending}
              onClick={() => {
                void duplicateVersion
                  .mutateAsync(review.id)
                  .then((created) => onSelectVersion(created.id))
                  .catch(() => undefined);
              }}
            >
              {duplicateVersion.isPending ? 'Copying…' : 'Edit a copy'}
            </Button>
          </CardHeader>
          {duplicateVersion.isError ? (
            <CardContent>
              <Alert>{duplicateVersion.error.message}</Alert>
            </CardContent>
          ) : null}
        </Card>
      )}

      {draft && aiAllowed ? <GeneratePanel review={review} /> : null}

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
