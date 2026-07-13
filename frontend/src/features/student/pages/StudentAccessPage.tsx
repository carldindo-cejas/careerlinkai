import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { Navigate } from 'react-router-dom';
import { z } from 'zod';

import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useJoinClass } from '@/features/student/hooks/useStudentAccess';
import { homePathForRole } from '@/routes/paths';
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
 */

const accessSchema = z.object({
  class_code: z.string().min(1, 'Enter your class code.').max(20),
  username: z.string().min(1, 'Enter your username.').max(50),
});

type AccessFormValues = z.infer<typeof accessSchema>;

export function StudentAccessPage() {
  const user = useAuthStore((state) => state.user);
  const join = useJoinClass();

  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<AccessFormValues>({
    resolver: zodResolver(accessSchema),
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

  return (
    <Card className="w-full max-w-md">
      <CardHeader>
        <CardTitle>Join your class</CardTitle>
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
              aria-invalid={Boolean(errors.class_code ?? serverError?.fieldError('class_code'))}
              {...register('class_code')}
            />
            {errors.class_code ? (
              <p className="text-sm text-red-600">{errors.class_code.message}</p>
            ) : null}
            {serverError?.fieldError('class_code') ? (
              <p className="text-sm text-red-600">{serverError.fieldError('class_code')}</p>
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
              {...register('username')}
            />
            {errors.username ? (
              <p className="text-sm text-red-600">{errors.username.message}</p>
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
