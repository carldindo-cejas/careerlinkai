import { Check, Copy, RefreshCw } from 'lucide-react';
import { useState } from 'react';

import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useRegenerateCode } from '@/features/counselor/hooks/useClasses';
import { ApiRequestError } from '@/types/api';
import type { ClassRoom } from '@/types/class';

/**
 * The class code (FULLPLAN §38, §57).
 *
 * This code is the *entire* secret behind passwordless student access — there is no
 * password to fall back on. Two consequences are visible in this component:
 *
 *   - it is displayed in a monospace face with wide tracking, because students copy it by
 *     hand off a projector, and the alphabet already excludes I/O/0/1 for the same reason;
 *   - regenerating is presented as the revocation it actually is, not as a refresh.
 */
export interface JoinCodeCardProps {
  classRoom: ClassRoom;
}

export function JoinCodeCard({ classRoom }: JoinCodeCardProps) {
  const [copied, setCopied] = useState(false);
  const [isConfirmingRegenerate, setIsConfirmingRegenerate] = useState(false);

  const regenerate = useRegenerateCode(classRoom.id);

  const isActive = classRoom.status === 'active';
  const isExpired =
    classRoom.join_code_expires_at !== null && new Date(classRoom.join_code_expires_at) < new Date();

  const copy = async () => {
    await navigator.clipboard.writeText(classRoom.join_code);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 2000);
  };

  const error = regenerate.error instanceof ApiRequestError ? regenerate.error : null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Class code</CardTitle>
        <CardDescription>
          Students sign in with this code and their username. They never get a password.
        </CardDescription>
      </CardHeader>

      <CardContent className="flex flex-col gap-4">
        {error ? <Alert>{error.message}</Alert> : null}

        <div className="flex flex-wrap items-center gap-3">
          <p className="font-mono text-3xl font-semibold tracking-[0.2em] text-slate-900">
            {classRoom.join_code}
          </p>

          <Button variant="secondary" size="sm" onClick={() => void copy()}>
            {copied ? (
              <Check className="size-4" aria-hidden="true" />
            ) : (
              <Copy className="size-4" aria-hidden="true" />
            )}
            {copied ? 'Copied' : 'Copy'}
          </Button>
        </div>

        {/* A code on a class that refuses joins is a trap: it looks usable and is not. */}
        {!isActive ? (
          <Alert>
            This class is {classRoom.status}, so the code will not let anyone in. Set the class
            back to active to reopen it.
          </Alert>
        ) : null}

        {isExpired ? (
          <Alert>This code expired. Generate a new one to let students back in.</Alert>
        ) : null}

        {classRoom.join_code_expires_at && !isExpired ? (
          <p className="text-sm text-slate-500">
            Expires {new Date(classRoom.join_code_expires_at).toLocaleDateString()}.
          </p>
        ) : null}

        {isConfirmingRegenerate ? (
          <div className="flex flex-col gap-3 rounded-md border border-amber-200 bg-amber-50 p-3">
            <p className="text-sm text-amber-900">
              <span className="font-medium">This immediately stops the old code working.</span>{' '}
              Any student who has not signed in yet will need the new one — and anyone already
              signed in stays signed in.
            </p>

            <div className="flex gap-2">
              <Button
                size="sm"
                loading={regenerate.isPending}
                onClick={() =>
                  regenerate.mutate(undefined, {
                    onSuccess: () => setIsConfirmingRegenerate(false),
                  })
                }
              >
                Generate a new code
              </Button>
              <Button
                size="sm"
                variant="secondary"
                onClick={() => setIsConfirmingRegenerate(false)}
              >
                Keep the current code
              </Button>
            </div>
          </div>
        ) : (
          <div>
            <Button
              variant="ghost"
              size="sm"
              className="px-0"
              onClick={() => setIsConfirmingRegenerate(true)}
            >
              <RefreshCw className="size-4" aria-hidden="true" />
              Generate a new code
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
