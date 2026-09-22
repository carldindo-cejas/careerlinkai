import { eq } from 'drizzle-orm';

import type { Database } from '@/db/client';
import { knowledgeDocuments } from '@/db/schema';
import type { Env } from '@/env';
import { guidanceEntries, GUIDANCE_QA } from '@/knowledge/guidance';
import { DEFAULT_FORMULA, type ScoringFormula } from '@/lib/scoring-formula';
import { log } from '@/lib/logger';
import { firstAdminId, sha256 } from '@/modules/ai/catalog-knowledge-service';
import { ingestionFrom } from '@/modules/ai/factory';
import { FormulaService } from '@/modules/recommendation/formula-service';

/**
 * **Guidance sync** — puts the Guidance corpus (`src/knowledge/guidance.ts`) into the index
 * (AI-COVERAGE-PLAN.md Phase 3, 2026-09-13).
 *
 * The same machinery as the catalog sync, deliberately separate from it:
 *
 *   * **Its own budget.** A rewrite costs two subrequests (an R2 put and a D1 write) against a free
 *     Worker's 50 (§45). The catalog sync already spends up to 40 of the cron's invocation, so the
 *     guidance sync runs on its own queue message with its own 20-entry batch and its own
 *     continuation — never inside the cron or an admin's request.
 *   * **Its own tests stay meaningful.** The catalog sync's contract — a second run over an
 *     unchanged catalog changes nothing — is asserted against a tiny test catalog. Folding forty
 *     guidance entries into the same batch would have made the first run leave work behind and
 *     broken that contract for reasons unrelated to the catalog.
 *
 * Idempotent: an entry whose text is unchanged is not rewritten, re-queued or re-embedded, so after
 * the first full run this costs nothing until someone edits `guidance.ts`. An entry an admin
 * archived stays archived; an entry an admin edited keeps the edit until the text here changes.
 * An entry removed from `guidance.ts` is archived.
 *
 * Never throws — it runs from a queue consumer, where an exception is a retry storm.
 */

export const GUIDANCE_SYNC_BATCH = 20;

export interface GuidanceSyncResult {
  total: number;
  changed: number;
  retired: number;
  remaining: number;
  skipped?: string;
}

interface GuidanceDocument {
  entityId: string;
  title: string;
  body: string;
  sourceType: 'catalog' | 'qa';
}

/**
 * Every document the corpus should hold, in a stable order.
 *
 * The formula is an argument because three of the results passages quote the weights the engine
 * scores with, and those are operator-set (2026-09-21). Defaulted so the corpus tests — which check
 * chunking and slugs, not arithmetic — need no database.
 */
export function guidanceDocuments(
  formula: ScoringFormula = DEFAULT_FORMULA,
): GuidanceDocument[] {
  return [
    ...guidanceEntries(formula).map((entry) => ({
      entityId: entry.slug,
      title: entry.title,
      body: entry.body,
      sourceType: 'catalog' as const,
    })),
    // Shaped exactly like an admin-authored pair, so Gate 1 (`parseQaChunk`) can return the answer
    // verbatim, and titled with the question, as admin Q&A entries are.
    ...GUIDANCE_QA.map((pair) => ({
      entityId: pair.slug,
      title: pair.question,
      body: `Q: ${pair.question}\nA: ${pair.answer}`,
      sourceType: 'qa' as const,
    })),
  ];
}

export async function syncGuidanceKnowledge(
  db: Database,
  env: Env,
  actorId?: string,
  options: { limit?: number } = {},
): Promise<GuidanceSyncResult> {
  // The stored weights, so the scoring passages say what this deployment actually computes. A
  // re-weighting asks for a sync (`PUT /admin/recommendation-formula`), and `content_hash` means
  // the three passages that moved are rewritten and the other forty are left alone.
  const desired = guidanceDocuments(await new FormulaService(db).get());

  try {
    const uploadedBy = actorId ?? (await firstAdminId(db));

    if (uploadedBy === undefined) {
      return {
        total: desired.length,
        changed: 0,
        retired: 0,
        remaining: 0,
        skipped: 'No admin account exists to attribute the entries to.',
      };
    }

    const ingestion = ingestionFrom(db, env);
    const existing = await db
      .select()
      .from(knowledgeDocuments)
      .where(eq(knowledgeDocuments.entityType, 'guide'));
    const bySlug = new Map(existing.map((row) => [row.entityId ?? '', row]));

    const budget = options.limit ?? GUIDANCE_SYNC_BATCH;
    const queued: string[] = [];
    let changed = 0;
    let remaining = 0;

    for (const document of desired) {
      const row = bySlug.get(document.entityId);
      const contentHash = await sha256(document.body);

      if (
        row !== undefined &&
        (row.archivedAt !== null ||
          (row.contentHash === contentHash && row.title === document.title))
      ) {
        continue;
      }

      if (changed >= budget) {
        remaining += 1;
        continue;
      }

      const result = await ingestion.upsertCatalogEntry(
        uploadedBy,
        {
          entityType: 'guide',
          entityId: document.entityId,
          title: document.title,
          body: document.body,
          contentHash,
          sourceType: document.sourceType,
        },
        row,
        { enqueue: false },
      );

      if (result.changed) {
        changed += 1;
        queued.push(result.document.id);
      }
    }

    await ingestion.enqueueProcessingBatch(queued);

    const live = new Set(desired.map((document) => document.entityId));
    let retired = 0;

    for (const row of existing) {
      if (row.archivedAt !== null || row.entityId === null || live.has(row.entityId)) {
        continue;
      }

      try {
        await ingestion.archiveAs(uploadedBy, row.id, null);
        retired += 1;
      } catch (error) {
        log('error', 'guidance_knowledge.retire_failed', {
          pipeline: 'knowledge_ingestion',
          document_id: row.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    log('info', 'guidance_knowledge.synced', {
      pipeline: 'knowledge_ingestion',
      total: desired.length,
      changed,
      retired,
      remaining,
    });

    return { total: desired.length, changed, retired, remaining };
  } catch (error) {
    log('error', 'guidance_knowledge.sync_failed', {
      pipeline: 'knowledge_ingestion',
      error: error instanceof Error ? error.message : String(error),
    });

    return {
      total: desired.length,
      changed: 0,
      retired: 0,
      remaining: 0,
      skipped: 'The guidance sync failed; see the logs.',
    };
  }
}
