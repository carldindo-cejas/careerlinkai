import { Check, Copy, RefreshCw, Share2 } from 'lucide-react';
import { useState } from 'react';

import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useRegenerateCode } from '@/features/counselor/hooks/useClasses';
import { joinLinkPath } from '@/routes/paths';
import { ApiRequestError } from '@/types/api';
import type { ClassRoom } from '@/types/class';

/**
 * The class code (FULLPLAN §38, §57).
 *
 * This code is the *entire* secret behind passwordless student access — there is no
 * password to fall back on. Three consequences are visible in this component:
 *
 *   - it is displayed in a monospace face with wide tracking, because students copy it by
 *     hand off a projector, and the alphabet already excludes I/O/0/1 for the same reason;
 *   - the join link carries the code in its path, so sharing the link *is* sharing the code —
 *     it goes to the class the same way the code would, and a regenerated code kills old links
 *     along with it;
 *   - regenerating is presented as the revocation it actually is, not as a refresh.
 */
export interface JoinCodeCardProps {
  classRoom: ClassRoom;
}

export function JoinCodeCard({ classRoom }: JoinCodeCardProps) {
  const [copied, setCopied] = useState<'code' | 'link' | null>(null);
  const [isConfirmingRegenerate, setIsConfirmingRegenerate] = useState(false);

  const regenerate = useRegenerateCode(classRoom.id);

  const isActive = classRoom.status === 'active';
  const isExpired =
    classRoom.join_code_expires_at !== null && new Date(classRoom.join_code_expires_at) < new Date();

  // The page's own origin, so production shares careerlinkai.online and a dev server shares itself.
  const joinLink = `${window.location.origin}${joinLinkPath(classRoom.join_code)}`;

  const flash = (what: 'code' | 'link') => {
    setCopied(what);
    window.setTimeout(() => setCopied(null), 2000);
  };

  const copy = async () => {
    await navigator.clipboard.writeText(classRoom.join_code);
    flash('code');
  };

  /**
   * The device's share sheet where there is one — on a phone that is Messenger or SMS, which is
   * how a class link actually travels — and a copied link everywhere else. Dismissing the sheet is
   * the counselor changing their mind, not an error, so it falls through to nothing.
   */
  const share = async () => {
    if ('share' in navigator) {
      try {
        await navigator.share({
          title: `Join ${classRoom.name}`,
          text: `Join ${classRoom.name} on CareerLinkAI — open the link and enter your username.`,
          url: joinLink,
        });
        return;
      } catch (cause) {
        if (cause instanceof DOMException && cause.name === 'AbortError') return;
        // Refused for any other reason (no share target, blocked by policy) — copy instead.
      }
    }

    await navigator.clipboard.writeText(joinLink);
    flash('link');
  };

  const error = regenerate.error instanceof ApiRequestError ? regenerate.error : null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Class code</CardTitle>
        <CardDescription>
          Students sign in with this code and their username. They never get a password. Share
          the join link and the code is filled in for them — they only type their username.
        </CardDescription>
      </CardHeader>

      <CardContent className="flex flex-col gap-4">
        {error ? <Alert>{error.message}</Alert> : null}

        <div className="flex flex-wrap items-center gap-3">
          <p className="font-mono text-3xl font-semibold tracking-[0.2em] text-foreground">
            {classRoom.join_code}
          </p>

          <Button variant="secondary" size="sm" onClick={() => void copy()}>
            {copied === 'code' ? (
              <Check className="size-4" aria-hidden="true" />
            ) : (
              <Copy className="size-4" aria-hidden="true" />
            )}
            {copied === 'code' ? 'Copied' : 'Copy'}
          </Button>

          <Button variant="secondary" size="sm" onClick={() => void share()}>
            {copied === 'link' ? (
              <Check className="size-4" aria-hidden="true" />
            ) : (
              <Share2 className="size-4" aria-hidden="true" />
            )}
            {copied === 'link' ? 'Link copied' : 'Share'}
          </Button>
        </div>

        <p className="break-all text-sm text-muted-foreground">
          Join link:{' '}
          <span className="font-mono text-foreground">
            {joinLink.replace(/^https?:\/\//, '')}
          </span>
        </p>

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
          <p className="text-sm text-muted-foreground">
            Expires {new Date(classRoom.join_code_expires_at).toLocaleDateString()}.
          </p>
        ) : null}

        {isConfirmingRegenerate ? (
          <div className="flex flex-col gap-3">
            {/* The consequence names itself before the button that carries it out — copy verbatim. */}
            <Alert tone="warning">
              <span className="font-medium">This immediately stops the old code working.</span> Any
              student who has not signed in yet will need the new one — and anyone already signed in
              stays signed in.
            </Alert>

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
