import { CredentialsLoginForm } from '@/features/auth/components/CredentialsLoginForm';

/**
 * Administrator login (FULLPLAN §37, §38) — deliberately unlinked.
 *
 * Nothing in the app navigates here: no link on the landing page, the counselor login,
 * or any menu. An administrator reaches this screen by typing /admin-login. That is a
 * visibility measure, not a security boundary — authorization is still the server's
 * Policies and the role checks on every admin endpoint.
 *
 * Counselor credentials are refused here the same way admin credentials are refused at
 * /login: the token is revoked and the attempt surfaces as an ordinary login failure.
 */
export function AdminLoginPage() {
  return (
    <CredentialsLoginForm
      title="Administrator Login"
      description="For platform administrators."
      allow={['admin']}
      refusalMessage="This login is for administrators only."
    />
  );
}
