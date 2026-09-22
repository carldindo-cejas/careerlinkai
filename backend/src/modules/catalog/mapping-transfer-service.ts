import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';

import type { Database } from '@/db/client';
import { LINK_RELATIONSHIPS, type LinkRelationship } from '@/db/enums';
import { careers, programCatalog, programCatalogCareers, type User } from '@/db/schema';
import { uuid } from '@/lib/crypto';
import { chunkForInsert, chunkIds } from '@/lib/d1-batching';
import { ApiError } from '@/lib/envelope';
import { AuditService } from '@/modules/platform/audit-service';

/**
 * **The program → career mapping as a spreadsheet** (2026-09-22) — export it, edit it anywhere,
 * import it back.
 *
 * The canonical programs page edits one link at a time, which is right for a correction and wrong
 * for "re-grade every health program after the curriculum review". This is the bulk path, and it is
 * also the backup: an export taken before a risky change is a file that puts the mapping back.
 *
 * ## What an import means
 *
 * A file is a statement about **the programs it names, and only those**. For every program code
 * that appears, the file is that program's complete list: careers in the file and not in the
 * database are linked, careers in the database and not in the file are unlinked, and a changed
 * relationship is re-graded. A program the file does not mention is left exactly as it is — so a
 * file with three programs in it is a safe edit of three programs, not an instruction to empty the
 * other thirty-eight. A row with a program code and no career title names the program with nothing
 * in it, which is how a file says "this program leads nowhere".
 *
 * Programs and careers are matched by **code and title**, the identifiers an administrator reads,
 * never by id. Nothing is created: an unknown code or title is an error on its line, because an
 * import that minted a career from a typo would put "Sofware Developer" in front of students.
 *
 * ## Preview, then apply
 *
 * `plan` resolves and diffs without writing, and the screen shows it; `apply` re-plans against the
 * database as it is at that moment (not as it was when the preview was drawn) and refuses if any
 * line has an error. The writes go in **one `db.batch`** — one D1 transaction and one subrequest,
 * however many links move — so an import is all or nothing and fits the Free plan's budget (§45).
 */

const MODULE = 'AcademicCatalog';

/** Generous for a real catalog (216 links today) and a hard ceiling on a request body's work. */
export const MAX_IMPORT_ROWS = 2000;

export interface MappingRowInput {
  program_code: string;
  career_title: string;
  relationship: string;
}

export interface MappingExportRow {
  programCode: string;
  programName: string;
  careerTitle: string;
  careerRiasecCode: string | null;
  relationship: LinkRelationship;
}

export interface PlannedLink {
  programCode: string;
  careerTitle: string;
  relationship: LinkRelationship;
}

export interface MappingPlan {
  programsInFile: number;
  adds: PlannedLink[];
  removes: PlannedLink[];
  regrades: (PlannedLink & { from: LinkRelationship })[];
  unchanged: number;
  /** `line` is the spreadsheet line: 1 is the header, so the first data row is line 2. */
  errors: { line: number; message: string }[];
}

interface ResolvedPlan extends MappingPlan {
  inserts: {
    id: string;
    programCatalogId: string;
    careerId: string;
    relationship: LinkRelationship;
  }[];
  deleteIds: string[];
  updates: { id: string; relationship: LinkRelationship }[];
}

export class MappingTransferService {
  private readonly audit: AuditService;

  constructor(private readonly db: Database) {
    this.audit = new AuditService(db);
  }

  /** Every live canonical program's links, by program code then career title. One query. */
  async exportRows(): Promise<MappingExportRow[]> {
    const rows = await this.db
      .select({
        programCode: programCatalog.code,
        programName: programCatalog.name,
        careerTitle: careers.title,
        careerRiasecCode: careers.typicalRiasecCode,
        relationship: programCatalogCareers.relationship,
      })
      .from(programCatalogCareers)
      .innerJoin(programCatalog, eq(programCatalog.id, programCatalogCareers.programCatalogId))
      .innerJoin(careers, eq(careers.id, programCatalogCareers.careerId))
      .where(and(isNull(programCatalog.deletedAt), isNull(careers.deletedAt)))
      .orderBy(asc(programCatalog.code), asc(careers.title));

    return rows;
  }

  /** Resolve and diff, writing nothing. */
  async plan(rows: MappingRowInput[]): Promise<MappingPlan> {
    const {
      inserts: _inserts,
      deleteIds: _deleteIds,
      updates: _updates,
      ...plan
    } = await this.resolve(rows);

    return plan;
  }

  /** Re-plan against the database as it is now, refuse on any error, then write it all at once. */
  async apply(
    user: User,
    rows: MappingRowInput[],
    ipAddress: string | null,
  ): Promise<MappingPlan> {
    const resolved = await this.resolve(rows);
    const { inserts, deleteIds, updates, ...plan } = resolved;

    if (plan.errors.length > 0) {
      throw ApiError.validation(
        { rows: plan.errors.map((error) => `Line ${error.line}: ${error.message}`) },
        'The file has errors. Nothing was changed.',
      );
    }

    const statements = [
      ...chunkIds(deleteIds).map((chunk) =>
        this.db.delete(programCatalogCareers).where(inArray(programCatalogCareers.id, chunk)),
      ),
      ...chunkForInsert(inserts, programCatalogCareers).map((chunk) =>
        this.db.insert(programCatalogCareers).values(chunk),
      ),
      ...updates.map((update) =>
        this.db
          .update(programCatalogCareers)
          .set({ relationship: update.relationship })
          .where(eq(programCatalogCareers.id, update.id)),
      ),
      /*
        A college extra that now duplicates a canonical link is absorbed, as `attachCanonicalCareer`
        does for a single link — otherwise it would lie dormant and come back on that one campus if
        the canonical link were later removed. One statement for the whole catalog.
      */
      this.db.run(sql`
        DELETE FROM program_careers
        WHERE id IN (
          SELECT pc.id
          FROM program_careers pc
          JOIN programs p ON p.id = pc.program_id
          JOIN program_catalog_careers pcc
            ON pcc.program_catalog_id = p.program_catalog_id
           AND pcc.career_id = pc.career_id
        )
      `),
    ];

    const [first, ...rest] = statements;

    if (first !== undefined) {
      await this.db.batch([first, ...rest]);
    }

    await this.audit.write({
      action: 'CANONICAL_MAPPING_IMPORTED',
      module: MODULE,
      userId: user.id,
      targetType: 'program_catalog',
      targetId: null,
      newValues: {
        programs_in_file: plan.programsInFile,
        linked: plan.adds.length,
        unlinked: plan.removes.length,
        regraded: plan.regrades.length,
        unchanged: plan.unchanged,
      },
      ipAddress,
    });

    return plan;
  }

  private async resolve(rows: MappingRowInput[]): Promise<ResolvedPlan> {
    const errors: MappingPlan['errors'] = [];

    const [entries, careerRows, links] = await Promise.all([
      this.db
        .select({ id: programCatalog.id, code: programCatalog.code })
        .from(programCatalog)
        .where(isNull(programCatalog.deletedAt)),
      this.db
        .select({ id: careers.id, title: careers.title, status: careers.status })
        .from(careers)
        .where(isNull(careers.deletedAt)),
      this.db.select().from(programCatalogCareers),
    ]);

    const entryByCode = new Map(entries.map((entry) => [entry.code.toUpperCase(), entry]));
    const careerByTitle = new Map(
      careerRows.map((career) => [normalize(career.title), career]),
    );
    const careerTitleById = new Map(careerRows.map((career) => [career.id, career.title]));
    const codeById = new Map(entries.map((entry) => [entry.id, entry.code]));

    /** Per program in the file: career id → relationship, as the file states it. */
    const desired = new Map<string, Map<string, LinkRelationship>>();

    rows.forEach((row, index) => {
      const line = index + 2;
      const code = row.program_code
        .trim()
        .toUpperCase()
        .replace(/[\s\-.]/g, '');
      const title = row.career_title.trim();
      const relationship = (row.relationship.trim().toLowerCase() ||
        'direct') as LinkRelationship;

      if (code === '') {
        errors.push({ line, message: 'The program code is empty.' });
        return;
      }

      const entry = entryByCode.get(code);

      if (entry === undefined) {
        errors.push({
          line,
          message: `No canonical program has the code "${row.program_code}".`,
        });
        return;
      }

      const forProgram = desired.get(entry.id) ?? new Map<string, LinkRelationship>();
      desired.set(entry.id, forProgram);

      // A program with no career: the file says it leads nowhere. It is in scope, with nothing in it.
      if (title === '') {
        return;
      }

      if (!LINK_RELATIONSHIPS.includes(relationship)) {
        errors.push({
          line,
          message: `"${row.relationship}" is not a relationship. Use direct, related or conditional.`,
        });
        return;
      }

      const career = careerByTitle.get(normalize(title));

      if (career === undefined) {
        errors.push({ line, message: `No career is titled "${title}".` });
        return;
      }

      if (forProgram.has(career.id)) {
        errors.push({ line, message: `${career.title} is listed twice for ${entry.code}.` });
        return;
      }

      const alreadyLinked = links.some(
        (link) => link.programCatalogId === entry.id && link.careerId === career.id,
      );

      // An archived career keeps an existing link (archiving is not unlinking) but cannot gain one.
      if (career.status !== 'active' && !alreadyLinked) {
        errors.push({
          line,
          message: `${career.title} is archived and cannot be newly linked.`,
        });
        return;
      }

      forProgram.set(career.id, relationship);
    });

    const plan: ResolvedPlan = {
      programsInFile: desired.size,
      adds: [],
      removes: [],
      regrades: [],
      unchanged: 0,
      errors,
      inserts: [],
      deleteIds: [],
      updates: [],
    };

    for (const [programCatalogId, wanted] of desired) {
      const programCode = codeById.get(programCatalogId) ?? '';
      const current = links.filter((link) => link.programCatalogId === programCatalogId);

      for (const link of current) {
        const careerTitle = careerTitleById.get(link.careerId) ?? link.careerId;
        const want = wanted.get(link.careerId);

        if (want === undefined) {
          plan.removes.push({ programCode, careerTitle, relationship: link.relationship });
          plan.deleteIds.push(link.id);
        } else if (want !== link.relationship) {
          plan.regrades.push({
            programCode,
            careerTitle,
            relationship: want,
            from: link.relationship,
          });
          plan.updates.push({ id: link.id, relationship: want });
        } else {
          plan.unchanged += 1;
        }
      }

      for (const [careerId, relationship] of wanted) {
        if (current.some((link) => link.careerId === careerId)) {
          continue;
        }

        plan.adds.push({
          programCode,
          careerTitle: careerTitleById.get(careerId) ?? careerId,
          relationship,
        });
        plan.inserts.push({ id: uuid(), programCatalogId, careerId, relationship });
      }
    }

    return plan;
  }
}

/** Titles match regardless of case and spacing — the same career typed twice in a spreadsheet. */
function normalize(title: string): string {
  return title.trim().replace(/\s+/g, ' ').toLowerCase();
}
