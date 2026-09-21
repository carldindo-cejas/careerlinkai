import { zodResolver } from '@hookform/resolvers/zod';
import { useState } from 'react';
import { useForm, type UseFormRegisterReturn } from 'react-hook-form';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import { z } from 'zod';

import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { describedBy, FieldError } from '@/components/ui/field-error';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  useCounselorSignup,
  useResendSignupCode,
  useSignupStatus,
  useVerifySignupCode,
} from '@/features/auth/hooks/useAuth';
import { homePathForRole, paths } from '@/routes/paths';
import { useAuthStore } from '@/stores/authStore';
import { toast } from '@/stores/toastStore';
import { ApiRequestError } from '@/types/api';

/**
 * Counselor self-registration (migration 0034) — the only screen in this app where somebody who is
 * not already signed in creates an account.
 *
 * ## Two steps, one route
 *
 * Details first, then the code that proves the mailbox is theirs. Both live at `/signup` in
 * component state rather than on two paths, because the second step is meaningless without the
 * first: a `/signup/verify` URL would be reachable, bookmarkable and — on a refresh — empty, with
 * nothing to tell the reader why.
 *
 * ## What this screen is careful not to say
 *
 * After step 1 it says the same thing whether or not the address is already registered. That is
 * the server's design (§38's anti-enumeration rule) and the client must not undo it by, say,
 * skipping the code step when no code was issued. Somebody whose address is already registered is
 * mailed "you already have an account" instead of a code, so the silence here has a way out — it
 * is just not one this page can narrate without becoming the oracle the API refuses to be.
 *
 * ## What happens when registration is closed
 *
 * The server 403s every submission; this renders the closure as plain copy instead of a form,
 * because a form that cannot be submitted is worse than an explanation. The status is asked for
 * again rather than trusted from the sign-in screen that linked here — it can be turned off in the
 * seconds between.
 */

/**
 * The client-side rules, mirroring `counselorSignupSchema` on the server.
 *
 * The server is the control and this is the convenience — it exists so somebody does not spend a
 * round trip discovering their passwords do not match. Where the two disagree the server wins, and
 * its message is what gets rendered.
 */
const signupSchema = z
  .object({
    first_name: z.string().trim().min(1, 'Your first name is required.').max(100),
    last_name: z.string().trim().min(1, 'Your last name is required.').max(100),
    email: z.email('Enter a valid email address.'),
    specialization: z.string().trim().max(150).optional(),
    employee_number: z.string().trim().max(50).optional(),
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
  });

type SignupFormValues = z.infer<typeof signupSchema>;

export function CounselorSignupPage() {
  const user = useAuthStore((state) => state.user);
  const status = useSignupStatus();
  /** Set once step 1 is acknowledged. Its presence *is* which step is on screen. */
  const [pending, setPending] = useState<{ email: string; localCode: string | null } | null>(null);

  // Somebody already signed in has no business on a registration form — the same redirect the two
  // login screens do, for the same reason. It is not a permission check (the API would happily
  // register a second account from a signed-in browser); it is that landing here is always a
  // navigation mistake, and bouncing them to their own dashboard is the useful answer.
  if (user) {
    return <Navigate to={homePathForRole(user.role)} replace />;
  }

  if (status.isLoading) {
    return (
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle as="h1">Create a counselor account</CardTitle>
          <CardDescription>Loading…</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  // Closed, or the status could not be read. Both get the same copy: the server refuses a
  // submission either way, so promising a form we cannot deliver would only waste somebody's time.
  if (status.data?.counselor_signup_open !== true) {
    return (
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle as="h1">Sign-up is closed</CardTitle>
          <CardDescription>
            New counselor accounts are not being created at the moment. An administrator can make
            one for you and give you a temporary password.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Link className="text-sm font-medium text-foreground hover:underline" to={paths.login}>
            Back to sign in
          </Link>
        </CardContent>
      </Card>
    );
  }

  if (pending) {
    return (
      <VerifyCodeCard
        email={pending.email}
        localCode={pending.localCode}
        onStartOver={() => setPending(null)}
      />
    );
  }

  return <SignupDetailsCard onSubmitted={setPending} />;
}

function SignupDetailsCard({
  onSubmitted,
}: {
  onSubmitted: (pending: { email: string; localCode: string | null }) => void;
}) {
  const signup = useCounselorSignup();

  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<SignupFormValues>({
    resolver: zodResolver(signupSchema),
    defaultValues: {
      first_name: '',
      last_name: '',
      email: '',
      specialization: '',
      employee_number: '',
      password: '',
      password_confirmation: '',
    },
  });

  const serverError = signup.error instanceof ApiRequestError ? signup.error : null;
  const generalError =
    serverError && Object.keys(serverError.errors).length === 0 ? serverError.message : null;

  const onSubmit = handleSubmit(async (values) => {
    const acknowledgement = await signup
      .mutateAsync({
        email: values.email,
        password: values.password,
        password_confirmation: values.password_confirmation,
        first_name: values.first_name,
        last_name: values.last_name,
        // Empty optional fields are dropped rather than sent as `''` — the server's `.strict()`
        // schema accepts them, but a blank specialization is an absent one, not a named one.
        ...(values.specialization ? { specialization: values.specialization } : {}),
        ...(values.employee_number ? { employee_number: values.employee_number } : {}),
      })
      .catch(() => undefined);

    // `undefined` means the request failed and the error is already rendered below; `null` is a
    // *successful* acknowledgement that simply carried no code, which is the normal case outside
    // local development — and, deliberately, also what a already-registered address produces.
    if (acknowledgement === undefined) {
      return;
    }

    onSubmitted({ email: values.email, localCode: acknowledgement?.verification_code ?? null });
  });

  return (
    <Card className="w-full max-w-md">
      <CardHeader>
        <CardTitle as="h1">Create a counselor account</CardTitle>
        <CardDescription>
          For school counselors. Students join with a class code and never have a password.
        </CardDescription>
      </CardHeader>

      <CardContent>
        <form onSubmit={onSubmit} className="flex flex-col gap-4" noValidate>
          {generalError ? <Alert>{generalError}</Alert> : null}

          <div className="flex gap-3">
            <TextField
              id="first_name"
              label="First name"
              autoComplete="given-name"
              autoFocus
              error={errors.first_name?.message ?? serverError?.fieldError('first_name')}
              registration={register('first_name')}
            />
            <TextField
              id="last_name"
              label="Last name"
              autoComplete="family-name"
              error={errors.last_name?.message ?? serverError?.fieldError('last_name')}
              registration={register('last_name')}
            />
          </div>

          <TextField
            id="email"
            label="Email"
            type="email"
            autoComplete="email"
            error={errors.email?.message ?? serverError?.fieldError('email')}
            registration={register('email')}
          />

          <TextField
            id="specialization"
            label="Specialization"
            hint="Optional — for example, Career Guidance."
            error={errors.specialization?.message ?? serverError?.fieldError('specialization')}
            registration={register('specialization')}
          />

          <TextField
            id="employee_number"
            label="Employee number"
            hint="Optional."
            error={errors.employee_number?.message ?? serverError?.fieldError('employee_number')}
            registration={register('employee_number')}
          />

          <TextField
            id="password"
            label="Password"
            type="password"
            autoComplete="new-password"
            hint="At least 10 characters, with an uppercase letter, a lowercase letter and a number."
            error={errors.password?.message ?? serverError?.fieldError('password')}
            registration={register('password')}
          />

          <TextField
            id="password_confirmation"
            label="Confirm password"
            type="password"
            autoComplete="new-password"
            error={
              errors.password_confirmation?.message ??
              serverError?.fieldError('password_confirmation')
            }
            registration={register('password_confirmation')}
          />

          <Button type="submit" loading={signup.isPending} className="mt-2">
            {signup.isPending ? 'Sending your code…' : 'Send verification code'}
          </Button>

          <Link
            className="text-center text-sm text-muted-foreground hover:underline"
            to={paths.login}
          >
            Already have an account? Sign in
          </Link>
        </form>
      </CardContent>
    </Card>
  );
}

function VerifyCodeCard({
  email,
  localCode,
  onStartOver,
}: {
  email: string;
  /** Only ever set in local development, where the API echoes the code back. */
  localCode: string | null;
  onStartOver: () => void;
}) {
  const navigate = useNavigate();
  const verify = useVerifySignupCode();
  const resend = useResendSignupCode();
  const [code, setCode] = useState(localCode ?? '');
  const [resentCode, setResentCode] = useState<string | null>(null);

  const serverError = verify.error instanceof ApiRequestError ? verify.error : null;
  const codeError = serverError?.fieldError('code');
  const emailError = serverError?.fieldError('email');
  const generalError =
    serverError && Object.keys(serverError.errors).length === 0 ? serverError.message : null;

  async function onVerify(event: React.FormEvent) {
    event.preventDefault();

    try {
      await verify.mutateAsync({ email, code });

      // Straight to the sign-in screen with the news, rather than signing them in here: no token
      // is issued by the verify endpoint, and routing every session through /auth/login keeps
      // issuance on one path.
      toast.success('Your account is ready. Sign in with the password you chose.');
      navigate(paths.login);
    } catch {
      // Rendered below from `verify.error`.
    }
  }

  async function onResend() {
    try {
      const acknowledgement = await resend.mutateAsync(email);

      setResentCode(acknowledgement?.verification_code ?? null);
      toast.success('If a sign-up is waiting for that address, a new code is on its way.');
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : 'The code could not be sent. Try again shortly.',
      );
    }
  }

  return (
    <Card className="w-full max-w-md">
      <CardHeader>
        <CardTitle as="h1">Check your email</CardTitle>
        <CardDescription>
          {/*
            "If that address can be registered" rather than "we sent you a code" — the second would
            be a lie whenever the address already has an account, which is a case this screen is
            deliberately unable to distinguish. See the file header.
          */}
          If <span className="font-medium">{email}</span> can be registered, a six-digit code is on
          its way to it. The code expires in 15 minutes.
        </CardDescription>
      </CardHeader>

      <CardContent className="flex flex-col gap-4">
        {(resentCode ?? localCode) ? (
          <Alert tone="info">
            Local development: your code is{' '}
            <code className="font-mono text-sm">{resentCode ?? localCode}</code>
          </Alert>
        ) : null}

        <form onSubmit={onVerify} className="flex flex-col gap-4" noValidate>
          {generalError ? <Alert>{generalError}</Alert> : null}
          {emailError ? <Alert>{emailError}</Alert> : null}

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="code">Verification code</Label>
            <Input
              id="code"
              // `inputMode` rather than `type="number"`: a numeric keypad on a phone without the
              // spinner, the scroll-to-change behaviour, or the leading-zero loss.
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              autoFocus
              value={code}
              onChange={(event) => setCode(event.target.value.replace(/\D/g, ''))}
              aria-invalid={Boolean(codeError)}
              aria-describedby={describedBy(codeError && 'code-error')}
              className="font-mono text-lg tracking-[0.4em]"
            />
            {codeError ? <FieldError id="code-error">{codeError}</FieldError> : null}
          </div>

          <Button type="submit" loading={verify.isPending} disabled={code.length !== 6}>
            {verify.isPending ? 'Verifying…' : 'Verify and finish'}
          </Button>
        </form>

        <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
          <button
            type="button"
            className="font-medium text-foreground hover:underline disabled:opacity-60"
            disabled={resend.isPending}
            onClick={() => void onResend()}
          >
            {resend.isPending ? 'Sending…' : 'Send a new code'}
          </button>
          <button
            type="button"
            className="text-muted-foreground hover:underline"
            onClick={onStartOver}
          >
            Use a different email
          </button>
        </div>
      </CardContent>
    </Card>
  );
}

/** Label + input + one error line — the same arrangement seven times, so it lives here once. */
function TextField({
  id,
  label,
  hint,
  type = 'text',
  autoComplete,
  autoFocus = false,
  error,
  registration,
}: {
  id: string;
  label: string;
  // `| undefined` throughout: `exactOptionalPropertyTypes` is on, so a caller passing
  // `error={maybeUndefined}` is a type error unless the property admits it explicitly.
  hint?: string | undefined;
  type?: string | undefined;
  autoComplete?: string | undefined;
  autoFocus?: boolean | undefined;
  error?: string | undefined;
  registration: UseFormRegisterReturn<keyof SignupFormValues>;
}) {
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        type={type}
        autoComplete={autoComplete}
        autoFocus={autoFocus}
        aria-invalid={Boolean(error)}
        aria-describedby={describedBy(error && `${id}-error`, hint && `${id}-hint`)}
        {...registration}
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
