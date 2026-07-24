import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { Link, Navigate } from 'react-router-dom';
import { z } from 'zod';

import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
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

  return (
    <Card className="w-full max-w-md">
      <CardHeader>
        <CardTitle>{title}</CardTitle>
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
              aria-invalid={Boolean(errors.email)}
              {...register('email')}
            />
            {errors.email ? (
              <p className="text-sm text-destructive">{errors.email.message}</p>
            ) : null}
            {serverError?.fieldError('email') ? (
              <p className="text-sm text-destructive">{serverError.fieldError('email')}</p>
            ) : null}
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="password">Password</Label>
            <Input
              id="password"
              type="password"
              autoComplete="current-password"
              aria-invalid={Boolean(errors.password)}
              {...register('password')}
            />
            {errors.password ? (
              <p className="text-sm text-destructive">{errors.password.message}</p>
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
