import { useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';

import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { cn } from '@/components/ui/cn';
import { Pagination } from '@/components/ui/pagination';
import { SearchInput } from '@/components/ui/search-input';
import { Select } from '@/components/ui/select';
import {
  useArchiveKnowledgeDocument,
  useCreateKnowledgeEntry,
  useKnowledgeDocuments,
  useKnowledgeEntryContent,
  useReprocessKnowledgeDocument,
  useSyncCatalogKnowledge,
  useUpdateKnowledgeEntry,
  useUploadKnowledgeDocument,
} from '@/features/admin/hooks/useAiKnowledge';
import { extractText, ExtractionError } from '@/features/admin/utils/extractText';
import { useListFilters } from '@/hooks/useListFilters';
import type { KnowledgeListQuery } from '@/services/aiApi';
import type {
  KnowledgeDocument,
  KnowledgeEntryPayload,
  KnowledgeSourceType,
  ProcessingStatus,
} from '@/types/ai';

/**
 * Knowledge documents (FULLPLAN §33, §37 — Phase 5a).
 *
 * The pipeline this page fronts: pick a PDF/DOCX → the text is extracted **in this
 * browser** (§33 v1.5 — the Free-plan Worker has nowhere to run a parser) → the raw file
 * and the text upload together → a queue job chunks and embeds the text → the document
 * becomes retrievable by the §30 explanation pipeline. `COMPLETED` means the vectors were
 * accepted; Vectorize indexes asynchronously, so brand-new content can take a little
 * longer to actually surface in explanations.
 */
export function KnowledgeListPage() {
  const filters = useListFilters<ProcessingStatus>();

  const query = useMemo<KnowledgeListQuery>(
    () => ({
      search: filters.search,
      status: filters.status === '' ? undefined : filters.status,
      page: filters.page,
    }),
    [filters.search, filters.status, filters.page],
  );

  const { data, isLoading, isFetching, isError, error } = useKnowledgeDocuments(query);

  const isFiltered = filters.search !== undefined || filters.status !== '';

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold text-foreground">Knowledge documents</h1>
        <p className="text-sm text-muted-foreground">
          What the AI is allowed to know. Answers only ever come from content added here —
          archiving an entry removes it from the AI&apos;s reach immediately. If nothing here
          covers a question, the AI says so rather than inventing an answer.
        </p>
      </div>

      <WriteCard />
      <CatalogSyncCard />
      <UploadCard />

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
        */}
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
      </div>

      {isLoading ? <p className="text-sm text-muted-foreground">Loading documents…</p> : null}

      {isError ? (
        <Alert>We could not load the document list. {error.message}</Alert>
      ) : null}

      {data && data.items.length === 0 ? (
        <Card>
          <CardHeader>
            {isFiltered ? (
              <>
                <CardTitle>No matching documents</CardTitle>
                <CardDescription>
                  Nothing matches{' '}
                  {filters.search ? <strong>“{filters.search}”</strong> : 'this filter'}
                  {filters.status ? ` with status ${STATUS_LABEL[filters.status]}` : ''}.
                </CardDescription>
              </>
            ) : (
              <>
                <CardTitle>Nothing here yet</CardTitle>
                <CardDescription>
                  This is why students see the deterministic reason with no explanation: with an
                  empty knowledge base the AI has nothing to ground an answer on, so it refuses
                  rather than inventing. The fastest start is{' '}
                  <strong>Sync catalog knowledge</strong> above — it writes an entry for every
                  career and program from records you already have. Then answer the questions
                  students actually ask, one Q&amp;A at a time.
                </CardDescription>
              </>
            )}
          </CardHeader>
        </Card>
      ) : null}

      <div className={cn('flex flex-col gap-6', isFetching && 'opacity-60 transition-opacity')}>
        {data?.items.map((document) => (
          <DocumentRow key={document.id} document={document} />
        ))}
      </div>

      {data ? (
        <Pagination
          pagination={data.pagination}
          onPageChange={filters.setPage}
          noun="documents"
          isFetching={isFetching}
        />
      ) : null}
    </div>
  );
}

function UploadCard() {
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
    <Card>
      <CardHeader>
        <CardTitle>Upload a document</CardTitle>
        <CardDescription>
          PDF, DOCX, TXT or MD, up to 10&nbsp;MB. The text is read out here in your browser; the
          original file is kept unchanged for the record.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
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
      </CardContent>
    </Card>
  );
}

/**
 * **Write knowledge, rather than upload it** (AiNormalisation Phase 1).
 *
 * The bottleneck this replaces: knowledge could only enter as a PDF or DOCX somebody already had.
 * On 2026-09-04 the production knowledge base held zero documents and never had held one — so
 * every AI answer had nothing to stand on, and the pipeline refused, correctly, on every question.
 *
 * The Q&A tab is the one that matters most. A question paired with its authoritative answer
 * embeds close to how a student actually phrases it, and it is the answer the system can
 * eventually hand back word for word — no model, no drift, nothing invented.
 */
function WriteCard() {
  /**
   * `?answer=<question>` arrives from the **Answer this** button on the AI-gaps report, carrying a
   * question a student actually asked and nothing covered. Pre-filling it is the difference
   * between a report someone reads and a report someone acts on: the admin types the answer and
   * nothing else.
   */
  const [params, setParams] = useSearchParams();
  const prefilled = params.get('answer');
  const [tab, setTab] = useState<'qa' | 'text'>('qa');
  const create = useCreateKnowledgeEntry();
  const [saved, setSaved] = useState(false);

  async function submit(payload: KnowledgeEntryPayload) {
    setSaved(false);
    await create.mutateAsync(payload);
    setSaved(true);
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Answer a question, or paste a note</CardTitle>
        <CardDescription>
          No file needed. Anything you write here becomes searchable by the AI within about a
          minute, and it is the only thing students&apos; answers can be based on.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex gap-2">
          <Button
            variant={tab === 'qa' ? 'primary' : 'secondary'}
            onClick={() => setTab('qa')}
            aria-pressed={tab === 'qa'}
          >
            Question &amp; answer
          </Button>
          <Button
            variant={tab === 'text' ? 'primary' : 'secondary'}
            onClick={() => setTab('text')}
            aria-pressed={tab === 'text'}
          >
            Pasted note
          </Button>
        </div>

        <EntryForm
          // Remounted when the incoming question changes, so the form picks it up as its initial
          // value — the fields are uncontrolled state, and a prop change alone would not reach them.
          key={prefilled ?? 'blank'}
          mode={tab}
          {...(prefilled === null ? {} : { initial: { title: prefilled, body: '' } })}
          submitLabel="Save to knowledge base"
          pending={create.isPending}
          onSubmit={async (payload) => {
            await submit(payload);

            // The question has been answered; leaving it in the URL would re-fill the form the
            // next time this page is opened from anywhere.
            if (prefilled !== null) {
              params.delete('answer');
              setParams(params, { replace: true });
            }
          }}
        />

        {create.isError ? <Alert>{create.error.message}</Alert> : null}
        {saved && !create.isPending ? (
          <p className="text-sm text-muted-foreground">
            Saved. It is being read now — the entry appears below as Queued, then Ready.
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}

/**
 * The form behind both writing and editing an entry, in both shapes.
 *
 * A Q&A pair posts both halves every time, even on an edit where only one changed: the two are
 * stored as one passage, and sending half of it would leave a new question paired with the old
 * answer.
 */
function EntryForm({
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
  // A stored Q&A entry is one `Q: …\nA: …` passage; the form edits the two halves, so it splits
  // on the marker the server wrote. A body that does not carry the marker (an entry saved before
  // this shape existed, or one hand-edited) degrades to "all of it is the answer" rather than
  // silently dropping text.
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
      // A create form clears itself; an edit form is closed by its parent instead.
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
              Write it as you want a student to read it — this text is what the AI answers with.
              {' '}
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

/**
 * Generate one entry per career and per program from the catalog this system already holds.
 *
 * It runs nightly too, but "nightly" is the wrong answer to *"I just fixed that description and
 * the AI is still saying the old thing."* Cheap to press repeatedly: an entry whose text has not
 * changed is not rewritten and not re-embedded.
 */
function CatalogSyncCard() {
  const sync = useSyncCatalogKnowledge();

  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-4">
        <div>
          <CardTitle>Sync catalog knowledge</CardTitle>
          <CardDescription>
            Writes an entry for every career and program from records you already have — their
            descriptions, salary ranges, strands and locations. This is what gives{' '}
            <strong>Explain more</strong> something to say about the exact program a student
            matched with. Runs automatically each night; press this to do it now.
          </CardDescription>
        </div>
        <Button
          variant="secondary"
          disabled={sync.isPending}
          onClick={() => sync.mutate()}
        >
          {sync.isPending ? 'Syncing…' : 'Sync now'}
        </Button>
      </CardHeader>
      {sync.isError || sync.data ? (
        <CardContent>
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
                          // subrequests against a free Worker's 50. The route now queues its own
                          // continuation, so the rest finishes by itself — this used to say
                          // "press Sync now again to continue", which stopped being true and would
                          // have an admin either pressing a working button or reading a finishing
                          // sync as a stalled one.
                          ` ${sync.data.remaining} still to do — those finish in the background over the next few minutes.`
                    }`}
            </p>
          ) : null}
        </CardContent>
      ) : null}
    </Card>
  );
}

/**
 * Editing an entry: load the text the AI actually reads, change it, save — and the entry is
 * re-chunked and re-embedded straight away, so the corrected wording replaces the old one in the
 * index rather than joining it there.
 *
 * Every source type is editable, and the two that behave differently say so rather than
 * surprising anyone later.
 */
function EditEntry({ document, onClose }: { document: KnowledgeDocument; onClose: () => void }) {
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
      {document.source_type === 'catalog' ? (
        <p className="text-sm text-muted-foreground">
          This entry is generated from its career or program. Your edit stays until that record
          changes — the next sync after a change regenerates this text. To make a change permanent,
          edit the career or program itself.
        </p>
      ) : null}

      {document.source_type === 'pdf' || document.source_type === 'docx' ? (
        <p className="text-sm text-muted-foreground">
          This is the text read out of {document.file_name} — edit it to fix anything the
          extraction got wrong. The original file is kept unchanged.
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

function DocumentRow({ document }: { document: KnowledgeDocument }) {
  const archive = useArchiveKnowledgeDocument();
  const reprocess = useReprocessKnowledgeDocument();
  const [editing, setEditing] = useState(false);
  const archived = document.archived_at !== null;
  /**
   * Every live entry is editable, whatever it came from. What is edited is the text the AI reads
   * — an uploaded file keeps its original in storage untouched, so correcting a mangled PDF
   * extraction changes the transcription, not the record.
   */
  const editable = !archived;

  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-4">
        <div>
          <CardTitle className="flex items-center gap-2">
            {/*
              The whole title is the affordance, not a small button beside it: an admin who spots
              a wrong answer in this list reaches for the wrong answer, so that is what has to be
              clickable. A real <button> rather than an onClick div — it has to be reachable by
              keyboard and announce that it expands something.
            */}
            {editable ? (
              <button
                type="button"
                className="text-left underline-offset-4 hover:underline focus-visible:underline focus-visible:outline-none"
                aria-expanded={editing}
                onClick={() => setEditing((open) => !open)}
              >
                {document.title}
              </button>
            ) : (
              document.title
            )}
            <Badge>{SOURCE_LABEL[document.source_type]}</Badge>
            {archived ? (
              <Badge>Archived</Badge>
            ) : (
              <Badge tone={document.processing_status === 'COMPLETED' ? 'success' : undefined}>
                {STATUS_LABEL[document.processing_status]}
              </Badge>
            )}
          </CardTitle>
          <CardDescription>
            {editable && !editing ? 'Click the title to edit · ' : null}
            Added {new Date(document.created_at).toLocaleString()}
            {document.chunk_count ? ` · ${document.chunk_count} chunks` : null}
          </CardDescription>
        </div>

        <div className="flex gap-2">
          {/*
            The §42 re-run path: Free-plan queues keep a message for 24 hours, so a job that
            never ran is simply gone — "wait for the retry" is not something an admin can do.
          */}
          {!archived && document.processing_status === 'FAILED' ? (
            <Button
              variant="secondary"
              disabled={reprocess.isPending}
              onClick={() => reprocess.mutate(document.id)}
            >
              Reprocess
            </Button>
          ) : null}

          {editable ? (
            <Button
              variant="secondary"
              aria-expanded={editing}
              onClick={() => setEditing((open) => !open)}
            >
              {editing ? 'Close' : 'Edit'}
            </Button>
          ) : null}

          {!archived ? (
            <Button
              variant="secondary"
              disabled={archive.isPending}
              onClick={() => archive.mutate(document.id)}
            >
              Archive
            </Button>
          ) : null}
        </div>
      </CardHeader>

      {editing && editable ? (
        <CardContent>
          <EditEntry document={document} onClose={() => setEditing(false)} />
        </CardContent>
      ) : null}

      {archived ? (
        <CardContent>
          <p className="text-sm text-muted-foreground">
            No longer retrievable by the AI. The entry and its history are kept — nothing is ever
            deleted.
          </p>
        </CardContent>
      ) : null}
    </Card>
  );
}
