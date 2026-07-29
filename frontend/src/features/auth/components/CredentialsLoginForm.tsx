import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { Link, Navigate } from 'react-router-dom';
import { z } from 'zod';

import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { describedBy, FieldError } from '@/components/ui/field-error';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useLogin, type LoginOptions } from '@/features/auth/hooks/useAuth';
import { homePathForRole, paths } from '@/routes/paths';
import { useAuthStore } from '@/stores/authStore';
import { ApiRequestError } from '@/types/api';

/**
 * The email + password card shared by the two staff login screens (§38).
 *
 * The screens differ only in copy and in which role they let through — the form, the
 * error surfacing and the redirect-when-already-signed-in are identical, so they live
 * here once. Students never see this form: their flow has no password at all.
 */

const loginSchema = z.object({
  email: z.email('Enter a valid email address.'),
  password: z.string().min(1, 'Password is required.'),
});

type LoginFormValues = z.infer<typeof loginSchema>;

export interface CredentialsLoginFormProps extends LoginOptions {
  title: string;
  description: string;
  /** The reset flow is counselor-facing; the admin screen hides the link. */
  showForgotPassword?: boolean;
}

export function CredentialsLoginForm({
  title,
  description,
  allow,
  refusalMessage,
  showForgotPassword = true,
}: CredentialsLoginFormProps) {
  const user = useAuthStore((state) => state.user);
  const login = useLogin({ allow, refusalMessage });

  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<LoginFormValues>({
    resolver: zodResolver(loginSchema),
    defaultValues: { email: '', password: '' },
  });

  if (user) {
    return <Navigate to={homePathForRole(user.role)} replace />;
  }

  const serverError = login.error instanceof ApiRequestError ? login.error : null;

  // Field-level messages are rendered inline; anything else (bad credentials, locked
  // account, inactive account, wrong-role refusal) surfaces as a single alert.
  const generalError =
    serverError && Object.keys(serverError.errors).length === 0 ? serverError.message : null;

  const onSubmit = handleSubmit((values) => {
    login.mutate(values);
  });

  const emailServerError = serverError?.fieldError('email');

  return (
    <Card className="w-full max-w-md">
      <CardHeader>
        {/*
          `h1`, not the component's default `h2`. This card is the entire page — the only other
          heading on the screen is the marketing line on the artwork panel, which is hidden below
          `lg` and is not what this page is *about*. A sign-in screen whose document outline starts
          at level two has no title at all as far as a screen reader's heading list is concerned.
        */}
        <CardTitle as="h1">{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>

      <CardContent>
        <form onSubmit={onSubmit} className="flex flex-col gap-4" noValidate>
          {generalError ? <Alert>{generalError}</Alert> : null}

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="email">Email</Label>
            <Input
              id="email"
              type="email"
              autoComplete="email"
              autoFocus
              aria-invalid={Boolean(errors.email ?? emailServerError)}
              aria-describedby={describedBy(
                errors.email && 'email-error',
                emailServerError && 'email-server-error',
              )}
              {...register('email')}
            />
            {errors.email ? <FieldError id="email-error">{errors.email.message}</FieldError> : null}
            {emailServerError ? (
              <FieldError id="email-server-error">{emailServerError}</FieldError>
            ) : null}
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="password">Password</Label>
            <Input
              id="password"
              type="password"
              autoComplete="current-password"
              aria-invalid={Boolean(errors.password)}
              aria-describedby={describedBy(errors.password && 'password-error')}
              {...register('password')}
            />
            {errors.password ? (
              <FieldError id="password-error">{errors.password.message}</FieldError>
            ) : null}
          </div>

          <Button type="submit" loading={login.isPending} className="mt-2">
            {login.isPending ? 'Signing in…' : 'Sign in'}
          </Button>

          {showForgotPassword ? (
            <Link
              to={paths.forgotPassword}
              className="text-center text-sm text-muted-foreground hover:underline"
            >
              Forgot your password?
            </Link>
          ) : null}
        </form>
      </CardContent>
    </Card>
  );
}
