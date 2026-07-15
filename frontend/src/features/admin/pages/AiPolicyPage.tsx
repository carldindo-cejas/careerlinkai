import { useState } from 'react';

import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { useAiPolicies, useUpdateAiPolicy } from '@/features/admin/hooks/useAiKnowledge';
import type { AiPolicy } from '@/types/ai';

/**
 * The AI policy editor (FULLPLAN §13.7, §32, §37).
 *
 * Two plain-text fields, injected verbatim into every AI prompt — the deliberately minimal
 * middle ground between "everything hardcoded" and a prompt CMS. There is no create and no
 * delete: the single GLOBAL row is seeded, and this screen only edits it (v1.2).
 */
export function AiPolicyPage() {
  const { data: policies, isLoading, isError, error } = useAiPolicies();

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold text-slate-900">AI policy</h1>
        <p className="text-sm text-slate-500">
          These instructions and restrictions are appended to every prompt the AI receives — they
          govern what it may say when explaining recommendations to students.
        </p>
      </div>

      {isLoading ? <p className="text-sm text-slate-500">Loading the policy…</p> : null}
      {isError ? <Alert>We could not load the AI policy. {error.message}</Alert> : null}

      {policies && policies.length === 0 ? (
        <Alert>
          No policy row exists. Run the ai-policy seeder (`npm run db:seed:ai-policy`) — the row
          is created there, deliberately never over HTTP.
        </Alert>
      ) : null}

      {policies?.map((policy) => <PolicyEditor key={policy.id} policy={policy} />)}
    </div>
  );
}

function PolicyEditor({ policy }: { policy: AiPolicy }) {
  const update = useUpdateAiPolicy(policy.id);
  const [instructions, setInstructions] = useState(policy.instructions ?? '');
  const [restrictions, setRestrictions] = useState(policy.restrictions ?? '');
  const [saved, setSaved] = useState(false);

  function save(isActive?: boolean) {
    setSaved(false);
    update.mutate(
      {
        instructions: instructions.trim() === '' ? null : instructions.trim(),
        restrictions: restrictions.trim() === '' ? null : restrictions.trim(),
        ...(isActive === undefined ? {} : { is_active: isActive }),
      },
      { onSuccess: () => setSaved(true) },
    );
  }

  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-4">
        <div>
          <CardTitle className="flex items-center gap-2">
            Global policy
            <Badge tone={policy.is_active ? 'success' : undefined}>
              {policy.is_active ? 'Active' : 'Inactive'}
            </Badge>
          </CardTitle>
          <CardDescription>
            Last updated {new Date(policy.updated_at).toLocaleString()}. An inactive policy is not
            injected — the AI falls back to its base rules only.
          </CardDescription>
        </div>

        <Button
          variant="secondary"
          disabled={update.isPending}
          onClick={() => save(!policy.is_active)}
        >
          {policy.is_active ? 'Deactivate' : 'Activate'}
        </Button>
      </CardHeader>

      <CardContent className="flex flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`instructions-${policy.id}`}>Instructions</Label>
          <Textarea
            id={`instructions-${policy.id}`}
            rows={4}
            value={instructions}
            onChange={(event) => setInstructions(event.target.value)}
            placeholder="e.g. Always mention that recommendations are not final decisions."
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`restrictions-${policy.id}`}>Restrictions</Label>
          <Textarea
            id={`restrictions-${policy.id}`}
            rows={4}
            value={restrictions}
            onChange={(event) => setRestrictions(event.target.value)}
            placeholder="e.g. Never mention or compare specific tuition fees."
          />
        </div>

        {update.isError ? <Alert>{update.error.message}</Alert> : null}
        {saved && !update.isPending ? (
          <p className="text-sm text-emerald-600">Saved. Every new AI request uses this text.</p>
        ) : null}

        <div>
          <Button disabled={update.isPending} onClick={() => save()}>
            {update.isPending ? 'Saving…' : 'Save policy'}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
