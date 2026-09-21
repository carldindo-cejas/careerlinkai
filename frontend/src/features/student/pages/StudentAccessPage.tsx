import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { Navigate, useParams } from 'react-router-dom';

import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { cn } from '@/components/ui/cn';
import { describedBy, FieldError } from '@/components/ui/field-error';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useConfirmIdentity, useJoinClass } from '@/features/student/hooks/useStudentAccess';
import { homePathForRole } from '@/routes/paths';
import type { JoinClassPayload, JoinConfirmation } from '@/services/studentAccessApi';
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
 *
 * **And that thinness is why this screen uses react-hook-form's own rules rather than a Zod
 * resolver (P4-16).** Two required checks and two length caps is the entire ruleset, and Zod
 * cost 61 KiB to express it — on the one screen in the app a student reaches before they have
 * signed in to anything, often on a phone on school wifi. Zod is untouched everywhere it earns
 * its place; a schema library is worth its weight for the assessment builder's nested question
 * payloads and worth nothing here.
 *
 * The caps are the only rules that are not "is it empty", and they exist to bound what gets put
 * on the wire, not to help the user — a real class code is 9 characters and a real username is
 * far under 50, so nobody reaching them has typed something that could have succeeded.
 *
 * **Signing in takes two steps, and the second one is a question** (incident 2026-09-18). The
 * first call resolves the class code and username and comes back with the *name* they belong to;
 * nothing is issued until the student says that name is theirs. The reason is in the production
 * trail for that afternoon: 61 of 79 joins in one hour ended a session somebody else was using,
 * because a student's credential is a code the whole class can read off the whiteboard plus a
 * roster number a neighbour can guess, and typing `1.11` instead of `1.1` silently handed them
 * somebody else's assessment while throwing its owner out. A student recognises their own name;
 * that is the whole of the check, and it is a check against a mistake rather than against a
 * person who means it — the real fix is a credential the rest of the class does not know.
 *
 * **Reached from a shared link** (`/join/ABCD-2345`, the counselor's Share button), the code
 * arrives already filled in and focus starts on the username — the one thing the student still
 * has to type. The field stays editable: a link pasted with a stray character should be
 * correctable, not a dead end. The code goes to the server exactly as the URL spelled it; the
 * server normalizes it the same way it normalizes a typed one.
 */

const RULES = {
  class_code: {
    required: 'Enter your class code.',
    maxLength: { value: 20, message: 'That class code is too long.' },
  },
  username: {
    required: 'Enter your username.',
    maxLength: { value: 50, message: 'That username is too long.' },
  },
} as const;

type AccessFormValues = JoinClassPayload;

export function StudentAccessPage() {
  const user = useAuthStore((state) => state.user);
  const sessionEnded = useAuthStore((state) => state.sessionEnded);
  const confirmIdentity = useConfirmIdentity();
  const join = useJoinClass();

  /**
   * The resolved-but-not-yet-claimed identity, held between the two calls.
   *
   * Component state rather than the mutation's own `data`, because the "no, that isn't me" button
   * has to put the student back on the form without losing what they typed, and a mutation result
   * that survived that would render the confirmation again on the next keystroke.
   */
  const [pending, setPending] = useState<JoinConfirmation | null>(null);

  const { classCode = '' } = useParams<{ classCode: string }>();
  const sharedCode = classCode.trim();
  const hasSharedCode = sharedCode.length > 0;

  const {
    register,
    handleSubmit,
    getValues,
    formState: { errors },
  } = useForm<AccessFormValues>({
    defaultValues: { class_code: sharedCode, username: '' },
  });

  if (user) {
    return <Navigate to={homePathForRole(user.role)} replace />;
  }

  // Either call can fail, and they fail identically — the server answers every rejection with the
  // same 401 whichever step asked (§38).
  const failure = confirmIdentity.error ?? join.error;
  const serverError = failure instanceof ApiRequestError ? failure : null;

  // The generic 401 carries no field errors; the 429 (too many failed attempts) reports on
  // class_code. Everything else that is not field-specific shows as one alert.
  const generalError =
    serverError && Object.keys(serverError.errors).length === 0 ? serverError.message : null;

  const onSubmit = handleSubmit((values) => {
    confirmIdentity.mutate(values, { onSuccess: setPending });
  });

  const codeServerError = serverError?.fieldError('class_code');

  /**
   * Step two: the student has read the name and said it is theirs.
   *
   * The credentials are re-sent from the form rather than from `pending`, so what is claimed is
   * what was typed — `pending` carries the server's normalized username, and round-tripping that
   * back would mean confirming something subtly different from what was shown.
   */
  if (pending) {
    return (
      /*
        **Every element here is sized so the two buttons clear the fold on a 320x568 phone.**

        The first version of this screen did not, and it failed in the worst available way: the
        card rendered, the name rendered, and the only things below the viewport edge were the
        controls. A student saw a question with no way to answer it, and the page scrolled without
        anything on screen suggesting it could. That is why the copy below is as short as it is,
        why the identity block is one line per fact, and why the buttons sit in a row rather than
        stacked — a stacked pair costs 60px of height that this viewport does not have.
      */
      <Card
        data-testid="identity-confirmation"
        className={cn(
          'w-full max-w-md',
          // Red, and the whole frame rather than the alert alone (prompt-driven, 2026-09-20).
          // The thing this card is asking about stopped being routine the moment a session is
          // already running: saying yes ends somebody else's assessment. A warning-toned line
          // inside an otherwise ordinary card is read as decoration; the card itself changing
          // colour is the only signal a student reliably notices before they tap.
          // `[&>span>span]` is the four corner registration marks, which `Corners` hard-codes
          // to `text-primary` — a red frame with steel corners reads as a rendering fault.
          pending.active_session && 'border-destructive [&>span>span]:text-destructive',
        )}
      >
        <CardHeader className="p-4 pb-3 sm:p-6 sm:pb-4">
          <CardTitle as="h1" className={pending.active_session ? 'text-destructive' : undefined}>
            Is this you?
          </CardTitle>
          <CardDescription>
            Check this is your name before you continue.
          </CardDescription>
        </CardHeader>

        <CardContent className="flex flex-col gap-3 p-4 pt-0 sm:gap-4 sm:p-6 sm:pt-0">
          {generalError ? <Alert>{generalError}</Alert> : null}

          {/*
            One line per fact, and each clamped. A class name is free text a counselor typed and
            can be sixty characters long; left to wrap it pushed the buttons off the screen on the
            exact devices this step matters most on.
          */}
          <div className="flex flex-col gap-0.5 border border-border bg-muted p-3">
            <span className="text-xs text-muted-foreground">Signing in as</span>
            <strong className="line-clamp-2 text-lg leading-tight">{pending.student_name}</strong>
            <span className="line-clamp-1 text-sm text-muted-foreground">
              {pending.username} · {pending.class.name}
            </span>
          </div>

          {/*
            The warning the old flow never gave. A join has always ended every other session on
            the account; until now it did that silently, to whoever happened to be using it.
          */}
          {pending.active_session ? (
            <Alert tone="danger">
              Already signed in on another device. Continuing signs that device out.
            </Alert>
          ) : null}

          {/*
            `flex-row-reverse`, so the primary action sits on the right where a thumb expects it
            while still coming first in the DOM — keyboard and screen-reader order follow the
            markup, which puts "yes" before "no" as the reading order of the question demands.
          */}
          <div className="flex flex-row-reverse gap-3">
            {/*
              Both labels answer the heading rather than describing the navigation, and both are
              short enough to sit on one line inside a half-width button at 320px — "Yes, this is
              me" wrapped to two lines there and turned a 44px touch target into a cramped one.
            */}
            <Button
              className="flex-1"
              onClick={() => join.mutate(getValues())}
              loading={join.isPending}
            >
              {join.isPending ? 'Signing in…' : "Yes, it's me"}
            </Button>
            <Button
              className="flex-1"
              variant="secondary"
              onClick={() => {
                setPending(null);
                join.reset();
                confirmIdentity.reset();
              }}
            >
              Not me
            </Button>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="w-full max-w-md">
      <CardHeader>
        {/* The page's `h1` — see the note in CredentialsLoginForm. */}
        <CardTitle as="h1">Join your class</CardTitle>
        <CardDescription>
          {hasSharedCode
            ? 'Your class code is already filled in. Enter the username your counselor gave you.'
            : 'Use the class code from your counselor and the username they gave you.'}
        </CardDescription>
      </CardHeader>

      <CardContent>
        <form onSubmit={onSubmit} className="flex flex-col gap-4" noValidate>
          {/*
            Why they are looking at this screen, when they did not ask to be. A rejected token is
            the only thing that sets this, and after the confirmation step above the likeliest
            cause is the honest one: somebody else signed in with this username.
          */}
          {sessionEnded && !generalError ? (
            <Alert tone="info">
              You were signed out. This happens if your username was used to sign in on another
              device, or if you were signed in for more than 12 hours. Your answers were saved.
            </Alert>
          ) : null}

          {generalError ? <Alert>{generalError}</Alert> : null}

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="class_code">Class code</Label>
            <Input
              id="class_code"
              autoFocus={!hasSharedCode}
              autoComplete="off"
              spellCheck={false}
              placeholder="ABCD-2345"
              className="font-mono tracking-widest uppercase"
              aria-invalid={Boolean(errors.class_code ?? codeServerError)}
              aria-describedby={describedBy(
                errors.class_code && 'class-code-error',
                codeServerError && 'class-code-server-error',
              )}
              {...register('class_code', RULES.class_code)}
            />
            {errors.class_code ? (
              <FieldError id="class-code-error">{errors.class_code.message}</FieldError>
            ) : null}
            {codeServerError ? (
              <FieldError id="class-code-server-error">{codeServerError}</FieldError>
            ) : null}
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="username">Username</Label>
            <Input
              id="username"
              autoFocus={hasSharedCode}
              autoComplete="off"
              spellCheck={false}
              placeholder="juan.delacruz"
              className="font-mono"
              aria-invalid={Boolean(errors.username)}
              aria-describedby={describedBy(errors.username && 'username-error')}
              {...register('username', RULES.username)}
            />
            {errors.username ? (
              <FieldError id="username-error">{errors.username.message}</FieldError>
            ) : null}
          </div>

          <Button type="submit" loading={confirmIdentity.isPending} className="mt-2">
            {confirmIdentity.isPending ? 'Checking…' : 'Continue'}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
