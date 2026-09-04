import { count, eq, gte, sql } from 'drizzle-orm';

import type { Database } from '@/db/client';
import { aiRequests, knowledgeChunks, knowledgeDocuments, users } from '@/db/schema';
import type { Env } from '@/env';
import {
  DAILY_GENERATION_BUDGET,
  GENERATION_BUDGET_DEGRADE_AT,
  generationBudgetGuard,
} from '@/lib/auth-guard';

/**
 * What this platform is spending of the Cloudflare free plan, as far as it can honestly tell.
 *
 * ## The rule this file follows
 *
 * **Nothing here is estimated and presented as measured.** Every metric carries where its number
 * came from, because the two kinds are not interchangeable to the person reading them: a
 * *measured* figure is this system counting its own work, and a *documented* one is a number from
 * Cloudflare's pricing page that no binding will confirm at runtime. An admin deciding whether the
 * platform is about to stop working needs to know which of those they are looking at.
 *
 * That distinction is why this is not simply a dashboard of everything. Workers requests per day,
 * neurons consumed, KV reads, queue depth — all of them are real limits this project runs against,
 * and **none of them is readable from inside a Worker.** Showing a plausible-looking bar for them
 * would be the same failure the AI pipeline spent four phases eliminating: a confident number with
 * nothing behind it. They are reported as unmetered instead, by name, so their absence is visible
 * rather than silent.
 *
 * ## Why the generation budget is the headline
 *
 * It is the one AI limit that is both measured and actionable. Workers AI exposes no neuron meter,
 * so `DAILY_GENERATION_BUDGET` is a proxy chosen from this system's two generation shapes — and
 * because the guard charges a Durable Object counter before every model call, that counter is a
 * true count of what was spent today. Reading it here is the first time it has been visible
 * anywhere: it was previously observable only by exhausting it.
 */

/** A limit whose usage this system can actually count. */
export interface MeteredResource {
  key: string;
  label: string;
  /** What the number counts, in the admin's words. */
  unit: string;
  used: number;
  limit: number;
  /**
   * Where the ceiling comes from. `platform` is Cloudflare's published free-plan limit;
   * `self-imposed` is a budget this codebase chose and enforces itself — the difference matters,
   * because only one of them can be raised by editing a constant.
   */
  limitSource: 'platform' | 'self-imposed';
  /**
   * The fraction at which this system starts degrading on purpose, if it does. Rendering it lets
   * the bar show *the line that actually matters* rather than only the cliff at 100%.
   */
  degradeAt?: number;
  detail: string;
}

/** A limit that is real but that no binding will report at runtime. */
export interface UnmeteredLimit {
  label: string;
  limit: string;
  why: string;
}

export interface UsageSnapshot {
  capturedAt: string;
  resources: MeteredResource[];
  unmetered: UnmeteredLimit[];
}

/**
 * Cloudflare free-plan ceilings, checked against the current pricing documentation on 2026-09-05.
 *
 * Constants rather than a fetch: these change on Cloudflare's schedule, not ours, and a dashboard
 * that made a live third-party call to draw a static number would fail in a way the thing it
 * monitors does not.
 */
const FREE_PLAN = {
  /** Vectorize: stored vectors across all indexes. */
  vectorizeVectors: 5_000_000,
  /** D1: database size. */
  d1StorageBytes: 5 * 1024 * 1024 * 1024,
  /** D1: rows written per day, across the account. */
  d1RowsWrittenDaily: 100_000,
} as const;

export class PlatformUsageService {
  constructor(
    private readonly db: Database,
    private readonly env: Env,
  ) {}

  async snapshot(now = new Date()): Promise<UsageSnapshot> {
    const dayStart = `${now.toISOString().slice(0, 10)}T00:00:00.000Z`;

    const [generations, corpus, requestsToday, storageBytes, accounts] = await Promise.all([
      this.generationsToday(),
      this.corpus(),
      this.aiRequestsSince(dayStart),
      this.databaseBytes(),
      this.activeAccounts(),
    ]);

    const resources: MeteredResource[] = [
      {
        key: 'ai_generations',
        label: 'AI generations today',
        unit: 'generations',
        used: generations,
        limit: DAILY_GENERATION_BUDGET,
        limitSource: 'self-imposed',
        degradeAt: GENERATION_BUDGET_DEGRADE_AT,
        detail:
          'Counted by the guard that charges before every model call, so this is what was actually spent. Workers AI publishes no neuron meter, so the budget is a proxy for the 10,000 daily neurons — not a reading of them. Past the degrade line only the gates that cost nothing keep answering; the counter resets at 00:00 UTC.',
      },
      {
        key: 'vectorize_vectors',
        label: 'Knowledge vectors',
        unit: 'vectors',
        used: corpus.embedded,
        limit: FREE_PLAN.vectorizeVectors,
        limitSource: 'platform',
        detail: `${corpus.chunks.toLocaleString('en-PH')} passages in the corpus, ${corpus.embedded.toLocaleString('en-PH')} of them embedded. A passage without a vector is searchable by keyword but invisible to meaning — the gap between these two numbers is the one worth watching.`,
      },
      {
        key: 'd1_storage',
        label: 'Database size',
        unit: 'bytes',
        used: storageBytes,
        limit: FREE_PLAN.d1StorageBytes,
        limitSource: 'platform',
        detail:
          'Reported by D1 itself on every query, so it is measured rather than inferred. Audit rows and AI provenance are the two things here that only ever grow.',
      },
      {
        key: 'ai_requests_today',
        label: 'AI calls logged today',
        unit: 'calls',
        used: requestsToday.total,
        limit: FREE_PLAN.d1RowsWrittenDaily,
        limitSource: 'platform',
        detail: `${requestsToday.failed.toLocaleString('en-PH')} of them refused an answer. Each call writes provenance rows, which is why it is charged against the daily D1 write allowance rather than shown on its own.`,
      },
      {
        key: 'accounts',
        label: 'Active accounts',
        unit: 'people',
        used: accounts,
        limit: FREE_PLAN.d1RowsWrittenDaily,
        limitSource: 'platform',
        detail:
          'Every signed-in person writes rows — sessions, assessments, chat. Shown against the same daily write allowance because that is the ceiling a growing school actually meets first.',
      },
    ];

    return {
      capturedAt: now.toISOString(),
      resources,
      unmetered: UNMETERED,
    };
  }

  /**
   * Today's generation count, read from the guard's own counter without charging it.
   *
   * Falls back to zero rather than throwing: this is a dashboard, and a Durable Object that cannot
   * be reached is not a reason to fail the whole page. A window that has expired reads as zero,
   * which is correct — the budget did reset.
   */
  private async generationsToday(): Promise<number> {
    try {
      const state = await generationBudgetGuard(this.env).check(DAILY_GENERATION_BUDGET);

      return state.attempts;
    } catch {
      return 0;
    }
  }

  private async corpus(): Promise<{ chunks: number; embedded: number }> {
    const [row] = await this.db
      .select({
        chunks: count(),
        embedded: sql<number>`sum(case when ${knowledgeChunks.vectorId} is not null then 1 else 0 end)`,
      })
      .from(knowledgeChunks)
      .innerJoin(knowledgeDocuments, eq(knowledgeDocuments.id, knowledgeChunks.documentId))
      .where(sql`${knowledgeDocuments.archivedAt} is null`);

    return { chunks: row?.chunks ?? 0, embedded: Number(row?.embedded ?? 0) };
  }

  private async aiRequestsSince(since: string): Promise<{ total: number; failed: number }> {
    const [row] = await this.db
      .select({
        total: count(),
        failed: sql<number>`sum(case when ${aiRequests.status} = 'FAILED' then 1 else 0 end)`,
      })
      .from(aiRequests)
      .where(gte(aiRequests.createdAt, since));

    return { total: row?.total ?? 0, failed: Number(row?.failed ?? 0) };
  }

  /**
   * The database's own size, from the `meta` D1 attaches to every query result.
   *
   * There is no binding that asks "how big are you"; `size_after` is the only place a Worker is
   * told, and it rides along on a statement that has to run anyway. Zero when the runtime does not
   * supply it — the local test pool does not — which the caller renders as "not reported" rather
   * than as an empty database.
   */
  private async databaseBytes(): Promise<number> {
    try {
      const result = (await this.env.DB.prepare('SELECT 1').run()) as {
        meta?: { size_after?: number };
      };

      return result.meta?.size_after ?? 0;
    } catch {
      return 0;
    }
  }

  private async activeAccounts(): Promise<number> {
    const [row] = await this.db
      .select({ total: count() })
      .from(users)
      .where(sql`${users.deletedAt} is null and ${users.status} = 'active'`);

    return row?.total ?? 0;
  }
}

/**
 * The limits this project genuinely runs against and cannot read.
 *
 * Listed rather than omitted. An admin who sees five green bars and no mention of Workers requests
 * could reasonably conclude the platform is fully monitored, and the first they would learn
 * otherwise is an outage. Naming the blind spots is the honest version of a health screen.
 */
const UNMETERED: UnmeteredLimit[] = [
  {
    label: 'Workers requests',
    limit: '100,000 / day',
    why: 'A Worker is not told its own request count. Visible only in the Cloudflare dashboard.',
  },
  {
    label: 'Workers AI neurons',
    limit: '10,000 / day',
    why: 'No neuron meter is exposed to a Worker at all — which is exactly why the generation budget above exists as a proxy.',
  },
  {
    label: 'Subrequests per invocation',
    limit: '50',
    why: 'Enforced by the runtime rather than reported by it. The catalog sync is built around this ceiling and reports what it could not fit as remaining work.',
  },
  {
    label: 'D1 rows read',
    limit: '5,000,000 / day',
    why: 'Each query reports its own rows read, but no running daily total is kept anywhere a Worker can reach.',
  },
  {
    label: 'KV writes',
    limit: '1,000 / day',
    why: 'The embedding cache writes here. Counting them would itself cost a write per write.',
  },
  {
    label: 'R2 storage',
    limit: '10 GB',
    why: 'Original uploads and extracted text. R2 reports per-object size on read, never a bucket total.',
  },
];
