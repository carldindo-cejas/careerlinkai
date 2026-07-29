/**
 * Route group: the staff doors (P3-3).
 *
 * Counselor sign-in, the unlinked administrator sign-in, the no-email reset pair, and the
 * forced password change — every screen that hands a password to `StaffAuthLayout`. The
 * student's door is **not** here: `/join` takes no password (§38) and is its own group, so a
 * student never downloads a login form they cannot use.
 *
 * Nothing may import this file statically — see `groups/public.ts`.
 */
export { StaffAuthLayout } from '@/layouts/StaffAuthLayout';
export { LoginPage } from '@/features/auth/pages/LoginPage';
export { AdminLoginPage } from '@/features/auth/pages/AdminLoginPage';
export { ForgotPasswordPage } from '@/features/auth/pages/ForgotPasswordPage';
export { ResetPasswordPage } from '@/features/auth/pages/ResetPasswordPage';
export { ChangePasswordPage } from '@/features/auth/pages/ChangePasswordPage';
