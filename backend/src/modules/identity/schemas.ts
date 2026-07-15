import { z } from 'zod';

/**
 * Zod schemas — validation rules only (FULLPLAN §17). Business rules live in the Service.
 * `z.infer<typeof schema>` *is* the type passed to the Service; there are no DTOs (§17).
 */

/**
 * The staff password policy (§38): minimum 10 characters, at least one uppercase, one
 * lowercase, one number. The frontend's ChangePasswordPage mirrors these rules — but this
 * is the control and that is the convenience, so the messages here are the ones a user
 * ultimately gets held to.
 */
const staffPassword = z
  .string()
  .min(10, 'Use at least 10 characters.')
  .regex(/[A-Z]/, 'Include at least one uppercase letter.')
  .regex(/[a-z]/, 'Include at least one lowercase letter.')
  .regex(/[0-9]/, 'Include at least one number.');

export const loginSchema = z.object({
  email: z.email('Enter a valid email address.'),
  // Deliberately *not* validated against the password policy: an old password that predates
  // a policy change must still be able to log in (and be told to change it), and echoing
  // policy hints at an unauthenticated endpoint is free reconnaissance.
  password: z.string().min(1, 'Your password is required.'),
});

export const changePasswordSchema = z
  .object({
    current_password: z.string().min(1, 'Your current password is required.'),
    password: staffPassword,
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

export const forgotPasswordSchema = z.object({
  email: z.email('Enter a valid email address.'),
});

export const resetPasswordSchema = z
  .object({
    email: z.email('Enter a valid email address.'),
    token: z.string().min(1, 'The reset token is required.'),
    password: staffPassword,
    password_confirmation: z.string(),
  })
  .refine((values) => values.password === values.password_confirmation, {
    message: 'The passwords do not match.',
    path: ['password_confirmation'],
  });

/**
 * Passwordless student access (§38).
 *
 * Note what is *not* here: any format rule on either field. A `regex` on `class_code` would
 * answer — in a 422, and before the attempt is even charged against the rate limit — exactly
 * the question this endpoint is built not to answer. Both fields are matched trimmed and
 * case-insensitively in the Service; a malformed code is simply a code that matches nothing,
 * and gets the same 401 as a wrong one.
 *
 * There is no `password` field, and there never will be. One appearing here is a bug.
 */
export const joinClassSchema = z.object({
  class_code: z.string().trim().min(1, 'A class code is required.').max(20),
  username: z.string().trim().min(1, 'A username is required.').max(50),
});

export type LoginInput = z.infer<typeof loginSchema>;
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;
export type ForgotPasswordInput = z.infer<typeof forgotPasswordSchema>;
export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>;
export type JoinClassInput = z.infer<typeof joinClassSchema>;
