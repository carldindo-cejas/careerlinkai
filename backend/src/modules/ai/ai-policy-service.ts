import { asc, eq } from 'drizzle-orm';

import type { Database } from '@/db/client';
import { aiPolicies, type AiPolicy, type User } from '@/db/schema';
import { now } from '@/lib/datetime';
import { ApiError } from '@/lib/envelope';
import { AuditService } from '@/modules/platform/audit-service';

/**
 * `AiPolicyService` — the admin-editable governance text (FULLPLAN §13.7, §32).
 *
 * Deliberately minimal: the single GLOBAL row is created by the seeder
 * (`seeds/0003_ai_policy.sql`), and there is **no create and no delete endpoint** (v1.2) —
 * an admin edits the text and toggles `is_active`, nothing else. Only active rows are
 * injected into prompts; an inactive or absent row injects empty strings, which degrades
 * to the plan's own base prompt rather than failing generation.
 */

const MODULE = 'AiKnowledge';

export interface UpdateAiPolicyInput {
  instructions?: string | null;
  restrictions?: string | null;
  is_active?: boolean;
}

export class AiPolicyService {
  private readonly audit: AuditService;

  constructor(private readonly db: Database) {
    this.audit = new AuditService(db);
  }

  /** Every policy row — v1 has one, and the list shape keeps §63's finer scopes cheap. */
  async list(): Promise<AiPolicy[]> {
    return this.db.select().from(aiPolicies).orderBy(asc(aiPolicies.createdAt));
  }

  /**
   * The active GLOBAL policy, or `null`. Callers inject `instructions`/`restrictions` into
   * prompts (§32); `null` means "inject nothing", never "refuse to generate".
   */
  async activeGlobal(): Promise<AiPolicy | null> {
    const [policy] = await this.db
      .select()
      .from(aiPolicies)
      .where(eq(aiPolicies.isActive, true))
      .orderBy(asc(aiPolicies.createdAt))
      .limit(1);

    return policy ?? null;
  }

  async update(admin: User, policyId: string, input: UpdateAiPolicyInput): Promise<AiPolicy> {
    const [existing] = await this.db
      .select()
      .from(aiPolicies)
      .where(eq(aiPolicies.id, policyId))
      .limit(1);

    if (existing === undefined) {
      throw ApiError.notFound('AI policy not found.');
    }

    const updated = {
      instructions: input.instructions !== undefined ? input.instructions : existing.instructions,
      restrictions: input.restrictions !== undefined ? input.restrictions : existing.restrictions,
      isActive: input.is_active ?? existing.isActive,
      updatedBy: admin.id,
      updatedAt: now(),
    };

    await this.db.update(aiPolicies).set(updated).where(eq(aiPolicies.id, policyId));

    // Governance text changes what the AI is allowed to say to students — audit old and new.
    await this.audit.write({
      action: 'AI_POLICY_UPDATED',
      module: MODULE,
      userId: admin.id,
      targetType: 'ai_policy',
      targetId: policyId,
      oldValues: {
        instructions: existing.instructions,
        restrictions: existing.restrictions,
        is_active: existing.isActive,
      },
      newValues: {
        instructions: updated.instructions,
        restrictions: updated.restrictions,
        is_active: updated.isActive,
      },
    });

    return { ...existing, ...updated };
  }
}
