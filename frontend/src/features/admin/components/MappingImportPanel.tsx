import { FileUp, X } from 'lucide-react';
import { type ChangeEvent, useState } from 'react';

import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useImportMapping } from '@/features/admin/hooks/useCatalog';
import { parseCsv } from '@/lib/csv';
import { toast } from '@/stores/toastStore';
import { ApiRequestError } from '@/types/api';
import type { MappingImportPlan, MappingImportRow, PlannedLink } from '@/types/catalog';

/**
 * Import an edited copy of the program → career mapping (backend 2026-09-22).
 *
 * The file is previewed before anything is written: the panel shows exactly which links would be
 * added, removed and re-graded, and every bad line by its spreadsheet line number. Only programs
 * named in the file are touched — the panel says so, because "I uploaded three programs and the
 * other thirty-eight are fine" is the thing an administrator needs to be sure of before pressing
 * Apply.
 */
export function MappingImportPanel({ onDone }: { onDone: () => void }) {
  const importMapping = useImportMapping();

  const [fileName, setFileName] = useState<string | null>(null);
  const [rows, setRows] = useState<MappingImportRow[] | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);
  const [plan, setPlan] = useState<MappingImportPlan | null>(null);

  const changes = plan ? plan.adds.length + plan.removes.length + plan.regrades.length : 0;
  const serverError = importMapping.error instanceof ApiRequestError ? importMapping.error : null;

  async function onFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];

    setPlan(null);
    setRows(null);
    setParseError(null);
    importMapping.reset();

    if (!file) return;

    setFileName(file.name);

    const parsed = readMappingCsv(await file.text());

    if ('error' in parsed) {
      setParseError(parsed.error);
      return;
    }

    setRows(parsed.rows);
    importMapping.mutate({ rows: parsed.rows, apply: false }, { onSuccess: setPlan });
  }

  function apply() {
    if (!rows) return;

    importMapping.mutate(
      { rows, apply: true },
      {
        onSuccess: (applied) => {
          toast.success(
            `Mapping imported: ${applied.adds.length} linked, ${applied.removes.length} unlinked, ${applied.regrades.length} re-graded.`,
          );
          onDone();
        },
      },
    );
  }

  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-3">
        <div>
          <CardTitle>Import the program → career mapping</CardTitle>
          <CardDescription>
            Upload a CSV with the columns <code>program_code</code>, <code>career_title</code> and{' '}
            <code>relationship</code> (direct, related or conditional — blank means direct). Start
            from an export. For each program in the file, the file becomes its complete list of
            careers. Programs not in the file are not touched.
          </CardDescription>
        </div>
        <Button variant="ghost" size="sm" onClick={onDone} aria-label="Close the import panel">
          <X className="size-4" aria-hidden="true" />
        </Button>
      </CardHeader>

      <CardContent className="flex flex-col gap-4">
        <label className="inline-flex w-fit cursor-pointer items-center gap-2 border border-border px-4 py-2 text-sm hover:bg-secondary">
          <FileUp className="size-4" aria-hidden="true" />
          {fileName ?? 'Choose a CSV file…'}
          <input type="file" accept=".csv,text/csv" className="sr-only" onChange={onFile} />
        </label>

        {parseError ? <Alert>{parseError}</Alert> : null}
        {serverError ? <Alert>{serverError.message}</Alert> : null}

        {importMapping.isPending && !plan ? (
          <p className="text-sm text-muted-foreground" role="status">
            Checking the file…
          </p>
        ) : null}

        {plan ? (
          <div className="flex flex-col gap-3">
            <p className="text-sm text-foreground">
              {plan.programs_in_file} {plan.programs_in_file === 1 ? 'program' : 'programs'} in the
              file: <strong>{plan.adds.length}</strong> to link,{' '}
              <strong>{plan.removes.length}</strong> to unlink,{' '}
              <strong>{plan.regrades.length}</strong> to re-grade, {plan.unchanged} unchanged.
            </p>

            {plan.errors.length > 0 ? (
              <Alert>
                <span className="font-medium">
                  Fix {plan.errors.length === 1 ? 'this line' : `these ${plan.errors.length} lines`}{' '}
                  and upload again — nothing is imported while any line is wrong.
                </span>
                <ul className="mt-1 list-disc pl-5">
                  {plan.errors.slice(0, 50).map((error) => (
                    <li key={`${error.line}:${error.message}`}>
                      Line {error.line}: {error.message}
                    </li>
                  ))}
                </ul>
              </Alert>
            ) : null}

            <PlanList title="Will be linked" links={plan.adds} />
            <PlanList title="Will be unlinked" links={plan.removes} />
            <PlanList
              title="Will be re-graded"
              links={plan.regrades}
              describe={(link) =>
                `${link.program_code} → ${link.career_title}: ${(link as PlannedLink & { from: string }).from} → ${link.relationship}`
              }
            />

            <div className="flex flex-wrap gap-2">
              <Button
                onClick={apply}
                loading={importMapping.isPending}
                disabled={plan.errors.length > 0 || changes === 0 || importMapping.isPending}
              >
                {changes === 0 ? 'Nothing to change' : `Apply ${changes} changes`}
              </Button>
              <Button variant="ghost" onClick={onDone}>
                Cancel
              </Button>
            </div>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

function PlanList({
  title,
  links,
  describe = (link) => `${link.program_code} → ${link.career_title} (${link.relationship})`,
}: {
  title: string;
  links: PlannedLink[];
  describe?: (link: PlannedLink) => string;
}) {
  if (links.length === 0) return null;

  return (
    <details className="border border-border p-3 text-sm">
      <summary className="cursor-pointer font-medium text-foreground">
        {title} ({links.length})
      </summary>
      <ul className="mt-2 flex flex-col gap-1 text-muted-foreground">
        {links.map((link) => (
          <li key={`${link.program_code}:${link.career_title}`}>{describe(link)}</li>
        ))}
      </ul>
    </details>
  );
}

/**
 * CSV text → import rows, by **header name**, not position: an export carries two extra columns
 * (program name, Holland code) for the person editing it, and a spreadsheet user may reorder or add
 * columns. Only `program_code` and `career_title` are required.
 */
export function readMappingCsv(text: string): { rows: MappingImportRow[] } | { error: string } {
  const [header, ...body] = parseCsv(text);

  if (!header) {
    return { error: 'The file is empty.' };
  }

  const names = header.map((name) => name.trim().toLowerCase());
  const code = names.indexOf('program_code');
  const title = names.indexOf('career_title');
  const relationship = names.indexOf('relationship');

  if (code < 0 || title < 0) {
    return {
      error: 'The first line must name the columns, including program_code and career_title.',
    };
  }

  if (body.length === 0) {
    return { error: 'The file has a header but no rows.' };
  }

  return {
    rows: body.map((fields) => ({
      program_code: fields[code] ?? '',
      career_title: fields[title] ?? '',
      relationship: relationship < 0 ? '' : (fields[relationship] ?? ''),
    })),
  };
}
