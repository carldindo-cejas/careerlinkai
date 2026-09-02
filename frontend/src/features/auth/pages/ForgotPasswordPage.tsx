import { zodResolver } from '@hookform/resolvers/zod';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { Link } from 'react-router-dom';
import { z } from 'zod';

import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { httpClient, unwrap } from '@/services/httpClient';
import { paths, resetPasswordPath } from '@/routes/paths';
import type { ApiSuccess } from '@/types/api';

/**
 * Forgot password (deviation D7 — closed on the delivery side by plan P4-2).
 *
 * The server acknowledges every request identically, whether or not the address is registered
 * (§38's anti-enumeration guarantee); in local development it also returns the reset token, so the
 * flow is exercisable end to end, and this page surfaces that.
 *
 * **This screen cannot tell you whether the email arrived, and that is deliberate on two counts.**
 * The response is identical for a registered and an unregistered address by design — and even for a
 * real account, delivery is genuinely not guaranteed: the project runs on the Cloudflare Free plan
 * (FULLPLAN §45, ratified), which delivers only to *verified destination addresses*, so a staff
 * mailbox that has not been through that one-time step gets nothing. The admin-relay reset (C2)
 * remains the fallback.
 *
 * So the copy below is written to be **true in every one of those states at once**. It must not say
 * "check your email" (a lie when delivery was refused) and must not say "contact your
 * administrator" as the only route (wrong once the address is verified). Both are offered, neither
 * is promised, and nothing here reveals which case the reader is in.
 */

const forgotSchema = z.object({
  email: z.email('Enter a valid email address.'),
});

type ForgotFormValues = z.infer<typeof forgotSchema>;

export function ForgotPasswordPage() {
  const [submitted, setSubmitted] = useState<{ email: string; token: string | null } | null>(null);
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<ForgotFormValues>({
    resolver: zodResolver(forgotSchema),
    defaultValues: { email: '' },
  });

  const onSubmit = handleSubmit(async (values) => {
    setPending(true);
    setProblem(null);

    try {
      const data = await unwrap(
        httpClient.post<ApiSuccess<{ reset_token: string } | null>>('/auth/forgot-password', values),
      );

      setSubmitted({ email: values.email, token: data?.reset_token ?? null });
    } catch (cause) {
      setProblem(cause instanceof Error ? cause.message : 'The request failed.');
    } finally {
      setPending(false);
    }
  });

  if (submitted) {
    return (
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>Reset requested</CardTitle>
          <CardDescription>
            If <span className="font-medium">{submitted.email}</span> is a registered staff
            account, a reset link has been sent to it.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {submitted.token ? (
            <Alert tone="info">
              Local development: your reset token is{' '}
              <code className="break-all font-mono text-xs">{submitted.token}</code>.{' '}
              <Link
                className="font-medium underline"
                to={resetPasswordPath(submitted.email, submitted.token)}
              >
                Continue to reset
              </Link>
            </Alert>
          ) : (
            <p className="text-sm text-muted-foreground">
              Not every staff address can receive mail from CareerLinkAI yet. If nothing arrives
              within a few minutes, ask an administrator to complete the reset — they can give you
              a reset code to use with the link below.
            </p>
          )}

          <div className="flex items-center gap-4 text-sm">
            <Link className="font-medium text-foreground hover:underline" to={paths.resetPassword}>
              I have a reset code
            </Link>
            <Link className="text-muted-foreground hover:underline" to={paths.login}>
              Back to sign in
            </Link>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="w-full max-w-md">
      <CardHeader>
        <CardTitle>Forgot your password?</CardTitle>
        <CardDescription>
          Staff accounts only. Students sign in with a class code and never have a password.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={onSubmit} className="flex flex-col gap-4" noValidate>
          {problem ? <Alert>{problem}</Alert> : null}

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="email">Email</Label>
            <Input
              id="email"
              type="email"
              autoComplete="email"
              autoFocus
              aria-invalid={Boolean(errors.email)}
              {...register('email')}
            />
            {errors.email ? <p className="text-sm text-destructive">{errors.email.message}</p> : null}
          </div>

          <Button type="submit" loading={pending} className="mt-2">
            Request a reset
          </Button>

          <Link className="text-center text-sm text-muted-foreground hover:underline" to={paths.login}>
            Back to sign in
          </Link>
        </form>
      </CardContent>
    </Card>
  );
}
