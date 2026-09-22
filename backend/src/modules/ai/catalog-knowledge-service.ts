import { and, asc, eq, isNull } from 'drizzle-orm';

import type { Database } from '@/db/client';
import {
  careers,
  colleges,
  employmentOutlooks,
  knowledgeDocuments,
  programCareerLinks,
  programs,
  regions,
  towns,
  provinces,
  users,
} from '@/db/schema';
import type { Env } from '@/env';
import { collegeAliases } from '@/lib/aliases';
import { log } from '@/lib/logger';
import { ingestionFrom } from '@/modules/ai/factory';

/**
 * **Catalog auto-sync** — one knowledge entry per career and per program, generated from data
 * this system already holds (AiNormalisation Phase 1).
 *
 * ## Why this exists
 *
 * On 2026-09-04 the production corpus was measured at zero documents, ever. Every other way of
 * adding knowledge needs somebody to sit down and write something; this one needs nobody. The
 * catalog is already populated — 68 careers came in with seed 0004 — and every one of those rows
 * carries a description, a salary band, a RIASEC code and an outlook that no student can currently
 * get an answer about.
 *
 * It is also the direct cure for a dead **Explain more**. That pipeline retrieves on the target's
 * own title and description (D4) and then refuses if nothing comes back — so the single most
 * useful passage in the corpus, for explaining Nursing at Saint Louis College, is a passage *about
 * Nursing at Saint Louis College*. Before this, the corpus could not contain one unless an admin
 * happened to upload a document that mentioned it.
 *
 * ## What it is not
 *
 * Not a replacement for admin-authored knowledge. A catalog entry can only say what the catalog
 * says: it will never answer "how much is tuition" or "what are the entrance requirements",
 * because this system does not hold those facts. It is the floor, not the ceiling — it guarantees
 * every recommendation target has *something* true about itself in the index, and Q&A entries
 * remain where the school's own knowledge enters.
 *
 * ## Cost
 *
 * Each entry is short — comfortably one chunk — so a full catalog of ~68 careers plus its programs
 * is a few hundred chunks at most, and `upsertCatalogEntry` re-embeds **only what changed**. A
 * nightly run over an unchanged catalog costs zero neurons, which is what makes it safe to leave
 * on the 03:00 cron on a 10,000-neuron budget.
 */

export interface CatalogSyncResult {
  /** Careers + programs considered. */
  total: number;
  /** How many were written and re-queued — the rest were already identical. */
  changed: number;
  /** Entries archived because their career or program is no longer active. */
  retired: number;
  /** Entries that still need rewriting but did not fit this invocation's subrequest budget. */
  remaining: number;
  /** Set when the sync could not run, rather than throwing into a cron. */
  skipped?: string;
}

/**
 * Character budgets for the three generated lists.
 *
 * A budget rather than a count, because names differ wildly in length: "Programs offered at Cebu
 * Technological University" is a list of short degree codes at one college and a list of
 * "<degree> at <institution>" pairs at a popular career. The ceiling that matters is
 * `MAX_CHUNK_CHARS` (1,680) — an entry that outgrows it is split by the chunker, and the split
 * would put the location sentence in one chunk and half the offerings in another, which is
 * exactly the subject-splitting this entry type exists to avoid.
 */
const COLLEGE_PROGRAM_BUDGET = 900;
const PROGRAM_CAREER_BUDGET = 600;
const CAREER_OFFERING_BUDGET = 700;

/**
 * Render names as a sentence fragment, truncated honestly. Null when there is nothing to say.
 *
 * Two things here matter beyond formatting. The list is **sorted and de-duplicated**, because the
 * passage's SHA-256 is what decides whether an entry is rewritten and re-embedded (migration
 * 0024): an order that varied between runs would re-embed the whole catalog every night for no
 * change in meaning, on a budget that cannot afford it.
 *
 * And an over-long list ends with the count it dropped rather than an ellipsis. "and 14 more" is
 * a true statement the model can repeat; a trailing "..." is an invitation to fill in the rest
 * from its own weights, which is the one thing every guardrail downstream exists to prevent.
 */
function namedList(names: string[], budget: number): string | null {
  const unique = [...new Set(names.map((name) => name.trim()).filter((name) => name !== ''))].sort();

  if (unique.length === 0) {
    return null;
  }

  const kept: string[] = [];
  let used = 0;

  for (const name of unique) {
    // `kept.length > 0` so a single name longer than the whole budget is still stated rather
    // than silently becoming "and 1 more".
    if (kept.length > 0 && used + name.length + 2 > budget) {
      break;
    }

    kept.push(name);
    used += name.length + 2;
  }

  const dropped = unique.length - kept.length;

  return dropped === 0 ? kept.join(', ') : `${kept.join(', ')}, and ${dropped} more`;
}

/**
 * Compose the passage for one college (2026-09-09).
 *
 * The entry the corpus was missing. Measured on production: "Where is Holy Name University
 * located?" was refused three times out of three, while "Tell me about BS Accountancy at Holy
 * Name University" answered correctly *and included the address* — from a chunk whose subject was
 * the program. Retrieval was working; there was simply no passage about the institution, so a
 * question about one matched career passages instead.
 *
 * It states the location down to the region, so "colleges in Bohol" and "colleges in Central
 * Visayas" both have something to match, and it names what the college offers, so "what colleges
 * in Cebu offer BS Computer Science?" — asked by a real student on 2026-09-05 and refused — can
 * be answered from one retrieved chunk rather than by joining two.
 */
function collegePassage(college: {
  name: string;
  description: string | null;
  town: string | null;
  province: string | null;
  region: string | null;
  programNames: string[];
}): string {
  const location = [college.town, college.province, college.region]
    .filter((part): part is string => part !== null && part.trim() !== '')
    .join(', ');

  const offered = namedList(college.programNames, COLLEGE_PROGRAM_BUDGET);
  // 2026-09-13: "HNU located" was refused because no passage contained "HNU". Stating the short
  // names students use makes them retrievable by keyword and known to the claim check.
  const aliases = collegeAliases(college.name);

  return [
    `College: ${college.name}.`,
    aliases.length === 0 ? null : `Also called: ${aliases.join(', ')}.`,
    location === '' ? null : `${college.name} is located in ${location}.`,
    college.description === null || college.description.trim() === ''
      ? null
      : `About this college: ${college.description.trim()}`,
    // Stated rather than omitted: "no programs listed" is the honest answer to "what does this
    // college offer?", and silence would leave the model to guess that it offers the usual ones.
    offered === null
      ? `No programs are listed for ${college.name} in this system yet.`
      : `Programs offered at ${college.name}: ${offered}.`,
  ]
    .filter((line): line is string => line !== null)
    .join('\n');
}

/**
 * Compose the passage for one career.
 *
 * Written as prose sentences rather than a field dump, deliberately: this text is embedded by a
 * bi-encoder and read by an 8B model, and both do better with "Registered Nurses earn between
 * PHP 25,000 and PHP 40,000 a month" than with `salary_min=25000`. The label words are also what
 * a student's question contains — "salary", "strand", "outlook" — so they carry retrieval weight
 * of their own.
 *
 * Every line is conditional. A career with no salary on file produces a passage that simply does
 * not mention salary, which is the correct grounding: silence is what stops the model inventing
 * a figure, and a line reading "Salary: null" would invite one.
 */
function careerPassage(career: {
  title: string;
  description: string | null;
  salaryMin: number | null;
  salaryMax: number | null;
  typicalRiasecCode: string | null;
  outlook: string | null;
  /** `"<program> at <college>"` for every active offering linked to this career. */
  offerings: string[];
}): string {
  const money = (amount: number) => `PHP ${amount.toLocaleString('en-PH')}`;
  const offerings = namedList(career.offerings, CAREER_OFFERING_BUDGET);

  return [
    `Career: ${career.title}.`,
    career.description === null || career.description.trim() === ''
      ? null
      : `About this career: ${career.description.trim()}`,
    career.salaryMin !== null && career.salaryMax !== null
      ? `Typical monthly salary in the Philippines ranges from ${money(career.salaryMin)} to ${money(career.salaryMax)}.`
      : null,
    career.typicalRiasecCode === null
      ? null
      : `It typically suits students with the RIASEC interest code ${career.typicalRiasecCode}.`,
    career.outlook === null ? null : `Employment outlook: ${career.outlook}.`,
    /*
      The reverse direction of `program_careers`, which reached the corpus nowhere before
      2026-09-09. "what school should i enroll for database administrator career" and
      "schools with my top 1 career" are both in the production refusal log, and both were
      always one join away: the links are richly populated — BS Accountancy alone maps to five
      careers — and were simply never written into anything the assistant could read.
    */
    offerings === null ? null : `Programs that lead to this career: ${offerings}.`,
  ]
    .filter((line): line is string => line !== null)
    .join('\n');
}

/** The same treatment for one college's offering of a program — including where it is taught. */
function programPassage(program: {
  name: string;
  code: string;
  description: string | null;
  recommendedStrand: string | null;
  collegeName: string;
  town: string | null;
  province: string | null;
  region: string | null;
  /** Titles of the active careers linked to this program through `program_careers`. */
  careerTitles: string[];
}): string {
  const location = [program.town, program.province, program.region]
    .filter((part): part is string => part !== null && part.trim() !== '')
    .join(', ');
  const destinations = namedList(program.careerTitles, PROGRAM_CAREER_BUDGET);

  return [
    `Program: ${program.name} (${program.code}) at ${program.collegeName}.`,
    location === '' ? null : `${program.collegeName} is located in ${location}.`,
    program.description === null || program.description.trim() === ''
      ? null
      : `About this program: ${program.description.trim()}`,
    program.recommendedStrand === null
      ? // NULL is a claim here, not a gap — §27 scores it as 100 — so the passage states it.
        'This program has no specific senior high school strand requirement.'
      : `The recommended senior high school strand is ${program.recommendedStrand}.`,
    /*
      Where a program leads — the forward half of `program_careers`, and the difference between
      "what career can I take after this?" being answered from the school's own mapping and
      being answered by an 8B model noticing that BS Accountancy sounds like accountancy.
    */
    destinations === null
      ? null
      : `Graduates of ${program.name} commonly go into these careers: ${destinations}.`,
  ]
    .filter((line): line is string => line !== null)
    .join('\n');
}

/**
 * The most entries one invocation may rewrite.
 *
 * Every binding call is a subrequest, and a free Worker invocation gets **50** (§45). A rewritten
 * entry costs two — an R2 put and a D1 write — so 20 spends 40, leaving room for the listing
 * queries, the batched queue send, and the retirement pass. Unchanged entries cost nothing at all
 * now that the comparison is a hash on the row (migration 0024), so this cap binds only while the
 * catalog is genuinely being seeded or has genuinely changed.
 *
 * When it binds, the run reports `remaining` and the caller queues the next page — so the initial
 * seed of 68 careers finishes on its own, rather than needing somebody to press a button four
 * times.
 */
export const CATALOG_SYNC_BATCH = 20;

/**
 * Sync every active career and program.
 *
 * `actorId` attributes the generated rows to a person: `knowledge_documents.uploaded_by` is NOT
 * NULL, and a row nobody can be traced to is a row nobody owns. The admin who pressed the button
 * when it is a request; the earliest admin account when it is the cron, which is the same
 * convention as every other system-triggered write here choosing a real, checkable actor over a
 * synthetic one.
 *
 * Never throws. It runs on a cron, where an exception is an unread log line and a job that
 * silently stops happening — a `skipped` result says the same thing where somebody can see it.
 */
export async function syncCatalogKnowledge(
  db: Database,
  env: Env,
  actorId?: string,
  options: { limit?: number } = {},
): Promise<CatalogSyncResult> {
  const uploadedBy = actorId ?? (await firstAdminId(db));

  if (uploadedBy === undefined) {
    return {
      total: 0,
      changed: 0,
      retired: 0,
      remaining: 0,
      skipped: 'No admin account exists to attribute the entries to.',
    };
  }

  const ingestion = ingestionFrom(db, env);

  const careerRows = await db
    .select({
      id: careers.id,
      title: careers.title,
      description: careers.description,
      salaryMin: careers.salaryMin,
      salaryMax: careers.salaryMax,
      typicalRiasecCode: careers.typicalRiasecCode,
      outlook: employmentOutlooks.name,
    })
    .from(careers)
    .leftJoin(employmentOutlooks, eq(careers.employmentOutlookId, employmentOutlooks.id))
    .where(and(eq(careers.status, 'active'), isNull(careers.deletedAt)))
    .orderBy(asc(careers.id));

  /**
   * The **active chain**, not merely an active program (aligned 2026-09-09).
   *
   * This used to filter on the program alone, so an active program under an archived college kept
   * a knowledge entry and the assistant would happily describe an offering at an institution the
   * school had withdrawn. `rankablePrograms` and `publicCatalog` both already require the whole
   * chain — and what the engine will recommend is the right definition of what the assistant
   * may describe.
   */
  const programRows = await db
    .select({
      id: programs.id,
      collegeId: programs.collegeId,
      name: programs.name,
      code: programs.code,
      description: programs.description,
      recommendedStrand: programs.recommendedStrand,
      collegeName: colleges.name,
      town: towns.name,
      province: provinces.name,
      region: regions.name,
    })
    .from(programs)
    .innerJoin(colleges, eq(programs.collegeId, colleges.id))
    .leftJoin(towns, eq(colleges.townId, towns.id))
    .leftJoin(provinces, eq(colleges.provinceId, provinces.id))
    .leftJoin(regions, eq(colleges.regionId, regions.id))
    .where(
      and(
        eq(programs.status, 'active'),
        isNull(programs.deletedAt),
        eq(colleges.status, 'active'),
        isNull(colleges.deletedAt),
      ),
    )
    .orderBy(asc(programs.id));

  const collegeRows = await db
    .select({
      id: colleges.id,
      name: colleges.name,
      description: colleges.description,
      town: towns.name,
      province: provinces.name,
      region: regions.name,
    })
    .from(colleges)
    .leftJoin(towns, eq(colleges.townId, towns.id))
    .leftJoin(provinces, eq(colleges.provinceId, provinces.id))
    .leftJoin(regions, eq(colleges.regionId, regions.id))
    .where(and(eq(colleges.status, 'active'), isNull(colleges.deletedAt)))
    .orderBy(asc(colleges.id));

  /**
   * Both directions of the mapping in **one** query — through `program_career_links` (migration
   * 0040), so an offering's careers are its canonical program's plus its own extras, the same set
   * the scorer ranks it on.
   *
   * A program needs its careers and a career needs its offerings, and reading the join twice
   * would spend a second subrequest to learn the same rows. The active chain is applied here too:
   * a link to an archived career is not a destination worth telling a student about.
   */
  const linkRows = await db
    .select({
      programId: programCareerLinks.programId,
      careerId: programCareerLinks.careerId,
      careerTitle: careers.title,
      programName: programs.name,
      collegeName: colleges.name,
    })
    .from(programCareerLinks)
    .innerJoin(careers, eq(programCareerLinks.careerId, careers.id))
    .innerJoin(programs, eq(programCareerLinks.programId, programs.id))
    .innerJoin(colleges, eq(programs.collegeId, colleges.id))
    .where(
      and(
        eq(careers.status, 'active'),
        isNull(careers.deletedAt),
        eq(programs.status, 'active'),
        isNull(programs.deletedAt),
        eq(colleges.status, 'active'),
        isNull(colleges.deletedAt),
      ),
    );

  const careerTitlesByProgram = new Map<string, string[]>();
  const offeringsByCareer = new Map<string, string[]>();
  const programNamesByCollege = new Map<string, string[]>();

  for (const link of linkRows) {
    appendTo(careerTitlesByProgram, link.programId, link.careerTitle);
    appendTo(offeringsByCareer, link.careerId, `${link.programName} at ${link.collegeName}`);
  }

  for (const program of programRows) {
    appendTo(programNamesByCollege, program.collegeId, program.name);
  }

  /**
   * Every existing catalog entry, in **one** query.
   *
   * This is the change that makes a nightly full-catalog sync affordable. The previous shape read
   * each entry's text back from R2 to decide whether it had changed — one subrequest per career,
   * every run, against a ceiling of 50 — so a catalog of 68 careers breached the limit before it
   * wrote anything, even on a night when nothing had changed at all.
   */
  const existingEntries = await db
    .select()
    .from(knowledgeDocuments)
    .where(eq(knowledgeDocuments.sourceType, 'catalog'));

  const byEntity = new Map(
    existingEntries
      .filter((entry) => entry.entityType !== null && entry.entityId !== null)
      .map((entry) => [`${entry.entityType}:${entry.entityId}`, entry] as const),
  );

  const desired = [
    ...careerRows.map((career) => ({
      entityType: 'career' as const,
      entityId: career.id,
      title: `Career: ${career.title}`,
      body: careerPassage({ ...career, offerings: offeringsByCareer.get(career.id) ?? [] }),
    })),
    ...programRows.map((program) => ({
      entityType: 'program' as const,
      entityId: program.id,
      title: `Program: ${program.name} at ${program.collegeName}`,
      body: programPassage({
        ...program,
        careerTitles: careerTitlesByProgram.get(program.id) ?? [],
      }),
    })),
    ...collegeRows.map((college) => ({
      entityType: 'college' as const,
      entityId: college.id,
      title: `College: ${college.name}`,
      body: collegePassage({
        ...college,
        programNames: programNamesByCollege.get(college.id) ?? [],
      }),
    })),
  ];

  const budget = options.limit ?? CATALOG_SYNC_BATCH;
  const queued: string[] = [];
  let changed = 0;
  let remaining = 0;

  for (const entry of desired) {
    const existing = byEntity.get(`${entry.entityType}:${entry.entityId}`);
    const contentHash = await sha256(entry.body);

    // Unchanged: decided from rows already in hand, at no subrequest cost.
    if (
      existing !== undefined &&
      (existing.archivedAt !== null ||
        (existing.contentHash === contentHash && existing.title === entry.title))
    ) {
      continue;
    }

    if (changed >= budget) {
      remaining += 1;
      continue;
    }

    const result = await ingestion.upsertCatalogEntry(
      uploadedBy,
      { ...entry, contentHash },
      existing,
      // One batched send for the whole run, below — a queue send is a subrequest too.
      { enqueue: false },
    );

    if (result.changed) {
      changed += 1;
      queued.push(result.document.id);
    }
  }

  await ingestion.enqueueProcessingBatch(queued);

  /**
   * Retire the entries whose subject is gone.
   *
   * Without this the sync only ever *adds*. Archiving a career in the catalog stops it being
   * recommended, but its knowledge entry would stay in the index — so the assistant could still
   * describe, price and advise on a career the school has deliberately withdrawn, citing an entry
   * that this system generated. Archiving is the right disposal because it is what the rest of
   * §13.7 does: the vectors leave the index, the rows stay for provenance.
   *
   * The sync visits only *active* rows, so anything with an entry and no longer in that set is
   * exactly what has to go — archived, soft-deleted, or hard-deleted alike.
   */
  const live = new Set([
    ...careerRows.map((career) => `career:${career.id}`),
    ...programRows.map((program) => `program:${program.id}`),
    ...collegeRows.map((college) => `college:${college.id}`),
  ]);

  let retired = 0;

  for (const entry of existingEntries.filter((row) => row.archivedAt === null)) {
    if (entry.entityType === null || entry.entityId === null) {
      continue;
    }

    if (!live.has(`${entry.entityType}:${entry.entityId}`)) {
      /**
       * Per entry, not per run. Archiving touches Vectorize, and a single unreachable delete must
       * not abandon the rest of the retirement pass — still less take the *sync* down with it,
       * since this function's contract is that a cron never sees an exception. A failed retirement
       * is retried on the next run for free: the entry is still there, and its subject is still
       * gone.
       */
      try {
        await ingestion.archiveAs(uploadedBy, entry.id, null);
        retired += 1;
      } catch (error) {
        log('error', 'catalog_knowledge.retire_failed', {
          pipeline: 'knowledge_ingestion',
          stage: 'catalog_retire_failed',
          document_id: entry.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  const total = careerRows.length + programRows.length + collegeRows.length;

  log('info', 'catalog_knowledge.synced', {
    pipeline: 'knowledge_ingestion',
    stage: 'catalog_synced',
    careers: careerRows.length,
    programs: programRows.length,
    colleges: collegeRows.length,
    changed,
    retired,
    remaining,
  });

  return { total, changed, retired, remaining };
}

/** Push onto a keyed list, creating it on first use. */
function appendTo(map: Map<string, string[]>, key: string, value: string): void {
  const existing = map.get(key);

  if (existing === undefined) {
    map.set(key, [value]);

    return;
  }

  existing.push(value);
}

/** Hex SHA-256 of the composed passage — the stored "has this changed?" answer (migration 0024). */
export async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));

  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** The earliest active admin — a real, checkable owner for cron-generated rows. */
export async function firstAdminId(db: Database): Promise<string | undefined> {
  const [admin] = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.role, 'admin'), eq(users.status, 'active')))
    .orderBy(asc(users.createdAt), asc(users.id))
    .limit(1);

  return admin?.id;
}
