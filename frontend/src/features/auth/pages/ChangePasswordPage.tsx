import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { z } from 'zod';

import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useChangePassword } from '@/features/auth/hooks/useAuth';
import { useAuthStore } from '@/stores/authStore';
import { ApiRequestError } from '@/types/api';

/**
 * Forced password change (FULLPLAN §38).
 *
 * Staff issued a temporary password land here before anything else loads, driven by
 * `must_change_password` on the user. The policy mirrors the server exactly: minimum
 * 10 characters, at least one uppercase, one lowercase, and one number. The server
 * enforces it regardless — this is a convenience, not the control.
 */

const changePasswordSchema = z
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

type ChangePasswordFormValues = z.infer<typeof changePasswordSchema>;

export function ChangePasswordPage() {
  const user = useAuthStore((state) => state.user);
  const changePassword = useChangePassword();

  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<ChangePasswordFormValues>({
    resolver: zodResolver(changePasswordSchema),
    defaultValues: { current_password: '', password: '', password_confirmation: '' },
  });

  const serverError = changePassword.error instanceof ApiRequestError ? changePassword.error : null;

  const onSubmit = handleSubmit((values) => {
    changePassword.mutate(values);
  });

  return (
    <Card className="w-full max-w-md">
      <CardHeader>
        <CardTitle>Choose a new password</CardTitle>
        <CardDescription>
          {user?.must_change_password
            ? 'Your account uses a temporary password. Set a new one to continue.'
            : 'You will be signed out and asked to sign in again.'}
        </CardDescription>
      </CardHeader>

      <CardContent>
        <form onSubmit={onSubmit} className="flex flex-col gap-4" noValidate>
          {serverError && Object.keys(serverError.errors).length === 0 ? (
            <Alert>{serverError.message}</Alert>
          ) : null}

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="current_password">Current password</Label>
            <Input
              id="current_password"
              type="password"
              autoComplete="current-password"
              aria-invalid={Boolean(errors.current_password)}
              {...register('current_password')}
            />
            {errors.current_password ? (
              <p className="text-sm text-red-600">{errors.current_password.message}</p>
            ) : null}
            {serverError?.fieldError('current_password') ? (
              <p className="text-sm text-red-600">{serverError.fieldError('current_password')}</p>
            ) : null}
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="password">New password</Label>
            <Input
              id="password"
              type="password"
              autoComplete="new-password"
              aria-invalid={Boolean(errors.password)}
              {...register('password')}
            />
            {errors.password ? (
              <p className="text-sm text-red-600">{errors.password.message}</p>
            ) : null}
            {serverError?.fieldError('password') ? (
              <p className="text-sm text-red-600">{serverError.fieldError('password')}</p>
            ) : null}
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="password_confirmation">Confirm new password</Label>
            <Input
              id="password_confirmation"
              type="password"
              autoComplete="new-password"
              aria-invalid={Boolean(errors.password_confirmation)}
              {...register('password_confirmation')}
            />
            {errors.password_confirmation ? (
              <p className="text-sm text-red-600">{errors.password_confirmation.message}</p>
            ) : null}
          </div>

          <Button type="submit" loading={changePassword.isPending} className="mt-2">
            {changePassword.isPending ? 'Saving…' : 'Update password'}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
