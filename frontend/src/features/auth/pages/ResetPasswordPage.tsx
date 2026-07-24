import { zodResolver } from '@hookform/resolvers/zod';
import { useState } from 'react';
import { useForm, type UseFormRegisterReturn } from 'react-hook-form';
import { Link, useSearchParams } from 'react-router-dom';
import { z } from 'zod';

import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { httpClient } from '@/services/httpClient';
import { paths } from '@/routes/paths';
import { ApiRequestError } from '@/types/api';

/**
 * Complete a password reset (deviation D7 — Phase 6).
 *
 * The token is single-use with a 60-minute TTL, and a successful reset revokes every
 * session the account had (§38). The email + token arrive as query params when the local
 * flow linked here, or are typed in when an administrator handed them over out of band.
 */

const resetSchema = z
  .object({
    email: z.email('Enter a valid email address.'),
    token: z.string().min(1, 'The reset code is required.'),
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

type ResetFormValues = z.infer<typeof resetSchema>;

export function ResetPasswordPage() {
  const [params] = useSearchParams();
  const [done, setDone] = useState(false);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<ApiRequestError | null>(null);

  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<ResetFormValues>({
    resolver: zodResolver(resetSchema),
    defaultValues: {
      email: params.get('email') ?? '',
      token: params.get('token') ?? '',
      password: '',
      password_confirmation: '',
    },
  });

  const onSubmit = handleSubmit(async (values) => {
    setPending(true);
    setFailure(null);

    try {
      await httpClient.post('/auth/reset-password', values);
      setDone(true);
    } catch (cause) {
      setFailure(
        cause instanceof ApiRequestError
          ? cause
          : new ApiRequestError('The reset failed.', 0, {}),
      );
    } finally {
      setPending(false);
    }
  });

  if (done) {
    return (
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>Password reset</CardTitle>
          <CardDescription>
            Your password has been changed and every previous session signed out.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Link to={paths.login} className="text-sm font-medium text-foreground hover:underline">
            Sign in with your new password
          </Link>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="w-full max-w-md">
      <CardHeader>
        <CardTitle>Choose a new password</CardTitle>
        <CardDescription>
          Enter the reset code you were given. It works once and expires after an hour.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={onSubmit} className="flex flex-col gap-4" noValidate>
          {failure && Object.keys(failure.errors).length === 0 ? (
            <Alert>{failure.message}</Alert>
          ) : null}

          <Field
            id="email"
            label="Email"
            type="email"
            autoComplete="email"
            error={errors.email?.message ?? failure?.fieldError('email')}
            registration={register('email')}
          />
          <Field
            id="token"
            label="Reset code"
            error={errors.token?.message ?? failure?.fieldError('token')}
            registration={register('token')}
          />
          <Field
            id="password"
            label="New password"
            type="password"
            autoComplete="new-password"
            error={errors.password?.message ?? failure?.fieldError('password')}
            registration={register('password')}
          />
          <Field
            id="password_confirmation"
            label="Confirm new password"
            type="password"
            autoComplete="new-password"
            error={
              errors.password_confirmation?.message ??
              failure?.fieldError('password_confirmation')
            }
            registration={register('password_confirmation')}
          />

          <Button type="submit" loading={pending} className="mt-2">
            Reset password
          </Button>

          <Link className="text-center text-sm text-muted-foreground hover:underline" to={paths.login}>
            Back to sign in
          </Link>
        </form>
      </CardContent>
    </Card>
  );
}

function Field({
  id,
  label,
  error,
  registration,
  type = 'text',
  autoComplete,
}: {
  id: string;
  label: string;
  error?: string | undefined;
  registration: UseFormRegisterReturn;
  type?: string;
  autoComplete?: string;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        type={type}
        aria-invalid={Boolean(error)}
        {...(autoComplete ? { autoComplete } : {})}
        {...registration}
      />
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
    </div>
  );
}
