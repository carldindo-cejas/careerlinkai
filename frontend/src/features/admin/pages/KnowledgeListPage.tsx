import { useRef, useState } from 'react';

import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  useArchiveKnowledgeDocument,
  useKnowledgeDocuments,
  useReprocessKnowledgeDocument,
  useUploadKnowledgeDocument,
} from '@/features/admin/hooks/useAiKnowledge';
import { extractText, ExtractionError } from '@/features/admin/utils/extractText';
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
  const { data, isLoading, isError, error } = useKnowledgeDocuments();

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold text-slate-900">Knowledge documents</h1>
        <p className="text-sm text-slate-500">
          What the AI is allowed to know. Explanations only ever cite content uploaded here —
          archiving a document removes it from the AI&apos;s reach immediately.
        </p>
      </div>

      <UploadCard />

      {isLoading ? <p className="text-sm text-slate-500">Loading documents…</p> : null}

      {isError ? (
        <Alert>We could not load the document list. {error.message}</Alert>
      ) : null}

      {data && data.items.length === 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>No documents yet</CardTitle>
            <CardDescription>
              Upload RIASEC/SCCT theory overviews and program or career guides. Without them, the
              AI refuses to explain rather than inventing — students see the deterministic reason
              only.
            </CardDescription>
          </CardHeader>
        </Card>
      ) : null}

      {data?.items.map((document) => (
        <DocumentRow key={document.id} document={document} />
      ))}
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
          className="text-sm text-slate-600 file:mr-3 file:rounded-md file:border-0 file:bg-slate-100 file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-slate-700 hover:file:bg-slate-200"
          disabled={extracting || upload.isPending}
          onChange={(event) => {
            const file = event.target.files?.[0];

            if (file) {
              void handleFile(file);
            }
          }}
        />

        {extracting ? (
          <p className="text-sm text-slate-500">Extracting text from the document…</p>
        ) : null}
        {upload.isPending ? <p className="text-sm text-slate-500">Uploading…</p> : null}
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
          <p className="text-sm text-slate-500">
            No longer retrievable by the AI. The file and its history are kept — nothing is ever
            deleted.
          </p>
        </CardContent>
      ) : null}
    </Card>
  );
}
