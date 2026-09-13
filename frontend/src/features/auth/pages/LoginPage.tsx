import { CredentialsLoginForm } from '@/features/auth/components/CredentialsLoginForm';

/**
 * Counselor login — counselors only (FULLPLAN §37).
 *
 * There is no student entry point here: students access the system through the separate
 * class-code screen, which has no password field at all (§38). Administrators do not
 * sign in here either — they have their own unlinked screen (see paths.adminLogin), and
 * valid admin credentials are refused at this door with their token revoked.
 */
export function LoginPage() {
  return (
    <CredentialsLoginForm
      title="Counselor Login"
      description="For counselors."
      allow={['counselor']}
      refusalMessage="This login is for counselors only."
      // Migration 0034: the only door that offers self-registration, and only while an
      // administrator has it open. /admin-login deliberately does not — an admin account is not
      // something anybody signs themselves up for.
      showSignupLink
    />
  );
}
