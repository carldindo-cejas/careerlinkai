import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { Navigate } from 'react-router-dom';
import { z } from 'zod';

import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useLogin } from '@/features/auth/hooks/useAuth';
import { homePathForRole } from '@/routes/paths';
import { useAuthStore } from '@/stores/authStore';
import { ApiRequestError } from '@/types/api';

/**
 * Staff login — admin and counselor only (FULLPLAN §37).
 *
 * There is no student entry point here: students access the system through the
 * separate class-code screen, which has no password field at all (§38).
 */

const loginSchema = z.object({
  email: z.email('Enter a valid email address.'),
  password: z.string().min(1, 'Password is required.'),
});

type LoginFormValues = z.infer<typeof loginSchema>;

export function LoginPage() {
  const user = useAuthStore((state) => state.user);
  const login = useLogin();

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
  // account, inactive account) surfaces as a single alert.
  const generalError =
    serverError && Object.keys(serverError.errors).length === 0 ? serverError.message : null;

  const onSubmit = handleSubmit((values) => {
    login.mutate(values);
  });

  return (
    <Card className="w-full max-w-md">
      <CardHeader>
        <CardTitle>Sign in to CareerLinkAI</CardTitle>
        <CardDescription>For counselors and administrators.</CardDescription>
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
              <p className="text-sm text-red-600">{errors.email.message}</p>
            ) : null}
            {serverError?.fieldError('email') ? (
              <p className="text-sm text-red-600">{serverError.fieldError('email')}</p>
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
              <p className="text-sm text-red-600">{errors.password.message}</p>
            ) : null}
          </div>

          <Button type="submit" loading={login.isPending} className="mt-2">
            {login.isPending ? 'Signing in…' : 'Sign in'}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
