import { zodResolver } from '@hookform/resolvers/zod';
import { AtSign, KeyRound, ShieldCheck, UserRound } from 'lucide-react';
import { useForm, type UseFormRegisterReturn } from 'react-hook-form';
import { z } from 'zod';

import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { describedBy, FieldError } from '@/components/ui/field-error';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { useChangePassword } from '@/features/auth/hooks/useAuth';
import { useChangeEmail, useUpdateAccount } from '@/features/counselor/hooks/useAccount';
import { useAuthStore } from '@/stores/authStore';
import { toast } from '@/stores/toastStore';
import { ApiRequestError } from '@/types/api';
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
 *     is otherwise one form submission away from becoming somebody else's account. It does not
 *     sign you out: nothing you hold became less trustworthy.
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
  current_password: z.string().min(1, 'Your current password is required.'),
});

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
          <EmailCard currentEmail={user.email} />
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
 * The address this account signs in with.
 *
 * The warning is the point of the card, not decoration: there is no email channel that can undo a
 * typo here (§5, D7), so a counselor who moves their account to an address they cannot open has
 * locked themselves out of the reset flow as well as the login. Saying it above the field is the
 * only place it can still change what somebody types.
 */
function EmailCard({ currentEmail }: { currentEmail: string | null }) {
  const changeEmail = useChangeEmail();

  const {
    register,
    handleSubmit,
    formState: { errors },
    reset,
  } = useForm<z.infer<typeof emailSchema>>({
    resolver: zodResolver(emailSchema),
    defaultValues: { email: '', current_password: '' },
  });

  const serverError = changeEmail.error instanceof ApiRequestError ? changeEmail.error : null;

  const onSubmit = handleSubmit((values) => {
    changeEmail.mutate(values, {
      onSuccess: (next) => {
        toast.success(`You will sign in as ${next.email} from now on.`);
        reset({ email: '', current_password: '' });
      },
    });
  });

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <AtSign className="size-4 text-muted-foreground" aria-hidden="true" />
          <CardTitle>Sign-in email</CardTitle>
        </div>
        <CardDescription>
          You currently sign in as{' '}
          <span className="font-medium text-foreground">{currentEmail ?? 'no address'}</span>.
        </CardDescription>
      </CardHeader>

      <CardContent>
        <form onSubmit={onSubmit} className="flex flex-col gap-4" noValidate>
          <p className="border-l-2 border-primary/40 pl-3 text-sm text-muted-foreground">
            This is the address you sign in with and the one a password reset is sent to. Use one
            you can actually open — nobody can undo a typo here for you.
          </p>

          {serverError && Object.keys(serverError.errors).length === 0 ? (
            <Alert>{serverError.message}</Alert>
          ) : null}

          <Field
            id="new_email"
            label="New email address"
            type="email"
            error={errors.email?.message ?? serverError?.fieldError('email')}
            register={register('email')}
            autoComplete="email"
          />

          <Field
            id="email_current_password"
            label="Your current password"
            type="password"
            hint="Asked for because this changes how you sign in."
            error={
              errors.current_password?.message ?? serverError?.fieldError('current_password')
            }
            register={register('current_password')}
            autoComplete="current-password"
          />

          <div className="flex justify-end">
            <Button type="submit" loading={changeEmail.isPending}>
              {changeEmail.isPending ? 'Updating…' : 'Update email'}
            </Button>
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
}: {
  id: string;
  label: string;
  hint?: string;
  error?: string | null | undefined;
  register: UseFormRegisterReturn;
  type?: string;
  autoComplete?: string;
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
