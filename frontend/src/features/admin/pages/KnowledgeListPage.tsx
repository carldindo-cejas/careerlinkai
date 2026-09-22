import { FilePlus2, FileUp, MessageSquarePlus, RefreshCw } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';

import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { cn } from '@/components/ui/cn';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Pagination } from '@/components/ui/pagination';
import { SearchInput } from '@/components/ui/search-input';
import { Select } from '@/components/ui/select';
import {
  useArchiveKnowledgeDocument,
  useCreateKnowledgeEntry,
  useKnowledgeDocuments,
  useKnowledgeEntryContent,
  useKnowledgeScope,
  useRemoveKnowledgeDocument,
  useReprocessKnowledgeDocument,
  useUnarchiveKnowledgeDocument,
  useSyncCatalogKnowledge,
  useUpdateKnowledgeEntry,
  useUploadKnowledgeDocument,
} from '@/features/admin/hooks/useAiKnowledge';
import { extractText, ExtractionError } from '@/features/admin/utils/extractText';
import { useListFilters } from '@/hooks/useListFilters';
import type { KnowledgeListQuery } from '@/services/aiApi';
import { toast } from '@/stores/toastStore';
import type {
  KnowledgeDocument,
  KnowledgeEntryPayload,
  KnowledgeSourceType,
  ProcessingStatus,
} from '@/types/ai';

/**
 * Knowledge documents (FULLPLAN §33, §37 — Phase 5a).
 *
 * The pipeline this page fronts: pick a PDF/DOCX → the text is extracted **in this browser**
 * (§33 v1.5 — the Free-plan Worker has nowhere to run a parser) → the raw file and the text upload
 * together → a queue job chunks and embeds the text → the document becomes retrievable by the §30
 * explanation pipeline. `COMPLETED` means the vectors were accepted; Vectorize indexes
 * asynchronously, so brand-new content can take a little longer to surface in answers.
 *
 * ## Why this screen was rebuilt (prompt-driven)
 *
 * It used to open with three stacked cards — write an entry, sync the catalog, upload a file — each
 * with its own explanation, before a single piece of knowledge appeared. Adding something is the
 * *rare* act and reading the library is the common one, so the page led with the thing nobody came
 * for and pushed the thing everybody did below the fold. Every entry was then a full Card with its
 * own header, so twenty entries were a very long scroll.
 *
 * Now: the three ways in are buttons that open modals, entries are one dense row each, and the two
 * halves of the library — live and archived — are separate tabs with their own pagination rather
 * than one list where retired entries sit among working ones.
 */

/** Which half of the library is on screen. Each paginates over its own total. */
type LibraryTab = 'live' | 'archived';

/** Which "add something" modal is open, if any. */
type OpenDialog = 'qa' | 'text' | 'upload' | 'sync' | null;

export function KnowledgeListPage() {
  const filters = useListFilters<ProcessingStatus>();
  const scope = useKnowledgeScope();
  const isAdmin = scope === 'admin';
  const [tab, setTab] = useState<LibraryTab>('live');
  const [dialog, setDialog] = useState<OpenDialog>(null);

  /**
   * Whose entries to show — the admin's "what have the counselors contributed?" filter.
   *
   * Local state rather than part of `useListFilters`, which owns the three filters every list
   * screen in this app shares. This one belongs to this screen only, and it is meaningless for a
   * counselor: their list is already narrowed to themselves by the server, so offering it would be
   * a control that can only ever empty the page.
   */
  const [authorRole, setAuthorRole] = useState<'admin' | 'counselor' | ''>('');

  /**
   * `?answer=<question>` still opens the Q&A form pre-filled, for a link somebody saved back when
   * the AI-gaps report navigated here. The report answers in place now, so nothing produces these
   * any more — but a bookmark that silently lost its question would be worse than ten lines.
   */
  const [params, setParams] = useSearchParams();
  const prefilled = params.get('answer');
  const [openedFromLink, setOpenedFromLink] = useState(prefilled !== null);

  const query = useMemo<KnowledgeListQuery>(
    () => ({
      search: filters.search,
      status: filters.status === '' ? undefined : filters.status,
      author_role: !isAdmin || authorRole === '' ? undefined : authorRole,
      archived: tab,
      page: filters.page,
    }),
    [filters.search, filters.status, filters.page, authorRole, isAdmin, tab],
  );

  const { data, isLoading, isFetching, isError, error } = useKnowledgeDocuments(query);

  const isFiltered = filters.search !== undefined || filters.status !== '' || authorRole !== '';

  function switchTab(next: LibraryTab) {
    setTab(next);
    // Page 4 of the live half is rarely page 4 of the archived one, and a tab that opens on an
    // empty page reads as "there is nothing here".
    filters.setPage(1);
  }

  function closeAnswerLink() {
    setOpenedFromLink(false);

    if (prefilled !== null) {
      params.delete('answer');
      setParams(params, { replace: true });
    }
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="max-w-2xl">
          <h1 className="text-xl font-semibold text-foreground">Knowledge</h1>
          <p className="text-sm text-muted-foreground">
            What the AI is allowed to know. Answers only ever come from content added here — if
            nothing covers a question, the AI says so rather than inventing an answer.
          </p>
        </div>

        {/*
          The three ways in, as buttons rather than three permanently-open forms. Adding knowledge
          is the rare act; reading the library is the common one, and the page should lead with the
          common one.
        */}
        <div className="flex flex-wrap gap-2">
          <Button size="sm" onClick={() => setDialog('qa')}>
            <MessageSquarePlus className="size-4" aria-hidden="true" />
            Answer a question
          </Button>
          <Button size="sm" variant="secondary" onClick={() => setDialog('text')}>
            <FilePlus2 className="size-4" aria-hidden="true" />
            Paste a note
          </Button>
          <Button size="sm" variant="secondary" onClick={() => setDialog('upload')}>
            <FileUp className="size-4" aria-hidden="true" />
            Upload a file
          </Button>
          {isAdmin ? (
            <Button size="sm" variant="secondary" onClick={() => setDialog('sync')}>
              <RefreshCw className="size-4" aria-hidden="true" />
              Sync catalog
            </Button>
          ) : null}
        </div>
      </div>

      {/*
        The one thing a counselor must understand before writing anything here (migration 0031):
        what they add is not a private note. It reaches every student in the school, exactly like an
        admin's entry — that is the point of contributing — while the *list* below shows only their
        own work. Two different scopes that are very easy to conflate, and conflating them the wrong
        way means somebody writes something for one class that the whole school reads.
      */}
      {isAdmin ? null : (
        // `info`, not the default `danger`: a statement of fact about how the feature works, not a
        // failure. A red box would read as "you have done something wrong".
        <Alert tone="info">
          Anything you add goes into the school&apos;s shared knowledge base and can be used to
          answer <strong>any</strong> student, not only your own classes. The list below shows the
          entries you added; an administrator sees all of them.
        </Alert>
      )}

      <div
        role="tablist"
        aria-label="Knowledge library"
        className="flex flex-wrap gap-2 border-b border-border"
      >
        {([
          { id: 'live' as const, label: 'Knowledge' },
          { id: 'archived' as const, label: 'Archived' },
        ]).map((entry) => (
          <button
            key={entry.id}
            role="tab"
            type="button"
            aria-selected={tab === entry.id}
            className={
              tab === entry.id
                ? 'border-b-2 border-foreground px-3 py-2 text-sm font-medium text-foreground'
                : 'border-b-2 border-transparent px-3 py-2 text-sm text-muted-foreground hover:text-foreground'
            }
            onClick={() => switchTab(entry.id)}
          >
            {entry.label}
          </button>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <SearchInput
          value={filters.searchInput}
          onChange={filters.setSearchInput}
          label="Search documents"
          placeholder="Search by file name…"
        />

        {/*
          The filter that earns its place: a document stuck in Processing, or one that came back
          Failed, contributes nothing to retrieval and looks exactly like a healthy one in a list
          ordered by upload date. Finding them used to mean reading every page.

          Hidden on the archived tab, where it can only narrow rows that are all equally out of
          service — a Failed archived entry is not a problem anybody is going to fix.
        */}
        {tab === 'live' ? (
          <Select
            value={filters.status}
            onChange={(event) => filters.setStatus(event.target.value as ProcessingStatus | '')}
            aria-label="Filter by processing status"
            className="w-auto"
          >
            <option value="">All statuses</option>
            {(Object.keys(STATUS_LABEL) as ProcessingStatus[]).map((status) => (
              <option key={status} value={status}>
                {STATUS_LABEL[status]}
              </option>
            ))}
          </Select>
        ) : null}

        {/*
          Admin-only, because it is the only list where it can match more than one thing. Once
          counselors contribute, "who wrote this" is the first question about a wrong answer, and
          reading every page to find the counselor-authored ones is how it went before.
        */}
        {isAdmin ? (
          <Select
            value={authorRole}
            onChange={(event) => {
              setAuthorRole(event.target.value as 'admin' | 'counselor' | '');
              filters.setPage(1);
            }}
            aria-label="Filter by who added the entry"
            className="w-auto"
          >
            <option value="">Anyone</option>
            <option value="admin">Added by an administrator</option>
            <option value="counselor">Added by a counselor</option>
          </Select>
        ) : null}

        {data ? (
          // The running total, stated here rather than left to the pager — `Pagination` renders
          // nothing at all while there is only one page, so a small library would otherwise never
          // say how big it is.
          <span className="text-sm text-muted-foreground">
            {data.pagination.total} {data.pagination.total === 1 ? 'entry' : 'entries'}
          </span>
        ) : null}
      </div>

      {isLoading ? <p className="text-sm text-muted-foreground">Loading…</p> : null}
      {isError ? <Alert>We could not load the list. {error.message}</Alert> : null}

      {data && data.items.length === 0 ? <EmptyState tab={tab} filtered={isFiltered} /> : null}

      {data && data.items.length > 0 ? (
        // One card holding dense rows, rather than one card per entry. Twenty entries used to be
        // twenty headers and twenty borders; they are now a list you can read down.
        <Card className={cn(isFetching && 'opacity-60 transition-opacity')}>
          <CardContent className="flex flex-col p-0">
            {data.items.map((document) => (
              <DocumentRow key={document.id} document={document} />
            ))}
          </CardContent>
        </Card>
      ) : null}

      {data ? (
        <Pagination
          pagination={data.pagination}
          onPageChange={filters.setPage}
          noun={tab === 'archived' ? 'archived entries' : 'entries'}
          isFetching={isFetching}
        />
      ) : null}

      {/* --- the modals ------------------------------------------------------------------ */}

      <WriteEntryDialog
        mode="qa"
        open={dialog === 'qa' || openedFromLink}
        {...(openedFromLink && prefilled !== null
          ? { initialQuestion: prefilled, resolvesQuestion: prefilled }
          : {})}
        onClose={() => {
          setDialog(null);
          closeAnswerLink();
        }}
      />
      <WriteEntryDialog mode="text" open={dialog === 'text'} onClose={() => setDialog(null)} />
      <UploadDialog open={dialog === 'upload'} onClose={() => setDialog(null)} />
      {isAdmin ? (
        <CatalogSyncDialog open={dialog === 'sync'} onClose={() => setDialog(null)} />
      ) : null}
    </div>
  );
}

function EmptyState({ tab, filtered }: { tab: LibraryTab; filtered: boolean }) {
  if (tab === 'archived') {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Nothing archived</CardTitle>
          <CardDescription>
            Entries you archive appear here. They stay out of the AI&apos;s reach but keep their
            history — and this is where they can be removed for good.
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        {filtered ? (
          <>
            <CardTitle>No matching entries</CardTitle>
            <CardDescription>Nothing matches the current search and filters.</CardDescription>
          </>
        ) : (
          <>
            <CardTitle>Nothing here yet</CardTitle>
            <CardDescription>
              This is why students see the deterministic reason with no explanation: with an empty
              knowledge base the AI has nothing to ground an answer on, so it refuses rather than
              inventing. The fastest start is <strong>Sync catalog</strong> — it writes an entry for
              every career and program from records you already have. Then answer the questions
              students actually ask, one at a time.
            </CardDescription>
          </>
        )}
      </CardHeader>
    </Card>
  );
}

/**
 * **Write knowledge, rather than upload it** (AiNormalisation Phase 1), now in a modal.
 *
 * The bottleneck this replaces: knowledge could only enter as a PDF or DOCX somebody already had.
 * On 2026-09-04 the production knowledge base held zero documents and never had held one — so every
 * AI answer had nothing to stand on, and the pipeline refused, correctly, on every question.
 *
 * The Q&A shape is the one that matters most. A question paired with its authoritative answer
 * embeds close to how a student actually phrases it, and it is the answer the system can eventually
 * hand back word for word — no model, no drift, nothing invented.
 */
function WriteEntryDialog({
  mode,
  open,
  initialQuestion,
  resolvesQuestion,
  onClose,
}: {
  mode: 'qa' | 'text';
  open: boolean;
  initialQuestion?: string;
  /**
   * The backlog question this entry answers, **as the report worded it** — never the text finally
   * typed. See the AI-gaps answer form for why that distinction is load-bearing.
   */
  resolvesQuestion?: string;
  onClose: () => void;
}) {
  const create = useCreateKnowledgeEntry();

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogContent
        title={mode === 'qa' ? 'Answer a question' : 'Paste a note'}
        description={
          mode === 'qa'
            ? 'A question and its answer. This is what the AI can hand back word for word.'
            : 'A paragraph, policy or note. Searchable by the AI within about a minute.'
        }
      >
        <EntryForm
          // Remounted per opening, so a form abandoned half-typed does not reappear that way.
          key={`${mode}-${open}-${initialQuestion ?? ''}`}
          mode={mode}
          {...(initialQuestion === undefined
            ? {}
            : { initial: { title: initialQuestion, body: '' } })}
          submitLabel="Save to knowledge base"
          pending={create.isPending}
          onCancel={onClose}
          onSubmit={async (payload) => {
            await create.mutateAsync(
              resolvesQuestion === undefined
                ? payload
                : { ...payload, resolves_question: resolvesQuestion },
            );
            toast.success('Saved. It is being read now — it appears as Queued, then Ready.');
            onClose();
          }}
        />
        {create.isError ? <Alert className="mt-3">{create.error.message}</Alert> : null}
      </DialogContent>
    </Dialog>
  );
}

function UploadDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const upload = useUploadKnowledgeDocument();
  const inputRef = useRef<HTMLInputElement>(null);
  const [extracting, setExtracting] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  async function handleFile(file: File) {
    setProblem(null);
    setExtracting(true);

    try {
      // §33 v1.5: extraction happens here, before anything leaves the machine.
      const extractedText = await extractText(file);

      await upload.mutateAsync({ file, extractedText });
      toast.success('Uploaded. The text is being read now.');
      onClose();
    } catch (cause) {
      setProblem(
        cause instanceof ExtractionError || cause instanceof Error
          ? cause.message
          : 'The upload failed.',
      );
    } finally {
      setExtracting(false);

      if (inputRef.current) {
        inputRef.current.value = '';
      }
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogContent
        title="Upload a file"
        description="PDF, DOCX, TXT or MD, up to 10 MB. The text is read out here in your browser; the original file is kept unchanged for the record."
      >
        <div className="flex flex-col gap-3">
          <input
            ref={inputRef}
            type="file"
            accept=".pdf,.docx,.txt,.md"
            className="text-sm text-muted-foreground file:mr-3 file:rounded-none file:border-0 file:bg-secondary file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-foreground/80 hover:file:bg-secondary"
            disabled={extracting || upload.isPending}
            onChange={(event) => {
              const file = event.target.files?.[0];

              if (file) {
                void handleFile(file);
              }
            }}
          />

          {extracting ? (
            <p className="text-sm text-muted-foreground">Extracting text from the document…</p>
          ) : null}
          {upload.isPending ? <p className="text-sm text-muted-foreground">Uploading…</p> : null}
          {problem ? <Alert>{problem}</Alert> : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Generate one entry per career and per program from the catalog this system already holds.
 *
 * It runs nightly too, but "nightly" is the wrong answer to *"I just fixed that description and the
 * AI is still saying the old thing."* Cheap to press repeatedly: an entry whose text has not changed
 * is not rewritten and not re-embedded.
 */
function CatalogSyncDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const sync = useSyncCatalogKnowledge();

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogContent
        title="Sync catalog knowledge"
        description="Writes an entry for every career and program from records you already have."
      >
        <div className="flex flex-col gap-4">
          <p className="text-sm text-muted-foreground">
            Their descriptions, salary ranges, strands and locations. This is what gives{' '}
            <strong>Explain more</strong> something to say about the exact program a student matched
            with. It runs automatically each night; press this to do it now.
          </p>

          <Button className="self-start" disabled={sync.isPending} onClick={() => sync.mutate()}>
            {sync.isPending ? 'Syncing…' : 'Sync now'}
          </Button>

          {sync.isError ? <Alert>{sync.error.message}</Alert> : null}
          {sync.data ? (
            <p className="text-sm text-muted-foreground">
              {sync.data.skipped
                ? sync.data.skipped
                : sync.data.changed === 0 && sync.data.retired === 0
                  ? `All ${sync.data.total} careers and programs are already up to date.`
                  : `${sync.data.changed} of ${sync.data.total} entries updated and queued for re-reading${
                      sync.data.retired === 0 ? '' : `, ${sync.data.retired} archived`
                    }.${
                      sync.data.remaining === 0
                        ? ''
                        : // The batch cap is 20 entries per run, because a rewrite costs two
                          // subrequests against a free Worker's 50. The route queues its own
                          // continuation, so the rest finishes by itself — this used to say "press
                          // Sync now again to continue", which stopped being true and would have an
                          // admin either pressing a working button or reading a finishing sync as a
                          // stalled one.
                          ` ${sync.data.remaining} still to do — those finish in the background over the next few minutes.`
                    }`}
            </p>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Editing an entry: load the text the AI actually reads, change it, save — and the entry is
 * re-chunked and re-embedded straight away, so the corrected wording replaces the old one in the
 * index rather than joining it there.
 *
 * In a modal like the write forms, and for the same reason: an edit form that expanded inside a
 * dense list would push every row below it down the page, which is the layout this screen was
 * rebuilt to get away from.
 */
function EditEntryDialog({
  document,
  open,
  onClose,
}: {
  document: KnowledgeDocument;
  open: boolean;
  onClose: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogContent title="Edit entry" description={document.title}>
        {open ? <EditEntryBody document={document} onClose={onClose} /> : null}
      </DialogContent>
    </Dialog>
  );
}

/** Split out so the content query only runs once the modal is actually open. */
function EditEntryBody({
  document,
  onClose,
}: {
  document: KnowledgeDocument;
  onClose: () => void;
}) {
  const content = useKnowledgeEntryContent(document.id);
  const update = useUpdateKnowledgeEntry(document.id);

  if (content.isLoading) {
    return <p className="text-sm text-muted-foreground">Loading the text…</p>;
  }

  if (content.isError || content.data === undefined) {
    return <Alert>The text for this entry could not be loaded. {content.error?.message}</Alert>;
  }

  return (
    <div className="flex flex-col gap-3">
      {document.entity_type === 'guide' ? (
        <p className="text-sm text-muted-foreground">
          This entry is part of CareerLinkAI&apos;s built-in guidance for students. Your edit stays
          until that guidance is updated in a new release. Archive it to stop the assistant using it.
        </p>
      ) : document.source_type === 'catalog' ? (
        <p className="text-sm text-muted-foreground">
          This entry is generated from its career or program. Your edit stays until that record
          changes — the next sync after a change regenerates this text. To make a change permanent,
          edit the career or program itself.
        </p>
      ) : null}

      {document.source_type === 'pdf' || document.source_type === 'docx' ? (
        <p className="text-sm text-muted-foreground">
          This is the text read out of {document.file_name} — edit it to fix anything the extraction
          got wrong. The original file is kept unchanged.
        </p>
      ) : null}

      <EntryForm
        mode={document.source_type === 'qa' ? 'qa' : 'text'}
        initial={{ title: content.data.title, body: content.data.body }}
        submitLabel="Save and re-read"
        pending={update.isPending}
        onCancel={onClose}
        onSubmit={async (payload) => {
          await update.mutateAsync(payload);
          onClose();
        }}
      />
      {update.isError ? <Alert>{update.error.message}</Alert> : null}
    </div>
  );
}

/**
 * The form behind both writing and editing an entry, in both shapes.
 *
 * A Q&A pair posts both halves every time, even on an edit where only one changed: the two are
 * stored as one passage, and sending half of it would leave a new question paired with the old
 * answer.
 */
export function EntryForm({
  mode,
  initial,
  submitLabel,
  pending,
  onSubmit,
  onCancel,
}: {
  mode: 'qa' | 'text';
  initial?: { title: string; body: string };
  submitLabel: string;
  pending: boolean;
  onSubmit: (payload: KnowledgeEntryPayload) => Promise<void>;
  onCancel?: () => void;
}) {
  // A stored Q&A entry is one `Q: …\nA: …` passage; the form edits the two halves, so it splits on
  // the marker the server wrote. A body that does not carry the marker (an entry saved before this
  // shape existed, or one hand-edited) degrades to "all of it is the answer" rather than silently
  // dropping text.
  const parsed = useMemo(() => {
    const body = initial?.body ?? '';
    const match = /^Q:\s*([\s\S]*?)\nA:\s*([\s\S]*)$/.exec(body);

    return {
      question: match ? match[1]!.trim() : (initial?.title ?? ''),
      // With no `Q:`/`A:` marker and no body — the pre-filled case from the gaps report — the
      // question is known and the answer is what the admin is here to write.
      answer: match ? match[2]!.trim() : body,
    };
  }, [initial]);

  const [question, setQuestion] = useState(parsed.question);
  const [answer, setAnswer] = useState(parsed.answer);
  const [title, setTitle] = useState(initial?.title ?? '');
  const [body, setBody] = useState(initial?.body ?? '');

  const empty =
    mode === 'qa'
      ? question.trim().length < 5 || answer.trim().length === 0
      : title.trim().length < 3 || body.trim().length === 0;

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();

    if (empty || pending) {
      return;
    }

    await onSubmit(
      mode === 'qa'
        ? { type: 'qa', question: question.trim(), answer: answer.trim() }
        : { type: 'text', title: title.trim(), body: body.trim() },
    );

    if (onCancel === undefined) {
      // A create form clears itself; one with a Cancel is closed by its parent instead.
      setQuestion('');
      setAnswer('');
      setTitle('');
      setBody('');
    }
  }

  return (
    <form className="flex flex-col gap-3" onSubmit={(event) => void handleSubmit(event)}>
      {mode === 'qa' ? (
        <>
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium">Question, as a student would ask it</span>
            <input
              className="border border-border bg-background px-3 py-2 text-sm"
              value={question}
              maxLength={300}
              placeholder="How much is tuition for Nursing?"
              onChange={(event) => setQuestion(event.target.value)}
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium">The answer</span>
            <textarea
              className="min-h-24 border border-border bg-background px-3 py-2 text-sm"
              value={answer}
              maxLength={1200}
              placeholder="Tuition for BS Nursing is approximately PHP 25,000 per semester as of AY 2026-2027."
              onChange={(event) => setAnswer(event.target.value)}
            />
            <span className="text-xs text-muted-foreground">
              Write it as you want a student to read it — this text is what the AI answers with.{' '}
              {1200 - answer.length} characters left.
            </span>
          </label>
        </>
      ) : (
        <>
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium">Title</span>
            <input
              className="border border-border bg-background px-3 py-2 text-sm"
              value={title}
              maxLength={200}
              placeholder="Admissions requirements, AY 2026-2027"
              onChange={(event) => setTitle(event.target.value)}
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium">Text</span>
            <textarea
              className="min-h-40 border border-border bg-background px-3 py-2 text-sm"
              value={body}
              placeholder="Paste the paragraph, policy or note here."
              onChange={(event) => setBody(event.target.value)}
            />
          </label>
        </>
      )}

      <div className="flex gap-2">
        <Button type="submit" disabled={empty || pending}>
          {pending ? 'Saving…' : submitLabel}
        </Button>
        {onCancel ? (
          <Button type="button" variant="secondary" onClick={onCancel} disabled={pending}>
            Cancel
          </Button>
        ) : null}
      </div>
    </form>
  );
}

/** What each source is called on screen — the wire values are not words an admin should read. */
const SOURCE_LABEL: Record<KnowledgeSourceType, string> = {
  pdf: 'PDF',
  docx: 'DOCX',
  text: 'Note',
  qa: 'Q&A',
  catalog: 'Catalog',
};

const STATUS_LABEL: Record<ProcessingStatus, string> = {
  UPLOADED: 'Queued',
  PROCESSING: 'Processing',
  COMPLETED: 'Ready',
  FAILED: 'Failed',
};

/**
 * One entry, as one row.
 *
 * It used to be a whole Card with its own header, description and button bar, so a page of twenty
 * was twenty stacked cards. Everything that opened inline — editing most of all — now opens in a
 * modal, which is what lets the row stay a row.
 */
function DocumentRow({ document }: { document: KnowledgeDocument }) {
  const archive = useArchiveKnowledgeDocument();
  const remove = useRemoveKnowledgeDocument();
  const reprocess = useReprocessKnowledgeDocument();
  const unarchive = useUnarchiveKnowledgeDocument();
  const [editing, setEditing] = useState(false);
  const [confirmingRemoval, setConfirmingRemoval] = useState(false);
  const archived = document.archived_at !== null;

  /**
   * **Remove destroys the entry**, and on a live one it archives first.
   *
   * The server refuses to remove anything that is not already archived, so that "removal is always
   * a second, deliberate decision". This composes the two steps behind one confirmation rather than
   * making somebody archive, find the other tab, and press again — the server rule still holds (a
   * stray DELETE cannot destroy a live entry), and the deliberateness lives where a person can
   * actually see it: a button that says what it will do, pressed twice.
   */
  async function onRemove() {
    try {
      if (!archived) {
        await archive.mutateAsync(document.id);
      }

      await remove.mutateAsync(document.id);
      toast.success('Entry removed. Its text, passages and stored file are gone for good.');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'The entry could not be removed.');
    } finally {
      setConfirmingRemoval(false);
    }
  }

  const busy = archive.isPending || remove.isPending || unarchive.isPending;

  return (
    <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2 border-b border-border px-5 py-3 last:border-0">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="truncate text-sm font-medium text-foreground">{document.title}</span>
          <Badge>{SOURCE_LABEL[document.source_type]}</Badge>
          {archived ? (
            <Badge>Archived</Badge>
          ) : (
            <Badge tone={document.processing_status === 'COMPLETED' ? 'success' : undefined}>
              {STATUS_LABEL[document.processing_status]}
            </Badge>
          )}
        </div>

        <p className="mt-0.5 text-xs text-muted-foreground">
          Added {new Date(document.created_at).toLocaleDateString()}
          {/*
            Who wrote it (migration 0031). Now that counselors contribute to the same corpus, this
            is the first question about a wrong answer — a school-published entry and one
            counselor's note need different conversations, even when they read identically.

            A catalog entry says so instead of naming the admin the sync happened to attribute it
            to: nobody wrote it, and printing a person's name against generated text invites
            somebody to go and ask them about wording they never chose.
          */}
          {document.entity_type === 'guide'
            ? ' · built-in guidance'
            : document.source_type === 'catalog'
            ? ' · from the catalog'
            : document.added_by_name
              ? ` · ${document.added_by_name}${
                  document.added_by_role === 'counselor' ? ' (counselor)' : ''
                }`
              : null}
          {document.chunk_count ? ` · ${document.chunk_count} passages` : null}
          {archived ? ' · not retrievable by the AI' : null}
        </p>
      </div>

      <div className="flex shrink-0 flex-wrap items-center gap-2">
        {/*
          The §42 re-run path: Free-plan queues keep a message for 24 hours, so a job that never
          ran is simply gone — "wait for the retry" is not something an admin can do.
        */}
        {!archived && document.processing_status === 'FAILED' ? (
          <Button
            size="sm"
            variant="secondary"
            disabled={reprocess.isPending}
            onClick={() => reprocess.mutate(document.id)}
          >
            Reprocess
          </Button>
        ) : null}

        {!archived ? (
          <>
            <Button size="sm" variant="secondary" onClick={() => setEditing(true)}>
              Edit
            </Button>
            <Button
              size="sm"
              variant="secondary"
              disabled={busy}
              onClick={() => archive.mutate(document.id)}
            >
              Archive
            </Button>
          </>
        ) : (
          <Button
            size="sm"
            variant="secondary"
            disabled={busy}
            loading={unarchive.isPending}
            onClick={() =>
              unarchive.mutate(document.id, {
                onSuccess: () =>
                  toast.success('Entry restored. The AI can use it again once processing finishes.'),
                onError: (error) => toast.error(error.message),
              })
            }
          >
            Unarchive
          </Button>
        )}

        {/*
          Two presses rather than a confirm dialog — this list already opens modals for the things
          worth a modal, and a third one for a destructive click would be a dialog on top of a
          dialog-shaped page. `onBlur` disarms it, so a stray first press does not leave a live
          "Remove for good" button behind on a row nobody is looking at any more.
        */}
        {confirmingRemoval ? (
          <>
            <Button size="sm" variant="danger" loading={busy} onClick={() => void onRemove()}>
              Remove for good
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setConfirmingRemoval(false)}>
              Cancel
            </Button>
          </>
        ) : (
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            title="Destroys the text, its passages and the stored file"
            onClick={() => setConfirmingRemoval(true)}
            onBlur={() => setConfirmingRemoval(false)}
          >
            Remove
          </Button>
        )}
      </div>

      {archive.isError && !remove.isError ? (
        <p className="w-full text-sm text-destructive">{archive.error.message}</p>
      ) : null}

      <EditEntryDialog document={document} open={editing} onClose={() => setEditing(false)} />
    </div>
  );
}
