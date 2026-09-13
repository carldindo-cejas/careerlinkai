import { env } from 'cloudflare:test';
import { and, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

import { knowledgeDocuments } from '@/db/schema';
import { GUIDANCE_ENTRIES, GUIDANCE_QA } from '@/knowledge/guidance';
import { chunkText, cleanText } from '@/lib/chunker';
import { parseQaChunk } from '@/lib/grounding';
import { CAREER_WEIGHTS, PROGRAM_WEIGHTS } from '@/lib/recommendation';
import {
  GUIDANCE_SYNC_BATCH,
  guidanceDocuments,
  syncGuidanceKnowledge,
} from '@/modules/ai/guidance-knowledge-service';
import { createStaffUser, db, login, api } from '../helpers';

/**
 * The Guidance corpus (AI-COVERAGE-PLAN.md Phase 3): what it says, and how it reaches the index.
 */

describe('the Guidance corpus text', () => {
  it('fits every entry in one passage, so a topic is never split across chunks', () => {
    for (const document of guidanceDocuments()) {
      expect(chunkText(cleanText(document.body)), document.entityId).toHaveLength(1);
    }
  });

  it('has unique slugs', () => {
    const slugs = guidanceDocuments().map((document) => document.entityId);

    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it('shapes every Q&A pair so Gate 1 can return its answer verbatim', () => {
    for (const document of guidanceDocuments().filter((d) => d.sourceType === 'qa')) {
      expect(parseQaChunk(cleanText(document.body)), document.entityId).not.toBeNull();
    }
  });

  /** The scoring guide is cited to students as fact, so it must say what the code does. */
  it('states the scoring weights the engine actually uses', () => {
    const guide = GUIDANCE_ENTRIES.find((entry) => entry.slug === 'how-match-scores-work')!;
    const percent = (weight: number) => `${Math.round(weight * 100)}%`;

    for (const weight of [
      CAREER_WEIGHTS.riasecCompatibility,
      CAREER_WEIGHTS.careerConfidence,
      PROGRAM_WEIGHTS.riasecCompatibility,
      PROGRAM_WEIGHTS.academicFit,
      PROGRAM_WEIGHTS.strandAlignment,
      PROGRAM_WEIGHTS.programEligibility,
    ]) {
      expect(guide.body).toContain(percent(weight));
    }
  });
});

describe('syncGuidanceKnowledge', () => {
  it('writes the corpus in budgeted batches, then does nothing on an unchanged run', async () => {
    const admin = await createStaffUser({ role: 'admin' });
    const total = GUIDANCE_ENTRIES.length + GUIDANCE_QA.length;

    const first = await syncGuidanceKnowledge(db(), env, admin.id);

    expect(first.total).toBe(total);
    expect(first.changed).toBe(Math.min(total, GUIDANCE_SYNC_BATCH));
    expect(first.remaining).toBe(Math.max(0, total - GUIDANCE_SYNC_BATCH));

    // Drain the rest the way the queue continuation would.
    let result = first;

    while (result.remaining > 0) {
      result = await syncGuidanceKnowledge(db(), env, admin.id);
    }

    const again = await syncGuidanceKnowledge(db(), env, admin.id);

    expect(again.changed).toBe(0);
    expect(again.remaining).toBe(0);

    const rows = await db()
      .select()
      .from(knowledgeDocuments)
      .where(eq(knowledgeDocuments.entityType, 'guide'));

    expect(rows).toHaveLength(total);
  });

  it('stores Q&A pairs as qa entries titled with the question', async () => {
    const admin = await createStaffUser({ role: 'admin' });
    const pair = GUIDANCE_QA[0]!;

    await syncGuidanceKnowledge(db(), env, admin.id, { limit: 1000 });

    const [row] = await db()
      .select()
      .from(knowledgeDocuments)
      .where(
        and(
          eq(knowledgeDocuments.entityType, 'guide'),
          eq(knowledgeDocuments.entityId, pair.slug),
        ),
      );

    expect(row!.sourceType).toBe('qa');
    expect(row!.title).toBe(pair.question);

    const body = await env.STORAGE.get(`knowledge/${row!.id}/extracted.txt`);

    await expect(body!.text()).resolves.toContain(`A: ${pair.answer}`);
  });

  it('leaves an entry an admin archived archived', async () => {
    const admin = await createStaffUser({ role: 'admin' });
    const token = await login(admin);

    await syncGuidanceKnowledge(db(), env, admin.id, { limit: 1000 });

    const [entry] = await db()
      .select()
      .from(knowledgeDocuments)
      .where(eq(knowledgeDocuments.entityId, GUIDANCE_ENTRIES[0]!.slug));

    await api('DELETE', `/admin/knowledge-documents/${entry!.id}`, { token });
    await syncGuidanceKnowledge(db(), env, admin.id, { limit: 1000 });

    const [after] = await db()
      .select()
      .from(knowledgeDocuments)
      .where(eq(knowledgeDocuments.id, entry!.id));

    expect(after!.archivedAt).not.toBeNull();
  });
});
