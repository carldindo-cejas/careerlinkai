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
 * Counselor self-signup, step 1 (migration 0034).
 *
 * The same field vocabulary as `createCounselorSchema` below, with two differences that follow
 * from who is filling it in:
 *
 *   * **There is a password**, chosen by the person who will use it. The admin-created path
 *     deliberately has none — a password two people know is a credential with no accountability —
 *     but that reasoning inverts here: this form has exactly one party, and a generated temporary
 *     password would mean emailing a credential *and* a code to prove the mailbox is theirs, which
 *     is one secret more than the flow needs.
 *   * **`.strict()` matters more.** On the admin endpoint it stops a careless client; here it is
 *     the boundary between a public form and the account table. A body carrying `role`, `status`
 *     or `email_verified_at` is refused rather than ignored, so those fields can never be anything
 *     but what the service sets.
 */
export const counselorSignupSchema = z
  .object({
    email: z.email('Enter a valid email address.'),
    password: staffPassword,
    password_confirmation: z.string(),
    first_name: z.string().trim().min(1, 'A first name is required.').max(100),
    last_name: z.string().trim().min(1, 'A last name is required.').max(100),
    phone: z.string().trim().max(30).nullable().optional(),
    employee_number: z.string().trim().max(50).nullable().optional(),
    specialization: z.string().trim().max(150).nullable().optional(),
    bio: z.string().trim().max(1000).nullable().optional(),
  })
  .strict()
  .refine((values) => values.password === values.password_confirmation, {
    message: 'The passwords do not match.',
    path: ['password_confirmation'],
  });

/**
 * Counselor self-signup, step 2.
 *
 * Six digits, and the regex is the whole format rule. Unlike `joinClassSchema` — where a format
 * check would answer, in a free 422, the question the endpoint exists not to answer — there is
 * nothing to leak here: the caller already knows they are verifying a six-digit code, because one
 * was just mailed to them. Rejecting `"12345"` before it reaches the hash is a kindness, not a
 * disclosure.
 */
export const verifySignupCodeSchema = z
  .object({
    email: z.email('Enter a valid email address.'),
    code: z
      .string()
      .trim()
      .regex(/^[0-9]{6}$/, 'Enter the six-digit code from your email.'),
  })
  .strict();

export const resendSignupCodeSchema = z
  .object({ email: z.email('Enter a valid email address.') })
  .strict();

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
 *
 * `confirm` is the two-step gate added after the September 2026 incident. Without it the endpoint
 * **resolves** the credentials and answers with the student's name and nothing else; with it, and
 * only with it, a token is issued and any other device holding this account is signed out. It is
 * optional in the schema and mandatory in effect: a client that never sends it can never take a
 * session over, which is exactly the property wanted from a field whose whole job is to make the
 * takeover a thing somebody chose rather than a thing that happened.
 */
export const joinClassSchema = z.object({
  class_code: z.string().trim().min(1, 'A class code is required.').max(20),
  username: z.string().trim().min(1, 'A username is required.').max(50),
  confirm: z.boolean().optional(),
});

/**
 * Counselor management (§20, Phase 6).
 *
 * No password field on create, deliberately: the service *generates* the temporary password
 * and returns it once. An admin-chosen password would be a credential two people know with
 * no record of which of them used it. `.strict()` so a client sending `role` or `password`
 * is told no rather than silently ignored — both would be requests to make this endpoint
 * something it must not be.
 */
export const createCounselorSchema = z
  .object({
    email: z.email('Enter a valid email address.'),
    first_name: z.string().trim().min(1, 'A first name is required.').max(100),
    last_name: z.string().trim().min(1, 'A last name is required.').max(100),
    name: z.string().trim().min(1).max(150).optional(),
    phone: z.string().trim().max(30).nullable().optional(),
    employee_number: z.string().trim().max(50).nullable().optional(),
    specialization: z.string().trim().max(150).nullable().optional(),
    bio: z.string().trim().max(1000).nullable().optional(),
  })
  .strict();

/**
 * `status` is editable here — suspend/reactivate is the §4 admin act — but `role`, `email`
 * and `password` are not requests this endpoint can mean: a role change is a different
 * account, an email change breaks the §38 per-email lockout identity, and passwords rotate
 * only through the reset flow the counselor themselves completes.
 */
export const updateCounselorSchema = z
  .object({
    name: z.string().trim().min(1).max(150).optional(),
    status: z.enum(['active', 'inactive', 'suspended']).optional(),
    first_name: z.string().trim().min(1).max(100).optional(),
    last_name: z.string().trim().min(1).max(100).optional(),
    phone: z.string().trim().max(30).nullable().optional(),
    employee_number: z.string().trim().max(50).nullable().optional(),
    specialization: z.string().trim().max(150).nullable().optional(),
    bio: z.string().trim().max(1000).nullable().optional(),
  })
  .strict();

export const listCounselorsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  per_page: z.coerce.number().int().min(1).max(100).default(20),
  search: z.string().trim().max(100).optional(),
  status: z.enum(['pending', 'active', 'inactive', 'suspended']).optional(),
});

export type LoginInput = z.infer<typeof loginSchema>;
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;
export type ForgotPasswordInput = z.infer<typeof forgotPasswordSchema>;
export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>;
export type JoinClassInput = z.infer<typeof joinClassSchema>;
export type CounselorSignupInput = z.infer<typeof counselorSignupSchema>;
export type VerifySignupCodeInput = z.infer<typeof verifySignupCodeSchema>;
export type ResendSignupCodeInput = z.infer<typeof resendSignupCodeSchema>;
export type CreateCounselorInput = z.infer<typeof createCounselorSchema>;
export type UpdateCounselorInput = z.infer<typeof updateCounselorSchema>;

/**
 * A staff member editing **their own** account (prompt-driven, 2026-09-20 — `/counselor/profile`).
 *
 * Deliberately narrower than `updateCounselorSchema`: `status` is missing, because suspending
 * yourself is not a thing anybody means to do, and neither `email` nor `password` appears here —
 * both are credentials and each has its own endpoint that re-proves the current password first.
 *
 * `name` is accepted for the administrator case (an admin reaches this shell too and has no
 * counselor profile, so first/last name have nowhere to live). For a counselor it is *derived*
 * from `first_name`/`last_name` by the service rather than typed, so the display name and the
 * profile can never drift apart.
 */
export const updateAccountSchema = z
  .object({
    name: z.string().trim().min(1, 'A name is required.').max(150).optional(),
    first_name: z.string().trim().min(1, 'A first name is required.').max(100).optional(),
    last_name: z.string().trim().min(1, 'A last name is required.').max(100).optional(),
    phone: z.string().trim().max(30).nullable().optional(),
    employee_number: z.string().trim().max(50).nullable().optional(),
    specialization: z.string().trim().max(150).nullable().optional(),
    bio: z.string().trim().max(1000).nullable().optional(),
  })
  .strict();

/**
 * Changing the address you sign in with.
 *
 * `current_password` is not ceremony. The email is the login identifier *and* the address a
 * password reset is delivered to, so an unattended session left open on a shared staffroom
 * machine is one form submission away from being someone else's account — re-proving the password
 * is what makes that a thing only the account holder can do.
 *
 * This body **stages** the change; it does not make it (migration 0039). A six-digit code goes to
 * the address named here and `users.email` moves only when `verifyEmailChangeSchema` brings it
 * back — the password says who is asking, the code says the destination is real.
 */
export const changeEmailSchema = z
  .object({
    email: z.email('Enter a valid email address.'),
    current_password: z.string().min(1, 'Your current password is required.'),
  })
  .strict();

/**
 * Step two of the same change: the six-digit code that came back from the new mailbox
 * (migration 0039).
 *
 * The address is **not** in this body, and that is deliberate. It is read from the staged row,
 * which is keyed by the authenticated user — so the code can only ever complete the change that
 * account asked for, and a caller cannot pair a code that reached one mailbox with a different
 * destination.
 *
 * Length rather than a regex on the digits: `\d{6}` and this differ only in the message, and
 * "that code is invalid" is what the service says for a wrong code anyway.
 */
export const verifyEmailChangeSchema = z
  .object({
    code: z
      .string()
      .trim()
      .regex(/^\d{6}$/, 'Enter the six-digit code from your email.'),
  })
  .strict();

export type UpdateAccountInput = z.infer<typeof updateAccountSchema>;
export type ChangeEmailInput = z.infer<typeof changeEmailSchema>;
export type VerifyEmailChangeInput = z.infer<typeof verifyEmailChangeSchema>;
