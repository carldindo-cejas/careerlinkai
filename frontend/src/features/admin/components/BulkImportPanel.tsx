import { CheckSquare, ListPlus, Square } from 'lucide-react';
import { useMemo, useState } from 'react';

import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/stores/toastStore';
import type { AddressRow, BulkItem, BulkResult } from '@/types/address';

/**
 * The bulk-import workflow shared by all four levels: paste one name per line, review a checkbox
 * preview of the parsed rows, then save only the checked ones. Nothing is written until "Add" —
 * the textarea is a staging area, the preview is the commit.
 *
 * Duplicate handling is split by concern: the preview dedupes *within the paste* case-insensitively
 * (two identical lines are one row to tick), and the server ignores duplicates *against what is
 * already stored* — so the admin never has to know which of the pasted places already existed.
 */

interface BulkImportPanelProps {
  /** Singular noun for the level, e.g. "region" — used throughout the copy. */
  noun: string;
  /** Resolves with the server's created/skipped breakdown; the panel raises the result toast. */
  onImport: (items: BulkItem[]) => Promise<BulkResult<AddressRow>>;
  isImporting: boolean;
  /** When set, the panel is inert and shows this hint instead of the form (no parent selected). */
  disabledHint?: string;
}

interface PreviewRow {
  name: string;
  checked: boolean;
}

/** Split a paste into trimmed, non-empty, case-insensitively unique names (first occurrence wins). */
function parse(text: string): string[] {
  const seen = new Set<string>();
  const names: string[] = [];

  for (const line of text.split('\n')) {
    const name = line.trim();
    if (name.length === 0) continue;

    const key = name.toLowerCase();
    if (seen.has(key)) continue;

    seen.add(key);
    names.push(name);
  }

  return names;
}

export function BulkImportPanel({ noun, onImport, isImporting, disabledHint }: BulkImportPanelProps) {
  const [text, setText] = useState('');
  const [rows, setRows] = useState<PreviewRow[] | null>(null);

  const checkedCount = useMemo(
    () => (rows ? rows.filter((row) => row.checked).length : 0),
    [rows],
  );

  if (disabledHint) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Bulk add {noun}s</CardTitle>
          <CardDescription>{disabledHint}</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  function preview() {
    const names = parse(text);

    if (names.length === 0) {
      toast.error(`Paste at least one ${noun} — one per line.`);

      return;
    }

    setRows(names.map((name) => ({ name, checked: true })));
  }

  function setAll(checked: boolean) {
    setRows((current) => current?.map((row) => ({ ...row, checked })) ?? current);
  }

  function toggle(index: number) {
    setRows(
      (current) =>
        current?.map((row, i) => (i === index ? { ...row, checked: !row.checked } : row)) ?? current,
    );
  }

  async function add() {
    if (!rows) return;

    const items: BulkItem[] = rows.filter((row) => row.checked).map((row) => ({ name: row.name }));

    if (items.length === 0) {
      toast.error(`Tick at least one ${noun} to add.`);

      return;
    }

    // The confirmation gate before anything is written (§ the task's "Confirmation dialog before
    // saving"). A native confirm matches the rest of the admin surface (CareerListPage, etc.).
    if (!window.confirm(`Add ${items.length} ${noun}${items.length === 1 ? '' : 's'}?`)) {
      return;
    }

    try {
      const result = await onImport(items);
      const added = result.created.length;
      const skipped = result.skipped.length;

      toast.success(
        skipped === 0
          ? `Added ${added} ${noun}${added === 1 ? '' : 's'}.`
          : `Added ${added}; skipped ${skipped} already in the list.`,
      );

      setText('');
      setRows(null);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : `Could not add the ${noun}s.`);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Bulk add {noun}s</CardTitle>
        <CardDescription>
          Paste one {noun} per line. Nothing is saved until you review the list below and choose
          Add — duplicates already in the system are ignored automatically.
        </CardDescription>
      </CardHeader>

      <CardContent className="flex flex-col gap-4">
        <Textarea
          value={text}
          onChange={(event) => setText(event.target.value)}
          rows={6}
          placeholder={`One ${noun} per line…`}
          aria-label={`${noun}s to import, one per line`}
        />

        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="secondary" size="sm" onClick={preview} disabled={isImporting}>
            <ListPlus className="size-4" aria-hidden="true" />
            Preview
          </Button>
        </div>

        {rows ? (
          <div className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-sm text-muted-foreground">
                {checkedCount} of {rows.length} selected
              </p>
              <div className="flex gap-2">
                <Button type="button" variant="ghost" size="sm" onClick={() => setAll(true)}>
                  <CheckSquare className="size-4" aria-hidden="true" />
                  Select all
                </Button>
                <Button type="button" variant="ghost" size="sm" onClick={() => setAll(false)}>
                  <Square className="size-4" aria-hidden="true" />
                  Deselect all
                </Button>
              </div>
            </div>

            <ul className="max-h-64 divide-y divide-border overflow-y-auto border border-border">
              {rows.map((row, index) => (
                <li key={`${row.name}-${index}`}>
                  <label className="flex cursor-pointer items-center gap-3 px-3 py-2 text-sm hover:bg-secondary">
                    <input
                      type="checkbox"
                      checked={row.checked}
                      onChange={() => toggle(index)}
                      className="size-4 accent-primary"
                    />
                    <span className="text-foreground/90">{row.name}</span>
                  </label>
                </li>
              ))}
            </ul>

            {checkedCount === 0 ? (
              <Alert tone="info">Tick at least one {noun} to add.</Alert>
            ) : null}

            <div>
              <Button type="button" onClick={add} loading={isImporting} disabled={checkedCount === 0}>
                Add {checkedCount > 0 ? checkedCount : ''} {noun}
                {checkedCount === 1 ? '' : 's'}
              </Button>
            </div>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
