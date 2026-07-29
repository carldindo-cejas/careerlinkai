import { useMemo, useRef, useState } from 'react';

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
  useKnowledgeDocuments,
  useReprocessKnowledgeDocument,
  useUploadKnowledgeDocument,
} from '@/features/admin/hooks/useAiKnowledge';
import { extractText, ExtractionError } from '@/features/admin/utils/extractText';
import { useListFilters } from '@/hooks/useListFilters';
import type { KnowledgeListQuery } from '@/services/aiApi';
import type { KnowledgeDocument, ProcessingStatus } from '@/types/ai';

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
          What the AI is allowed to know. Explanations only ever cite content uploaded here —
          archiving a document removes it from the AI&apos;s reach immediately.
        </p>
      </div>

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
                <CardTitle>No documents yet</CardTitle>
                <CardDescription>
                  Upload RIASEC/SCCT theory overviews and program or career guides. Without them,
                  the AI refuses to explain rather than inventing — students see the deterministic
                  reason only.
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
          PDF or DOCX, up to 10&nbsp;MB. The text is read out here in your browser; the original
          file is kept unchanged for the record.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <input
          ref={inputRef}
          type="file"
          accept=".pdf,.docx"
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

const STATUS_LABEL: Record<ProcessingStatus, string> = {
  UPLOADED: 'Queued',
  PROCESSING: 'Processing',
  COMPLETED: 'Ready',
  FAILED: 'Failed',
};

function DocumentRow({ document }: { document: KnowledgeDocument }) {
  const archive = useArchiveKnowledgeDocument();
  const reprocess = useReprocessKnowledgeDocument();
  const archived = document.archived_at !== null;

  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-4">
        <div>
          <CardTitle className="flex items-center gap-2">
            {document.file_name}
            <Badge>{document.file_type.toUpperCase()}</Badge>
            {archived ? (
              <Badge>Archived</Badge>
            ) : (
              <Badge tone={document.processing_status === 'COMPLETED' ? 'success' : undefined}>
                {STATUS_LABEL[document.processing_status]}
              </Badge>
            )}
          </CardTitle>
          <CardDescription>
            Uploaded {new Date(document.created_at).toLocaleString()}
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

      {archived ? (
        <CardContent>
          <p className="text-sm text-muted-foreground">
            No longer retrievable by the AI. The file and its history are kept — nothing is ever
            deleted.
          </p>
        </CardContent>
      ) : null}
    </Card>
  );
}
