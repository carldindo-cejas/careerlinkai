import { zodResolver } from '@hookform/resolvers/zod';
import { AtSign, KeyRound, MailCheck, ShieldCheck, UserRound } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useForm, type UseFormRegisterReturn } from 'react-hook-form';
import { z } from 'zod';

import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { describedBy, FieldError } from '@/components/ui/field-error';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { useChangePassword } from '@/features/auth/hooks/useAuth';
import {
  PENDING_EMAIL_CHANGE_QUERY_KEY,
  useCancelEmailChange,
  usePendingEmailChange,
  useRequestEmailChange,
  useResendEmailChangeCode,
  useUpdateAccount,
  useVerifyEmailChange,
} from '@/features/counselor/hooks/useAccount';
import { useAuthStore } from '@/stores/authStore';
import { toast } from '@/stores/toastStore';
import { ApiRequestError } from '@/types/api';
import type { PendingEmailChange } from '@/services/accountApi';
import type { CounselorProfile } from '@/types/user';

/**
 * The counselor's own account (`/counselor/profile`, prompt-driven 2026-09-20).
 *
 * ## What belongs on this page, and what does not
 *
 * A counselor had nowhere to correct their own name, address or password: the only editor for a
 * counselor record was the *administrator's* screen, so a misspelt surname on a class roster was a
 * support request rather than a form. This page is the answer, and it is deliberately only three
 * things:
 *
 *   * **Who you are** — the name printed in the sidebar and shown to every student's counselor
 *     field, plus the profile details a counselor already typed at sign-up (phone, employee
 *     number, specialization, a line of bio).
 *   * **The address you sign in with.**
 *   * **Your password.**
 *
 * Nothing about *classes*, *students* or *assessments* is here, and that is the line: those are
 * work, and work lives in the navigation. An account is where you go when something about you is
 * wrong, which is why the route is reached from the identity chrome rather than from a nav row.
 *
 * ## Three forms, not one
 *
 * They are separate because they carry different risk and therefore different rules, and a single
 * Save would have had to pretend otherwise:
 *
 *   * The details form asks for no password. A display name is a label on an account, not a way
 *     into it.
 *   * Changing the email **re-proves the current password**, because the address is the login
 *     identifier *and* where a password reset is delivered — an unattended session in a staffroom
 *     is otherwise one form submission away from becoming somebody else's account. The card asks
 *     for the address alone and puts the password in a prompt after Update email, so a browser has
 *     no login-shaped pair to autofill. It does not sign you out: nothing you hold became less
 *     trustworthy.
 *   * Changing the password **does** sign you out, everywhere, because §38 revokes every token
 *     when a credential rotates. The card says so before it is submitted rather than after.
 *
 * ## Administrators land here too
 *
 * `ClassPolicy` lets an admin through the counselor shell (§39), and an admin has no counselor
 * profile for a first and last name to live in. The details card renders a single "Display name"
 * field for them — the same endpoint, the branch the server already makes.
 */

const detailsSchema = z.object({
  first_name: z.string().trim().min(1, 'A first name is required.').max(100),
  last_name: z.string().trim().min(1, 'A last name is required.').max(100),
  phone: z.string().trim().max(30),
  employee_number: z.string().trim().max(50),
  specialization: z.string().trim().max(150),
  bio: z.string().trim().max(1000),
});

const adminDetailsSchema = z.object({
  name: z.string().trim().min(1, 'A name is required.').max(150),
});

const emailSchema = z.object({
  email: z.email('Enter a valid email address.'),
});

const emailConfirmSchema = z.object({
  current_password: z.string().min(1, 'Your current password is required.'),
});

/** Mirrors `verifyEmailChangeSchema` on the server — six digits, nothing else to get wrong. */
const emailCodeSchema = z.object({
  code: z
    .string()
    .trim()
    .regex(/^\d{6}$/, 'Enter the six-digit code from your email.'),
});

/**
 * What it takes to keep a browser out of a box.
 *
 * `autoComplete="off"` alone is advisory — Chrome overrides it for anything that smells like a
 * credential, and the password managers ignore it outright. These are the vendor opt-outs each one
 * actually honours: 1Password (`data-1p-ignore`), LastPass (`data-lpignore`), Bitwarden
 * (`data-bwignore`) and Dashlane (`data-form-type="other"`). Used only on the sign-in email card,
 * where a pre-filled address and password are what made changing the address risky in the first
 * place.
 */
const NO_AUTOFILL = {
  'data-1p-ignore': true,
  'data-lpignore': 'true',
  'data-bwignore': true,
  'data-form-type': 'other',
} as const;

/** Mirrors `staffPassword` on the server exactly — the control is there, this is the convenience. */
const passwordSchema = z
  .object({
    current_password: z.string().min(1, 'Your current password is required.'),
    password: z
      .string()
      .min(10, 'Use at least 10 characters.')
      .regex(/[A-Z]/, 'Include at least one uppercase letter.')
      .regex(/[a-z]/, 'Include at least one lowercase letter.')
      .regex(/[0-9]/, 'Include at least one number.'),
    password_confirmation: z.string(),
  })
  .refine((values) => values.password === values.password_confirmation, {
    message: 'The passwords do not match.',
    path: ['password_confirmation'],
  })
  .refine((values) => values.password !== values.current_password, {
    message: 'Choose a password different from your current one.',
    path: ['password'],
  });

export function CounselorProfilePage() {
  const user = useAuthStore((state) => state.user);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold text-foreground">My account</h1>
        <p className="text-sm text-muted-foreground">
          Your name, the address you sign in with, and your password.
        </p>
      </div>

      {user ? (
        <>
          {user.counselor_profile ? (
            <DetailsCard key={user.id} profile={user.counselor_profile} />
          ) : (
            <AdminDetailsCard key={user.id} name={user.name} />
          )}
          <EmailSection currentEmail={user.email} />
          <PasswordCard />
        </>
      ) : (
        <p className="text-sm text-muted-foreground">Loading your account…</p>
      )}
    </div>
  );
}

/**
 * The counselor's own details.
 *
 * `users.name` is not a field here. The server derives it from the first and last name, so the
 * roster, the sidebar and the breadcrumb cannot end up disagreeing with the two boxes above them —
 * see `StaffAuthenticationService.updateAccount`.
 */
function DetailsCard({ profile }: { profile: CounselorProfile }) {
  const update = useUpdateAccount();

  const {
    register,
    handleSubmit,
    formState: { errors, isDirty },
    reset,
  } = useForm<z.infer<typeof detailsSchema>>({
    resolver: zodResolver(detailsSchema),
    defaultValues: {
      first_name: profile.first_name,
      last_name: profile.last_name,
      phone: profile.phone ?? '',
      employee_number: profile.employee_number ?? '',
      specialization: profile.specialization ?? '',
      bio: profile.bio ?? '',
    },
  });

  const serverError = update.error instanceof ApiRequestError ? update.error : null;

  const onSubmit = handleSubmit((values) => {
    update.mutate(
      {
        first_name: values.first_name,
        last_name: values.last_name,
        // An emptied box is a *clear*, which only `null` can say — `''` would store a blank
        // string and leave the field looking filled in to anything that checks for one.
        phone: values.phone === '' ? null : values.phone,
        employee_number: values.employee_number === '' ? null : values.employee_number,
        specialization: values.specialization === '' ? null : values.specialization,
        bio: values.bio === '' ? null : values.bio,
      },
      {
        onSuccess: (next) => {
          toast.success('Your details were saved.');
          // Re-baseline the form against what the server actually stored, so `isDirty` goes
          // back to false and a second Save is not offered for a change already made.
          reset({
            first_name: next.counselor_profile?.first_name ?? values.first_name,
            last_name: next.counselor_profile?.last_name ?? values.last_name,
            phone: next.counselor_profile?.phone ?? '',
            employee_number: next.counselor_profile?.employee_number ?? '',
            specialization: next.counselor_profile?.specialization ?? '',
            bio: next.counselor_profile?.bio ?? '',
          });
        },
      },
    );
  });

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <UserRound className="size-4 text-muted-foreground" aria-hidden="true" />
          <CardTitle>Your details</CardTitle>
        </div>
        <CardDescription>
          Your first and last name together are the name students and administrators see you by.
        </CardDescription>
      </CardHeader>

      <CardContent>
        <form onSubmit={onSubmit} className="flex flex-col gap-4" noValidate>
          {serverError && Object.keys(serverError.errors).length === 0 ? (
            <Alert>{serverError.message}</Alert>
          ) : null}

          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              id="first_name"
              label="First name"
              error={errors.first_name?.message ?? serverError?.fieldError('first_name')}
              register={register('first_name')}
              autoComplete="given-name"
            />
            <Field
              id="last_name"
              label="Last name"
              error={errors.last_name?.message ?? serverError?.fieldError('last_name')}
              register={register('last_name')}
              autoComplete="family-name"
            />
            <Field
              id="phone"
              label="Phone"
              hint="Optional."
              error={errors.phone?.message ?? serverError?.fieldError('phone')}
              register={register('phone')}
              autoComplete="tel"
            />
            <Field
              id="employee_number"
              label="Employee number"
              hint="Optional."
              error={
                errors.employee_number?.message ?? serverError?.fieldError('employee_number')
              }
              register={register('employee_number')}
            />
            <div className="sm:col-span-2">
              <Field
                id="specialization"
                label="Specialization"
                hint="Optional — for example “Senior High School guidance”."
                error={
                  errors.specialization?.message ?? serverError?.fieldError('specialization')
                }
                register={register('specialization')}
              />
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="bio">About you</Label>
            <Textarea
              id="bio"
              rows={3}
              aria-invalid={Boolean(errors.bio)}
              aria-describedby={describedBy(errors.bio && 'bio-error')}
              {...register('bio')}
            />
            {errors.bio ? <FieldError id="bio-error">{errors.bio.message}</FieldError> : null}
          </div>

          <div className="flex justify-end">
            <Button type="submit" loading={update.isPending} disabled={!isDirty}>
              {update.isPending ? 'Saving…' : 'Save details'}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

/** An administrator in the counselor shell: one name, no profile row to spread it across. */
function AdminDetailsCard({ name }: { name: string }) {
  const update = useUpdateAccount();

  const {
    register,
    handleSubmit,
    formState: { errors, isDirty },
    reset,
  } = useForm<z.infer<typeof adminDetailsSchema>>({
    resolver: zodResolver(adminDetailsSchema),
    defaultValues: { name },
  });

  const serverError = update.error instanceof ApiRequestError ? update.error : null;

  const onSubmit = handleSubmit((values) => {
    update.mutate(
      { name: values.name },
      {
        onSuccess: (next) => {
          toast.success('Your name was saved.');
          reset({ name: next.name });
        },
      },
    );
  });

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <UserRound className="size-4 text-muted-foreground" aria-hidden="true" />
          <CardTitle>Your details</CardTitle>
        </div>
        <CardDescription>The name shown wherever this account appears.</CardDescription>
      </CardHeader>

      <CardContent>
        <form onSubmit={onSubmit} className="flex flex-col gap-4" noValidate>
          {serverError && Object.keys(serverError.errors).length === 0 ? (
            <Alert>{serverError.message}</Alert>
          ) : null}

          <Field
            id="name"
            label="Display name"
            error={errors.name?.message ?? serverError?.fieldError('name')}
            register={register('name')}
            autoComplete="name"
          />

          <div className="flex justify-end">
            <Button type="submit" loading={update.isPending} disabled={!isDirty}>
              {update.isPending ? 'Saving…' : 'Save name'}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

/**
 * The sign-in address, which is **two cards in one slot** rather than one form.
 *
 * ## Why the address does not move when the form is submitted (migration 0039)
 *
 * A password check answers "is this the account holder". It cannot answer the question that
 * actually decides whether this change is survivable: *does this mailbox exist, and does this
 * person read it?* Since the address is the login identifier **and** where a password reset is
 * delivered (§5, D7), a single mistyped character used to cost the login, the recovery path and
 * the account, irreversibly, in one submission.
 *
 * So the form stages the change and the server mails a six-digit code to the address typed into
 * it; this slot then shows the code card until that code comes back. A typo now costs a code that
 * never arrives, and the account stays exactly where it was — the failure mode becomes "nothing
 * happened", which is the correct failure mode for an irreversible identity change.
 *
 * ## Why the pending state is asked for on mount, not remembered
 *
 * The code arrives in a mail client, usually on a phone, while the form is on a desktop — and the
 * tab gets reloaded on the way back. Local state would forget a live change and offer to start a
 * second one; `usePendingEmailChange` asks the server what is outstanding, so a reload lands back
 * on the code card.
 */
function EmailSection({ currentEmail }: { currentEmail: string | null }) {
  const pending = usePendingEmailChange();

  // The first load is the one moment this genuinely does not know which card belongs here. It
  // renders neither rather than guessing at the form — a form that appears and is replaced a
  // heartbeat later invites somebody to start typing into something about to vanish.
  if (pending.isLoading) {
    return (
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <AtSign className="size-4 text-muted-foreground" aria-hidden="true" />
            <CardTitle>Sign-in email</CardTitle>
          </div>
          <CardDescription>Checking your account…</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  return pending.data ? (
    <EmailCodeCard pending={pending.data} currentEmail={currentEmail} />
  ) : (
    <EmailCard currentEmail={currentEmail} />
  );
}

/**
 * Step one: the address to move to, and nothing else on the card.
 *
 * The card used to carry a password box beside the address, and a browser reads that pair as a
 * login form: a counselor opening their own account was met with their saved address and saved
 * password already typed into it, one stray click from moving the account somewhere. So the
 * password is asked for *after* Update email, in a modal, about something specific — and autofill
 * is refused on both boxes (`autoComplete="off"` plus the password managers' own opt-outs) so
 * neither arrives pre-filled.
 *
 * A rejected password keeps the prompt open with the message against the box, while a rejected
 * *address* ("already in use") closes it — that mistake is fixed on the card, not in the prompt.
 */
function EmailCard({ currentEmail }: { currentEmail: string | null }) {
  const requestChange = useRequestEmailChange();
  /** The address waiting on a password — non-null is also what holds the prompt open. */
  const [pendingEmail, setPendingEmail] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    formState: { errors },
    reset,
  } = useForm<z.infer<typeof emailSchema>>({
    resolver: zodResolver(emailSchema),
    defaultValues: { email: '' },
  });

  const serverError = requestChange.error instanceof ApiRequestError ? requestChange.error : null;

  const closePrompt = () => {
    setPendingEmail(null);
    requestChange.reset();
  };

  const onSubmit = handleSubmit((values) => {
    // Drop whatever the last attempt was rejected for: the prompt is about to ask again, and a
    // stale "that password was wrong" over an empty box is an accusation about nothing.
    requestChange.reset();
    setPendingEmail(values.email);
  });

  const onConfirm = (currentPassword: string) => {
    if (pendingEmail === null) return;

    requestChange.mutate(
      { email: pendingEmail, current_password: currentPassword },
      {
        onSuccess: (staged) => {
          toast.success(`We sent a six-digit code to ${staged.pending_email}.`);
          // Both are cleared even though this card is about to be replaced by the code card:
          // cancelling that step brings this one back, and it must come back empty.
          setPendingEmail(null);
          reset({ email: '' });
        },
        onError: (error) => {
          // The address is the problem, not the password — close the prompt so the message
          // lands next to the box that has to change.
          if (error instanceof ApiRequestError && error.fieldError('email')) {
            setPendingEmail(null);
          }
        },
      },
    );
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <AtSign className="size-4 text-muted-foreground" aria-hidden="true" />
          <CardTitle>Sign-in email</CardTitle>
        </div>
        <CardDescription>
          You currently sign in as{' '}
          <span className="break-all font-medium text-foreground">
            {currentEmail ?? 'no address'}
          </span>
          .
        </CardDescription>
      </CardHeader>

      <CardContent>
        <form onSubmit={onSubmit} className="flex flex-col gap-4" noValidate autoComplete="off">
          <p className="border-l-2 border-primary/40 pl-3 text-sm text-muted-foreground">
            We will send a six-digit code to the new address and ask for it here. Nothing changes
            until that code is entered, so a typo costs you nothing.
          </p>

          {serverError && Object.keys(serverError.errors).length === 0 ? (
            <Alert>{serverError.message}</Alert>
          ) : null}

          <Field
            id="new_email"
            label="New email address"
            type="email"
            hint="You will be asked for your password, then for the code we email you."
            error={errors.email?.message ?? serverError?.fieldError('email')}
            register={register('email')}
            autoComplete="off"
            inputProps={NO_AUTOFILL}
          />

          <div className="flex justify-end">
            <Button type="submit" loading={requestChange.isPending} className="w-full sm:w-auto">
              {requestChange.isPending ? 'Sending…' : 'Update email'}
            </Button>
          </div>
        </form>
      </CardContent>

      <Dialog
        open={pendingEmail !== null}
        onOpenChange={(next) => (next ? undefined : closePrompt())}
      >
        {/* Mounted only while open, so the box is empty every time it is asked for and no typed
            password is left sitting in React state after the prompt is dismissed. */}
        {pendingEmail !== null ? (
          <ConfirmEmailPasswordDialog
            email={pendingEmail}
            pending={requestChange.isPending}
            error={serverError}
            onConfirm={onConfirm}
            onCancel={closePrompt}
          />
        ) : null}
      </Dialog>
    </Card>
  );
}

/**
 * The password prompt that stands between Update email and the request.
 *
 * It makes the re-authentication an answer to a specific question — "move this account to *that*
 * address?" — rather than a box sitting on a page all day for a browser to fill in. It names the
 * address for the same reason: this is the last chance to notice a typo before a code is sent to
 * a mailbox that may not exist.
 */
function ConfirmEmailPasswordDialog({
  email,
  pending,
  error,
  onConfirm,
  onCancel,
}: {
  email: string;
  pending: boolean;
  error: ApiRequestError | null;
  onConfirm: (currentPassword: string) => void;
  onCancel: () => void;
}) {
  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<z.infer<typeof emailConfirmSchema>>({
    resolver: zodResolver(emailConfirmSchema),
    defaultValues: { current_password: '' },
  });

  const onSubmit = handleSubmit((values) => onConfirm(values.current_password));

  return (
    <DialogContent
      title="Confirm your password"
      description={`We will send a code to ${email} to finish moving this account.`}
      className="max-w-md"
    >
      <form onSubmit={onSubmit} className="flex flex-col gap-4" noValidate autoComplete="off">
        {error && Object.keys(error.errors).length === 0 ? <Alert>{error.message}</Alert> : null}

        <Field
          id="email_current_password"
          label="Your current password"
          type="password"
          error={errors.current_password?.message ?? error?.fieldError('current_password')}
          register={register('current_password')}
          autoComplete="off"
          inputProps={NO_AUTOFILL}
        />

        {/* Reversed on a phone so the affirmative button is the one under the thumb, and both are
            full width there — two 44px targets side by side do not fit at 320px. */}
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button
            type="button"
            variant="secondary"
            onClick={onCancel}
            disabled={pending}
            className="w-full sm:w-auto"
          >
            Cancel
          </Button>
          <Button type="submit" loading={pending} className="w-full sm:w-auto">
            {pending ? 'Sending…' : 'Send code'}
          </Button>
        </div>
      </form>
    </DialogContent>
  );
}

/**
 * Step two: the code card — the one thing standing between a staged change and a moved account.
 *
 * It replaces the address form rather than sitting under it, because two inputs that both look
 * like "the thing to fill in next" is how somebody ends up typing a new address into a card that
 * is asking for a code. The address being moved to is printed here in full: it is the last place
 * a typo can still be caught, and catching it costs one click on "Use a different address".
 *
 * Three ways out, in the order they are needed: enter the code, ask for another one (the first
 * mail can be slow, filtered, or read on a device that is not to hand), or abandon the change and
 * get the form back. The last one is why cancelling is a button and not a link — a counselor who
 * mistyped the address is *stuck* on this card until something ends it.
 */
function EmailCodeCard({
  pending,
  currentEmail,
}: {
  pending: PendingEmailChange;
  currentEmail: string | null;
}) {
  const queryClient = useQueryClient();
  const verify = useVerifyEmailChange();
  const resend = useResendEmailChangeCode();
  const cancel = useCancelEmailChange();

  const {
    register,
    handleSubmit,
    formState: { errors },
    reset,
  } = useForm<z.infer<typeof emailCodeSchema>>({
    resolver: zodResolver(emailCodeSchema),
    defaultValues: { code: '' },
  });

  const serverError = verify.error instanceof ApiRequestError ? verify.error : null;
  const resendError = resend.error instanceof ApiRequestError ? resend.error : null;
  const busy = verify.isPending || resend.isPending || cancel.isPending;

  const onSubmit = handleSubmit((values) => {
    verify.mutate(values.code, {
      onSuccess: (user) => {
        toast.success(`You will sign in as ${user.email} from now on.`);
      },
    });
  });

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <MailCheck className="size-4 text-muted-foreground" aria-hidden="true" />
          <CardTitle>Confirm your new email</CardTitle>
        </div>
        <CardDescription>
          You still sign in as{' '}
          <span className="break-all font-medium text-foreground">
            {currentEmail ?? 'no address'}
          </span>{' '}
          until this is finished.
        </CardDescription>
      </CardHeader>

      <CardContent>
        <form onSubmit={onSubmit} className="flex flex-col gap-4" noValidate autoComplete="off">
          <p className="border-l-2 border-primary/40 pl-3 text-sm text-muted-foreground">
            We sent a six-digit code to{' '}
            <span className="break-all font-medium text-foreground">{pending.pending_email}</span>
            . It expires in {pending.expires_in_minutes}{' '}
            {pending.expires_in_minutes === 1 ? 'minute' : 'minutes'}. Not your address? Use a
            different one below — nothing has changed yet.
          </p>

          {/* Only ever present in local development, where the API echoes the code — the same
              affordance the signup page has, so the flow is testable with no mail channel. */}
          {pending.verification_code ? (
            <Alert tone="info">
              Local development: your code is{' '}
              <code className="font-mono text-sm">{pending.verification_code}</code>
            </Alert>
          ) : null}

          {serverError && Object.keys(serverError.errors).length === 0 ? (
            <Alert>{serverError.message}</Alert>
          ) : null}
          {resendError ? (
            <Alert>{resendError.fieldError('email') ?? resendError.message}</Alert>
          ) : null}

          <Field
            id="email_code"
            label="Six-digit code"
            hint="From the email we just sent. Check the spam folder if it has not arrived."
            error={errors.code?.message ?? serverError?.fieldError('code')}
            register={register('code')}
            /* `one-time-code` is the one autofill worth having: it is what lets a phone offer the
               code straight from the notification, and it cannot leak a stored credential. */
            autoComplete="one-time-code"
            inputProps={{
              inputMode: 'numeric',
              maxLength: 6,
              placeholder: '000000',
              // Wide tracking on a six-character field, capped so it does not stretch across a
              // desktop card; full width on a phone, where it is the only thing on the row.
              className:
                'w-full font-mono text-lg tracking-[0.4em] sm:max-w-[14rem]',
            }}
          />

          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:items-center sm:justify-between">
            <Button
              type="button"
              variant="ghost"
              disabled={busy}
              className="w-full sm:w-auto"
              onClick={() =>
                cancel.mutate(undefined, {
                  onSuccess: () => {
                    reset({ code: '' });
                    toast.success('The email change was cancelled.');
                  },
                })
              }
            >
              Use a different address
            </Button>

            <div className="flex flex-col-reverse gap-2 sm:flex-row sm:items-center">
              <Button
                type="button"
                variant="secondary"
                loading={resend.isPending}
                disabled={busy}
                className="w-full sm:w-auto"
                onClick={() =>
                  resend.mutate(undefined, {
                    onSuccess: (next) => {
                      reset({ code: '' });
                      toast.success(`A new code is on its way to ${next.pending_email}.`);
                    },
                    onError: (error) => {
                      // 404: nothing is staged any more — it expired, or was finished or cancelled
                      // in another tab. Offering "send a new code" for a change that no longer
                      // exists would leave this card stuck, so hand the form back instead.
                      if (error instanceof ApiRequestError && error.status === 404) {
                        toast.error('That email change has expired. Start again.');
                        queryClient.setQueryData(PENDING_EMAIL_CHANGE_QUERY_KEY, null);
                      }
                    },
                  })
                }
              >
                {resend.isPending ? 'Sending…' : 'Send a new code'}
              </Button>
              <Button
                type="submit"
                loading={verify.isPending}
                disabled={busy}
                className="w-full sm:w-auto"
              >
                {verify.isPending ? 'Confirming…' : 'Confirm email'}
              </Button>
            </div>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

/**
 * The password.
 *
 * `useChangePassword` clears the session on success, because the server revoked every token
 * (§38) — so `ProtectedRoute` takes the counselor to the sign-in screen the moment this resolves.
 * The toast is raised first so the reason is on screen when they arrive there.
 */
function PasswordCard() {
  const changePassword = useChangePassword();

  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<z.infer<typeof passwordSchema>>({
    resolver: zodResolver(passwordSchema),
    defaultValues: { current_password: '', password: '', password_confirmation: '' },
  });

  const serverError =
    changePassword.error instanceof ApiRequestError ? changePassword.error : null;

  const onSubmit = handleSubmit((values) => {
    changePassword.mutate(values, {
      onSuccess: () => toast.success('Password updated. Sign in again with your new password.'),
    });
  });

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <KeyRound className="size-4 text-muted-foreground" aria-hidden="true" />
          <CardTitle>Password</CardTitle>
        </div>
        <CardDescription>
          At least 10 characters, with an uppercase letter, a lowercase letter and a number.
        </CardDescription>
      </CardHeader>

      <CardContent>
        <form onSubmit={onSubmit} className="flex flex-col gap-4" noValidate>
          <p className="flex items-start gap-2 border-l-2 border-primary/40 pl-3 text-sm text-muted-foreground">
            <ShieldCheck className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            Changing this signs you out of every device, including this one. You will be asked to
            sign in again straight away.
          </p>

          {serverError && Object.keys(serverError.errors).length === 0 ? (
            <Alert>{serverError.message}</Alert>
          ) : null}

          <Field
            id="password_current"
            label="Current password"
            type="password"
            error={
              errors.current_password?.message ?? serverError?.fieldError('current_password')
            }
            register={register('current_password')}
            autoComplete="current-password"
          />

          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              id="password_new"
              label="New password"
              type="password"
              error={errors.password?.message ?? serverError?.fieldError('password')}
              register={register('password')}
              autoComplete="new-password"
            />
            <Field
              id="password_confirm"
              label="Confirm new password"
              type="password"
              error={errors.password_confirmation?.message}
              register={register('password_confirmation')}
              autoComplete="new-password"
            />
          </div>

          <div className="flex justify-end">
            <Button type="submit" loading={changePassword.isPending}>
              {changePassword.isPending ? 'Updating…' : 'Update password'}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

/**
 * One labelled input with its message wired to it.
 *
 * Extracted because this page has fourteen of them and the thing that is easy to get wrong is not
 * the markup — it is remembering `aria-describedby` on the input *and* the matching `id` on the
 * message, every single time. See `FieldError` for why the pair matters.
 */
function Field({
  id,
  label,
  hint,
  error,
  register,
  type = 'text',
  autoComplete,
  inputProps,
}: {
  id: string;
  label: string;
  hint?: string;
  error?: string | null | undefined;
  register: UseFormRegisterReturn;
  type?: string;
  autoComplete?: string;
  /** Anything else the input needs — the autofill opt-outs, in practice. */
  inputProps?: Record<string, string | number | boolean>;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        type={type}
        autoComplete={autoComplete}
        aria-invalid={Boolean(error)}
        aria-describedby={describedBy(error ? `${id}-error` : false, hint ? `${id}-hint` : false)}
        {...inputProps}
        {...register}
      />
      {hint ? (
        <p id={`${id}-hint`} className="text-xs text-muted-foreground">
          {hint}
        </p>
      ) : null}
      {error ? <FieldError id={`${id}-error`}>{error}</FieldError> : null}
    </div>
  );
}
