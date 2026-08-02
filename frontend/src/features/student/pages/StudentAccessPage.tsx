import { useForm } from 'react-hook-form';
import { Navigate } from 'react-router-dom';

import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { describedBy, FieldError } from '@/components/ui/field-error';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useJoinClass } from '@/features/student/hooks/useStudentAccess';
import { homePathForRole } from '@/routes/paths';
import type { JoinClassPayload } from '@/services/studentAccessApi';
import { useAuthStore } from '@/stores/authStore';
import { ApiRequestError } from '@/types/api';

/**
 * Student class access (FULLPLAN §38, §57).
 *
 * There is no password field on this page, and there is no "forgot password" link, because
 * a student account has no password to forget — `users.password IS NULL` for every student
 * row, permanently. A class code and a per-class username are the whole of what a student
 * needs, and the whole of what this screen may ask for.
 *
 * The validation here is deliberately thin. The server answers *every* failed join with
 * one identical 401 — wrong code, expired code, archived class, unknown username, removed
 * student, deactivated account — precisely so the endpoint cannot be used to work out which
 * codes exist or who is on a roster. Client-side rules that reject a code before it is sent
 * would answer that same question for free, so they are not written.
 *
 * **And that thinness is why this screen uses react-hook-form's own rules rather than a Zod
 * resolver (P4-16).** Two required checks and two length caps is the entire ruleset, and Zod
 * cost 61 KiB to express it — on the one screen in the app a student reaches before they have
 * signed in to anything, often on a phone on school wifi. Zod is untouched everywhere it earns
 * its place; a schema library is worth its weight for the assessment builder's nested question
 * payloads and worth nothing here.
 *
 * The caps are the only rules that are not "is it empty", and they exist to bound what gets put
 * on the wire, not to help the user — a real class code is 9 characters and a real username is
 * far under 50, so nobody reaching them has typed something that could have succeeded.
 */

const RULES = {
  class_code: {
    required: 'Enter your class code.',
    maxLength: { value: 20, message: 'That class code is too long.' },
  },
  username: {
    required: 'Enter your username.',
    maxLength: { value: 50, message: 'That username is too long.' },
  },
} as const;

type AccessFormValues = JoinClassPayload;

export function StudentAccessPage() {
  const user = useAuthStore((state) => state.user);
  const join = useJoinClass();

  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<AccessFormValues>({
    defaultValues: { class_code: '', username: '' },
  });

  if (user) {
    return <Navigate to={homePathForRole(user.role)} replace />;
  }

  const serverError = join.error instanceof ApiRequestError ? join.error : null;

  // The generic 401 carries no field errors; the 429 (too many failed attempts) reports on
  // class_code. Everything else that is not field-specific shows as one alert.
  const generalError =
    serverError && Object.keys(serverError.errors).length === 0 ? serverError.message : null;

  const onSubmit = handleSubmit((values) => {
    join.mutate(values);
  });

  const codeServerError = serverError?.fieldError('class_code');

  return (
    <Card className="w-full max-w-md">
      <CardHeader>
        {/* The page's `h1` — see the note in CredentialsLoginForm. */}
        <CardTitle as="h1">Join your class</CardTitle>
        <CardDescription>
          Use the class code from your counselor and the username they gave you.
        </CardDescription>
      </CardHeader>

      <CardContent>
        <form onSubmit={onSubmit} className="flex flex-col gap-4" noValidate>
          {generalError ? <Alert>{generalError}</Alert> : null}

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="class_code">Class code</Label>
            <Input
              id="class_code"
              autoFocus
              autoComplete="off"
              spellCheck={false}
              placeholder="ABCD-2345"
              className="font-mono tracking-widest uppercase"
              aria-invalid={Boolean(errors.class_code ?? codeServerError)}
              aria-describedby={describedBy(
                errors.class_code && 'class-code-error',
                codeServerError && 'class-code-server-error',
              )}
              {...register('class_code', RULES.class_code)}
            />
            {errors.class_code ? (
              <FieldError id="class-code-error">{errors.class_code.message}</FieldError>
            ) : null}
            {codeServerError ? (
              <FieldError id="class-code-server-error">{codeServerError}</FieldError>
            ) : null}
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="username">Username</Label>
            <Input
              id="username"
              autoComplete="off"
              spellCheck={false}
              placeholder="juan.delacruz"
              className="font-mono"
              aria-invalid={Boolean(errors.username)}
              aria-describedby={describedBy(errors.username && 'username-error')}
              {...register('username', RULES.username)}
            />
            {errors.username ? (
              <FieldError id="username-error">{errors.username.message}</FieldError>
            ) : null}
          </div>

          <Button type="submit" loading={join.isPending} className="mt-2">
            {join.isPending ? 'Signing in…' : 'Sign in'}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
