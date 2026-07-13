import { ArrowLeft, Trash2, UserPlus } from 'lucide-react';
import { useState } from 'react';

import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { useConfirmRoster, usePreviewRoster } from '@/features/counselor/hooks/useRoster';
import { ApiRequestError } from '@/types/api';
import type { ConfirmedStudent, PreviewedStudent } from '@/types/class';

/**
 * Bulk roster provisioning (FULLPLAN §16, §57).
 *
 * The two-step shape of this component mirrors the two endpoints, and both exist for the
 * same reason: the counselor must see and be able to *fix* every generated username before
 * a single account exists. Preview persists nothing. Confirm creates the accounts, and one
 * bad username rejects the whole batch — there is no half-provisioned roster, so the errors
 * have to be rendered against the rows that caused them rather than as one opaque failure.
 */

/** §13.2 caps a batch at 200 names. */
const MAX_NAMES = 200;

type Step = 'paste' | 'review';

export interface RosterBuilderProps {
  classId: string;
  onConfirmed: (count: number) => void;
}

export function RosterBuilder({ classId, onConfirmed }: RosterBuilderProps) {
  const [step, setStep] = useState<Step>('paste');
  const [pasted, setPasted] = useState('');
  const [rows, setRows] = useState<ConfirmedStudent[]>([]);

  const preview = usePreviewRoster(classId);
  const confirm = useConfirmRoster(classId);

  const names = parseNames(pasted);
  const tooMany = names.length > MAX_NAMES;

  const previewError = preview.error instanceof ApiRequestError ? preview.error : null;
  const confirmError = confirm.error instanceof ApiRequestError ? confirm.error : null;

  const startOver = () => {
    setStep('paste');
    setRows([]);
    preview.reset();
    confirm.reset();
  };

  const onPreview = () => {
    confirm.reset();

    preview.mutate(names, {
      onSuccess: (proposed) => {
        setRows(proposed.map(toEditableRow));
        setStep('review');
      },
    });
  };

  const onConfirm = () => {
    confirm.mutate(rows, {
      onSuccess: (created) => {
        setPasted('');
        setRows([]);
        setStep('paste');
        confirm.reset();
        onConfirmed(created.length);
      },
    });
  };

  const updateRow = (index: number, patch: Partial<ConfirmedStudent>) => {
    setRows((current) =>
      current.map((row, i) => (i === index ? { ...row, ...patch } : row)),
    );
  };

  const removeRow = (index: number) => {
    setRows((current) => current.filter((_, i) => i !== index));
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Add students</CardTitle>
        <CardDescription>
          {step === 'paste'
            ? 'Paste one name per line. Usernames are generated for you to review before any account is created.'
            : 'Check the usernames. Students type these to sign in, so edit anything that looks wrong.'}
        </CardDescription>
      </CardHeader>

      <CardContent className="flex flex-col gap-4">
        {step === 'paste' ? (
          <>
            {previewError ? <Alert>{previewError.message}</Alert> : null}

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="names">Student names</Label>
              <Textarea
                id="names"
                rows={8}
                value={pasted}
                onChange={(event) => setPasted(event.target.value)}
                placeholder={'Juan Dela Cruz\nMaria Santos\nJosé Peña'}
                aria-invalid={tooMany}
              />
              <p className="text-sm text-slate-500">
                {names.length} {names.length === 1 ? 'name' : 'names'}
                {tooMany ? (
                  <span className="text-red-600">
                    {' '}
                    — that is over the limit of {MAX_NAMES} per batch. Split it up.
                  </span>
                ) : null}
              </p>
            </div>

            <div>
              <Button
                onClick={onPreview}
                loading={preview.isPending}
                disabled={names.length === 0 || tooMany}
              >
                <UserPlus className="size-4" aria-hidden="true" />
                Generate usernames
              </Button>
            </div>
          </>
        ) : (
          <>
            {/*
              A 422 here means the whole batch was refused. The message alone is useless to
              a counselor staring at 40 rows, so the per-row errors below say which ones.
            */}
            {confirmError ? (
              <Alert>
                {Object.keys(confirmError.errors).length > 0
                  ? 'No accounts were created. Fix the highlighted rows and confirm again.'
                  : confirmError.message}
              </Alert>
            ) : null}

            <ul className="flex flex-col gap-3">
              {rows.map((row, index) => (
                <RosterRow
                  key={index}
                  index={index}
                  row={row}
                  error={confirmError}
                  onChange={(patch) => updateRow(index, patch)}
                  onRemove={() => removeRow(index)}
                />
              ))}
            </ul>

            <div className="flex flex-wrap gap-2">
              <Button onClick={onConfirm} loading={confirm.isPending} disabled={rows.length === 0}>
                {confirm.isPending
                  ? 'Creating accounts…'
                  : `Confirm ${rows.length} ${rows.length === 1 ? 'student' : 'students'}`}
              </Button>

              <Button variant="secondary" onClick={startOver}>
                <ArrowLeft className="size-4" aria-hidden="true" />
                Back to the name list
              </Button>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

interface RosterRowProps {
  index: number;
  row: ConfirmedStudent;
  error: ApiRequestError | null;
  onChange: (patch: Partial<ConfirmedStudent>) => void;
  onRemove: () => void;
}

function RosterRow({ index, row, error, onChange, onRemove }: RosterRowProps) {
  // The server reports failures positionally — `students.3.username` — which is the only
  // thing tying a message back to the row the counselor has to actually fix.
  const fieldError = (field: keyof ConfirmedStudent) =>
    error?.fieldError(`students.${index}.${field}`);

  const hasError = (['first_name', 'last_name', 'username'] as const).some((field) =>
    Boolean(fieldError(field)),
  );

  return (
    <li
      className={
        hasError
          ? 'rounded-md border border-red-300 bg-red-50 p-3'
          : 'rounded-md border border-slate-200 p-3'
      }
    >
      <div className="flex items-end gap-3">
        <div className="grid flex-1 gap-3 sm:grid-cols-3">
          <Field
            label="First name"
            id={`first-name-${index}`}
            value={row.first_name}
            error={fieldError('first_name')}
            onChange={(value) => onChange({ first_name: value })}
          />

          <Field
            label="Last name"
            id={`last-name-${index}`}
            // A mononym has no last name, and NULL is how that is stored (§13.1, v1.2) —
            // so an empty box here is a valid answer, not an unfinished one.
            value={row.last_name ?? ''}
            error={fieldError('last_name')}
            onChange={(value) => onChange({ last_name: value.trim() === '' ? null : value })}
          />

          <Field
            label="Username"
            id={`username-${index}`}
            value={row.username}
            error={fieldError('username')}
            className="font-mono"
            onChange={(value) => onChange({ username: value })}
          />
        </div>

        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={onRemove}
          aria-label={`Remove ${row.first_name} from this batch`}
        >
          <Trash2 className="size-4" aria-hidden="true" />
        </Button>
      </div>
    </li>
  );
}

interface FieldProps {
  label: string;
  id: string;
  value: string;
  error?: string | undefined;
  className?: string | undefined;
  onChange: (value: string) => void;
}

function Field({ label, id, value, error, className, onChange }: FieldProps) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id} className="text-xs text-slate-500">
        {label}
      </Label>
      <Input
        id={id}
        value={value}
        className={className}
        aria-invalid={Boolean(error)}
        onChange={(event) => onChange(event.target.value)}
      />
      {error ? <p className="text-sm text-red-600">{error}</p> : null}
    </div>
  );
}

/** One name per line; blank lines are not names. */
function parseNames(pasted: string): string[] {
  return pasted
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
}

function toEditableRow(proposed: PreviewedStudent): ConfirmedStudent {
  return {
    first_name: proposed.first_name,
    last_name: proposed.last_name,
    username: proposed.username,
  };
}
