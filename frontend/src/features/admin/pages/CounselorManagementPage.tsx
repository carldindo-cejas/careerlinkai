import { Copy, UserPlus } from 'lucide-react';
import { useState, type FormEvent } from 'react';

import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  useCounselors,
  useCreateCounselor,
  useDeleteCounselor,
  useUpdateCounselor,
} from '@/features/admin/hooks/usePlatformAdmin';
import { ApiRequestError } from '@/types/api';
import type { ManagedCounselor } from '@/types/platform';

/**
 * Counselor management (FULLPLAN §20, §37 — Phase 6, admin only).
 *
 * Creation follows the §38 temp-password shape: the server generates the password and this
 * page shows it exactly once, in a banner the admin is told to copy now. It is not stored,
 * not logged, and not retrievable — the counselor's first login forces a rotation, which is
 * the moment the admin-known credential dies (§13.1).
 */
export function CounselorManagementPage() {
  const [search, setSearch] = useState('');
  const [appliedSearch, setAppliedSearch] = useState('');
  const [page, setPage] = useState(1);
  const [showCreate, setShowCreate] = useState(false);
  const [issued, setIssued] = useState<{ email: string; password: string } | null>(null);

  const { data, isLoading, isError, error, isFetching } = useCounselors({
    page,
    ...(appliedSearch === '' ? {} : { search: appliedSearch }),
  });

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold text-foreground">Counselors</h1>
          <p className="text-sm text-muted-foreground">
            The accounts that can create classes and read their students’ results.
          </p>
        </div>
        <Button onClick={() => setShowCreate((value) => !value)}>
          <UserPlus className="size-4" aria-hidden="true" />
          {showCreate ? 'Close' : 'Add a counselor'}
        </Button>
      </div>

      {issued ? (
        <Alert tone="warning">
          <div className="flex flex-col gap-1">
            <p>
              Temporary password for <span className="font-semibold">{issued.email}</span>:{' '}
              <code className="rounded-none bg-background/70 px-1.5 py-0.5 font-mono text-sm">
                {issued.password}
              </code>
              <button
                type="button"
                className="ml-2 inline-flex items-center gap-1 text-xs font-medium underline"
                onClick={() => void navigator.clipboard?.writeText(issued.password)}
              >
                <Copy className="size-3" aria-hidden="true" />
                Copy
              </button>
            </p>
            <p className="text-xs">
              Share it securely now — it is shown only this once and cannot be retrieved.
              Their first sign-in forces them to choose their own password.
            </p>
          </div>
        </Alert>
      ) : null}

      {showCreate ? (
        <CreateCounselorCard
          onCreated={(email, password) => {
            setIssued({ email, password });
            setShowCreate(false);
          }}
        />
      ) : null}

      <form
        className="flex flex-wrap items-end gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          setPage(1);
          setAppliedSearch(search.trim());
        }}
      >
        <div className="flex flex-col gap-1">
          <Label htmlFor="counselor-search">Search</Label>
          <Input
            id="counselor-search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Name or email"
            className="w-72"
          />
        </div>
        <Button type="submit" variant="secondary" size="sm">
          Search
        </Button>
        {appliedSearch !== '' ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => {
              setSearch('');
              setAppliedSearch('');
              setPage(1);
            }}
          >
            Clear
          </Button>
        ) : null}
      </form>

      {isLoading ? <p className="text-sm text-muted-foreground">Loading counselors…</p> : null}

      {isError ? <Alert>We could not load the counselor list. {error.message}</Alert> : null}

      {data && data.items.length === 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>
              {appliedSearch === '' ? 'No counselors yet' : 'No counselors match that search'}
            </CardTitle>
            <CardDescription>
              Add a counselor to give them a sign-in — the temporary password appears once,
              right here.
            </CardDescription>
          </CardHeader>
        </Card>
      ) : null}

      {data?.items.map((counselor) => <CounselorRow key={counselor.id} counselor={counselor} />)}

      {data && data.pagination.last_page > 1 ? (
        <div className="flex items-center justify-between">
          <p className="text-sm text-muted-foreground">
            Page {data.pagination.current_page} of {data.pagination.last_page} ·{' '}
            {data.pagination.total} counselors
          </p>
          <div className="flex gap-2">
            <Button
              variant="secondary"
              size="sm"
              disabled={page <= 1 || isFetching}
              onClick={() => setPage((value) => value - 1)}
            >
              Previous
            </Button>
            <Button
              variant="secondary"
              size="sm"
              disabled={page >= data.pagination.last_page || isFetching}
              onClick={() => setPage((value) => value + 1)}
            >
              Next
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function CreateCounselorCard({
  onCreated,
}: {
  onCreated: (email: string, temporaryPassword: string) => void;
}) {
  const create = useCreateCounselor();
  const [form, setForm] = useState({
    email: '',
    first_name: '',
    last_name: '',
    specialization: '',
  });

  const failure = create.error instanceof ApiRequestError ? create.error : null;

  function submit(event: FormEvent) {
    event.preventDefault();

    create.mutate(
      {
        email: form.email.trim(),
        first_name: form.first_name.trim(),
        last_name: form.last_name.trim(),
        specialization: form.specialization.trim() === '' ? null : form.specialization.trim(),
      },
      {
        onSuccess: (created) => {
          onCreated(created.email ?? form.email.trim(), created.temporary_password);
          setForm({ email: '', first_name: '', last_name: '', specialization: '' });
        },
      },
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>New counselor</CardTitle>
        <CardDescription>
          No password field here, on purpose: the system generates a temporary one and shows
          it to you exactly once after the account is created.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form className="grid gap-4 sm:grid-cols-2" onSubmit={submit}>
          <FormField
            id="new-first-name"
            label="First name"
            value={form.first_name}
            onChange={(value) => setForm((state) => ({ ...state, first_name: value }))}
            error={failure?.fieldError('first_name')}
            required
          />
          <FormField
            id="new-last-name"
            label="Last name"
            value={form.last_name}
            onChange={(value) => setForm((state) => ({ ...state, last_name: value }))}
            error={failure?.fieldError('last_name')}
            required
          />
          <FormField
            id="new-email"
            label="Email"
            type="email"
            value={form.email}
            onChange={(value) => setForm((state) => ({ ...state, email: value }))}
            error={failure?.fieldError('email')}
            required
          />
          <FormField
            id="new-specialization"
            label="Specialization (optional)"
            value={form.specialization}
            onChange={(value) => setForm((state) => ({ ...state, specialization: value }))}
            error={failure?.fieldError('specialization')}
          />

          {failure && Object.keys(failure.errors).length === 0 ? (
            <p className="text-sm text-destructive sm:col-span-2">{failure.message}</p>
          ) : null}

          <div className="sm:col-span-2">
            <Button type="submit" loading={create.isPending}>
              Create account
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

function FormField({
  id,
  label,
  value,
  onChange,
  error,
  type = 'text',
  required = false,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  error?: string | undefined;
  type?: string;
  required?: boolean;
}) {
  return (
    <div className="flex flex-col gap-1">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        type={type}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        required={required}
      />
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
    </div>
  );
}

function CounselorRow({ counselor }: { counselor: ManagedCounselor }) {
  const update = useUpdateCounselor();
  const remove = useDeleteCounselor();
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const suspended = counselor.status === 'suspended';

  return (
    <Card>
      <CardContent className="flex flex-wrap items-center gap-x-6 gap-y-3 p-5">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium text-foreground">{counselor.name}</span>
            <Badge tone={counselor.status === 'active' ? 'success' : 'warning'}>
              {counselor.status}
            </Badge>
            {counselor.must_change_password ? (
              <Badge tone="neutral" className="normal-case">
                awaiting first sign-in
              </Badge>
            ) : null}
          </div>
          <p className="mt-0.5 truncate text-sm text-muted-foreground">
            {counselor.email}
            {counselor.counselor_profile?.specialization
              ? ` · ${counselor.counselor_profile.specialization}`
              : ''}
          </p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {counselor.classes_count} {counselor.classes_count === 1 ? 'class' : 'classes'} ·{' '}
            {counselor.students_count} active {counselor.students_count === 1 ? 'student' : 'students'}
          </p>
        </div>

        <div className="flex items-center gap-2">
          <Button
            variant="secondary"
            size="sm"
            loading={update.isPending}
            onClick={() =>
              update.mutate({
                id: counselor.id,
                payload: { status: suspended ? 'active' : 'suspended' },
              })
            }
          >
            {suspended ? 'Reactivate' : 'Suspend'}
          </Button>

          {confirmingDelete ? (
            <>
              <Button
                variant="danger"
                size="sm"
                loading={remove.isPending}
                onClick={() => remove.mutate(counselor.id)}
              >
                Confirm removal
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setConfirmingDelete(false)}>
                Keep
              </Button>
            </>
          ) : (
            <Button variant="ghost" size="sm" onClick={() => setConfirmingDelete(true)}>
              Remove
            </Button>
          )}
        </div>

        {update.isError || remove.isError ? (
          <p className="w-full text-sm text-destructive">
            {(update.error ?? remove.error)?.message ?? 'The change failed.'}
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}
