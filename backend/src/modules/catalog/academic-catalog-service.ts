import { and, asc, count, eq, inArray, isNull, ne, sql } from 'drizzle-orm';

import type { Database } from '@/db/client';
import {
  barangays,
  careers,
  colleges,
  employmentOutlooks,
  programCareers,
  programs,
  provinces,
  regions,
  towns,
  type Career,
  type College,
  type EmploymentOutlook,
  type Program,
  type User,
} from '@/db/schema';
import { uuid } from '@/lib/crypto';
import { now } from '@/lib/datetime';
import { isUniqueViolation } from '@/lib/db-errors';
import { ApiError, paginate, type PaginatedData } from '@/lib/envelope';
import type {
  CreateCareerInput,
  CreateCollegeInput,
  CreateProgramInput,
  UpdateCareerInput,
  UpdateCollegeInput,
  UpdateProgramInput,
} from '@/modules/catalog/schemas';
import { AuditService } from '@/modules/platform/audit-service';

/**
 * The academic catalog (FULLPLAN §13.3, §20) — colleges, programs, careers, and the mapping
 * between the last two.
 *
 * **There is no CatalogPolicy, deliberately** (§39 names three policies and no catalog one).
 * A college belongs to nobody: this is global reference data, and `role:admin` is the entire
 * rule. A policy here would be six methods of `return user.role === 'admin'`, restating what
 * the route already guarantees. The consequence is worth stating plainly, because it is the
 * reason the authorization-matrix test is load-bearing rather than belt-and-braces: **the
 * route group is the only thing standing between a new catalog endpoint and a counselor who
 * can edit the catalog.** There is no second net.
 */

const MODULE = 'AcademicCatalog';

/** One resolved place in a college's address — the id the form needs, and the name a human reads. */
export interface ResolvedPlace {
  id: string;
  name: string;
}

/**
 * A college's school address, resolved from its four FKs to displayable names (migration 0012).
 * Each level is independently nullable: a college may record its region and province but not yet its
 * town. Built by `resolveLocations` in one batch per level, never one query per college.
 */
export interface ResolvedLocation {
  region: ResolvedPlace | null;
  province: ResolvedPlace | null;
  town: ResolvedPlace | null;
  barangay: ResolvedPlace | null;
}

/** The address ids as they arrive from the schema — optional (leave), null (clear), or an id (set). */
interface AddressInput {
  region_id?: string | null | undefined;
  province_id?: string | null | undefined;
  town_id?: string | null | undefined;
  barangay_id?: string | null | undefined;
}

export class AcademicCatalogService {
  private readonly audit: AuditService;

  constructor(private readonly db: Database) {
    this.audit = new AuditService(db);
  }

  // --- Colleges ------------------------------------------------------------------------

  /** Each item carries `programs_count`, not the programs themselves (§20). */
  async listColleges(
    page: number,
    perPage: number,
  ): Promise<PaginatedData<{ college: College; programsCount: number }>> {
    const scope = isNull(colleges.deletedAt);

    const [total] = await this.db.select({ value: count() }).from(colleges).where(scope);

    const rows = await this.db
      .select()
      .from(colleges)
      .where(scope)
      .orderBy(asc(colleges.name))
      .limit(perPage)
      .offset((page - 1) * perPage);

    const counts = await this.programCounts(rows.map((row) => row.id));

    const items = rows.map((college) => ({
      college,
      programsCount: counts.get(college.id) ?? 0,
    }));

    return paginate(items, total?.value ?? 0, page, perPage);
  }

  async findCollege(id: string): Promise<College> {
    const college = await this.db.query.colleges.findFirst({ where: eq(colleges.id, id) });

    if (college?.deletedAt !== null) {
      throw ApiError.notFound('College not found.');
    }

    return college;
  }

  async createCollege(
    user: User,
    input: CreateCollegeInput,
    ipAddress: string | null,
  ): Promise<College> {
    await this.assertCollegeNameFree(input.name);

    const address = await this.validateCollegeAddress(input);

    const timestamp = now();

    const college: College = {
      id: uuid(),
      name: input.name,
      description: input.description ?? null,
      // Always `active`. Archiving is an explicit PATCH, not something a create does quietly.
      status: 'active',
      regionId: address.regionId,
      provinceId: address.provinceId,
      townId: address.townId,
      barangayId: address.barangayId,
      mapLink: input.map_link ?? null,
      createdAt: timestamp,
      updatedAt: timestamp,
      deletedAt: null,
    };

    // NB: `colleges.name` carries a plain index, not a UNIQUE one (migration 0004), so the
    // `assertCollegeNameFree` pre-check is the *only* uniqueness guard — a genuinely concurrent
    // create would produce a duplicate row rather than a constraint 500. Nothing to translate
    // here (H4 applies only where the DB enforces the invariant); see the audit note.
    await this.db.insert(colleges).values(college);

    await this.audit.write({
      action: 'COLLEGE_CREATED',
      module: MODULE,
      userId: user.id,
      targetType: 'college',
      targetId: college.id,
      newValues: { name: college.name },
      ipAddress,
    });

    return college;
  }

  async updateCollege(
    user: User,
    id: string,
    input: UpdateCollegeInput,
    ipAddress: string | null,
  ): Promise<College> {
    const existing = await this.findCollege(id);

    if (input.name !== undefined) {
      await this.assertCollegeNameFree(input.name, existing.id);
    }

    // The address is edited as a **unit**: an admin who touches any level re-submits the whole
    // chain (the cascading dropdowns clear their children when a parent changes), so a partial
    // update would leave an orphaned town under a region that no longer contains it. If none of the
    // four keys is present, the address is left exactly as it was.
    const addressTouched =
      input.region_id !== undefined ||
      input.province_id !== undefined ||
      input.town_id !== undefined ||
      input.barangay_id !== undefined;

    const address = addressTouched ? await this.validateCollegeAddress(input) : null;

    const changes = {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.status !== undefined ? { status: input.status } : {}),
      ...(address !== null
        ? {
            regionId: address.regionId,
            provinceId: address.provinceId,
            townId: address.townId,
            barangayId: address.barangayId,
          }
        : {}),
      ...(input.map_link !== undefined ? { mapLink: input.map_link } : {}),
      updatedAt: now(),
    };

    await this.db.update(colleges).set(changes).where(eq(colleges.id, existing.id));

    await this.audit.write({
      action: 'COLLEGE_UPDATED',
      module: MODULE,
      userId: user.id,
      targetType: 'college',
      targetId: existing.id,
      oldValues: { name: existing.name, status: existing.status },
      newValues: { ...input },
      ipAddress,
    });

    return { ...existing, ...changes };
  }

  /**
   * Soft delete (§12), **cascading to the college's programs in the same act**.
   *
   * Without the cascade a program whose college is deleted is *unreachable but alive*: the
   * college 404s so nothing can ever list the program again, while `PATCH /programs/{id}`
   * still edits it happily — and it was still being handed to the recommendation engine,
   * whose college join would resolve to nothing. A college and its programs are one unit.
   *
   * D1 has no interactive transactions, so atomicity comes from `db.batch()`, which runs both
   * statements in one implicit transaction. A half-cascaded delete is exactly the state this
   * must never leave behind.
   *
   * To retire a college while keeping it visible — which §8's archive-don't-delete rule says
   * an admin almost always wants — `PATCH {"status": "archived"}` instead.
   */
  async removeCollege(user: User, id: string, ipAddress: string | null): Promise<void> {
    const existing = await this.findCollege(id);
    const timestamp = now();

    await this.db.batch([
      this.db
        .update(colleges)
        .set({ deletedAt: timestamp, updatedAt: timestamp })
        .where(eq(colleges.id, existing.id)),
      this.db
        .update(programs)
        .set({ deletedAt: timestamp, updatedAt: timestamp })
        .where(and(eq(programs.collegeId, existing.id), isNull(programs.deletedAt))),
    ]);

    await this.audit.write({
      action: 'COLLEGE_DELETED',
      module: MODULE,
      userId: user.id,
      targetType: 'college',
      targetId: existing.id,
      oldValues: { name: existing.name },
      ipAddress,
    });
  }

  // --- Programs ------------------------------------------------------------------------

  /** Unpaginated (§20) — one institution's program list is tens of rows, not thousands. */
  async listPrograms(collegeId: string): Promise<{ program: Program; careers: Career[] }[]> {
    await this.findCollege(collegeId);

    const rows = await this.db
      .select()
      .from(programs)
      .where(and(eq(programs.collegeId, collegeId), isNull(programs.deletedAt)))
      .orderBy(asc(programs.code));

    const mapping = await this.careersFor(rows.map((row) => row.id));

    return rows.map((program) => ({
      program,
      careers: mapping.get(program.id) ?? [],
    }));
  }

  async findProgram(id: string): Promise<Program> {
    const program = await this.db.query.programs.findFirst({ where: eq(programs.id, id) });

    if (program?.deletedAt !== null) {
      throw ApiError.notFound('Program not found.');
    }

    return program;
  }

  async createProgram(
    user: User,
    collegeId: string,
    input: CreateProgramInput,
    ipAddress: string | null,
  ): Promise<Program> {
    const college = await this.findCollege(collegeId);

    await this.assertProgramCodeFree(college.id, input.code);

    const timestamp = now();

    const program: Program = {
      id: uuid(),
      // From the route, never the body — a program cannot be moved between institutions.
      collegeId: college.id,
      code: input.code,
      name: input.name,
      departmentName: input.department_name ?? null,
      description: input.description ?? null,
      recommendedStrand: input.recommended_strand ?? null,
      status: input.status ?? 'active',
      createdAt: timestamp,
      updatedAt: timestamp,
      deletedAt: null,
    };

    // Like `colleges.name`, `programs (college_id, code)` is a plain index, not UNIQUE (migration
    // 0004): the pre-check is the only guard, and a race yields a duplicate rather than a 500.
    await this.db.insert(programs).values(program);

    await this.audit.write({
      action: 'PROGRAM_CREATED',
      module: MODULE,
      userId: user.id,
      targetType: 'program',
      targetId: program.id,
      newValues: { college_id: college.id, code: program.code, name: program.name },
      ipAddress,
    });

    return program;
  }

  async updateProgram(
    user: User,
    id: string,
    input: UpdateProgramInput,
    ipAddress: string | null,
  ): Promise<Program> {
    const existing = await this.findProgram(id);

    if (input.code !== undefined && input.code !== existing.code) {
      await this.assertProgramCodeFree(existing.collegeId, input.code, existing.id);
    }

    const changes = {
      ...(input.code !== undefined ? { code: input.code } : {}),
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.department_name !== undefined ? { departmentName: input.department_name } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.recommended_strand !== undefined
        ? { recommendedStrand: input.recommended_strand }
        : {}),
      ...(input.status !== undefined ? { status: input.status } : {}),
      updatedAt: now(),
    };

    await this.db.update(programs).set(changes).where(eq(programs.id, existing.id));

    await this.audit.write({
      action: 'PROGRAM_UPDATED',
      module: MODULE,
      userId: user.id,
      targetType: 'program',
      targetId: existing.id,
      oldValues: { code: existing.code, status: existing.status },
      newValues: { ...input },
      ipAddress,
    });

    return { ...existing, ...changes };
  }

  async removeProgram(user: User, id: string, ipAddress: string | null): Promise<void> {
    const existing = await this.findProgram(id);
    const timestamp = now();

    await this.db
      .update(programs)
      .set({ deletedAt: timestamp, updatedAt: timestamp })
      .where(eq(programs.id, existing.id));

    await this.audit.write({
      action: 'PROGRAM_DELETED',
      module: MODULE,
      userId: user.id,
      targetType: 'program',
      targetId: existing.id,
      oldValues: { code: existing.code, name: existing.name },
      ipAddress,
    });
  }

  // --- Careers -------------------------------------------------------------------------

  async listCareers(page: number, perPage: number): Promise<PaginatedData<Career>> {
    const scope = isNull(careers.deletedAt);

    const [total] = await this.db.select({ value: count() }).from(careers).where(scope);

    const items = await this.db
      .select()
      .from(careers)
      .where(scope)
      .orderBy(asc(careers.title))
      .limit(perPage)
      .offset((page - 1) * perPage);

    return paginate(items, total?.value ?? 0, page, perPage);
  }

  async findCareer(id: string): Promise<Career> {
    const career = await this.db.query.careers.findFirst({ where: eq(careers.id, id) });

    if (career?.deletedAt !== null) {
      throw ApiError.notFound('Career not found.');
    }

    return career;
  }

  async createCareer(
    user: User,
    input: CreateCareerInput,
    ipAddress: string | null,
  ): Promise<Career> {
    await this.assertCareerTitleFree(input.title);
    await this.assertOutlookExists(input.employment_outlook_id ?? null);

    const timestamp = now();

    const career: Career = {
      id: uuid(),
      title: input.title,
      description: input.description ?? null,
      // Two numbers, not a string (migration 0013). The schema has already checked `min < max` and
      // positivity; both are present or both absent.
      salaryMin: input.salary_min ?? null,
      salaryMax: input.salary_max ?? null,
      employmentOutlookId: input.employment_outlook_id ?? null,
      // Already validated *and* normalized to canonical uppercase by the schema (§13.3).
      typicalRiasecCode: input.typical_riasec_code,
      status: 'active',
      createdAt: timestamp,
      updatedAt: timestamp,
      deletedAt: null,
    };

    await this.db.insert(careers).values(career);

    await this.audit.write({
      action: 'CAREER_CREATED',
      module: MODULE,
      userId: user.id,
      targetType: 'career',
      targetId: career.id,
      newValues: { title: career.title, typical_riasec_code: career.typicalRiasecCode },
      ipAddress,
    });

    return career;
  }

  async updateCareer(
    user: User,
    id: string,
    input: UpdateCareerInput,
    ipAddress: string | null,
  ): Promise<Career> {
    const existing = await this.findCareer(id);

    if (input.title !== undefined) {
      await this.assertCareerTitleFree(input.title, existing.id);
    }

    if (input.employment_outlook_id !== undefined) {
      await this.assertOutlookExists(input.employment_outlook_id);
    }

    const changes = {
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.salary_min !== undefined ? { salaryMin: input.salary_min } : {}),
      ...(input.salary_max !== undefined ? { salaryMax: input.salary_max } : {}),
      ...(input.employment_outlook_id !== undefined
        ? { employmentOutlookId: input.employment_outlook_id }
        : {}),
      ...(input.typical_riasec_code !== undefined
        ? { typicalRiasecCode: input.typical_riasec_code }
        : {}),
      ...(input.status !== undefined ? { status: input.status } : {}),
      updatedAt: now(),
    };

    await this.db.update(careers).set(changes).where(eq(careers.id, existing.id));

    // Archiving a career shifts the score of every program linked to it (§27 drops it from
    // the RIASEC average). That is intended, not a side effect — and it is why the change is
    // audited with both the old and the new status rather than just recorded as an edit.
    await this.audit.write({
      action: 'CAREER_UPDATED',
      module: MODULE,
      userId: user.id,
      targetType: 'career',
      targetId: existing.id,
      oldValues: { title: existing.title, status: existing.status },
      newValues: { ...input },
      ipAddress,
    });

    return { ...existing, ...changes };
  }

  async removeCareer(user: User, id: string, ipAddress: string | null): Promise<void> {
    const existing = await this.findCareer(id);
    const timestamp = now();

    await this.db
      .update(careers)
      .set({ deletedAt: timestamp, updatedAt: timestamp })
      .where(eq(careers.id, existing.id));

    await this.audit.write({
      action: 'CAREER_DELETED',
      module: MODULE,
      userId: user.id,
      targetType: 'career',
      targetId: existing.id,
      oldValues: { title: existing.title },
      ipAddress,
    });
  }

  // --- The program ↔ career mapping ----------------------------------------------------

  /**
   * Link a career to a program.
   *
   * This is the part Phase 4 actually reads, so the invariants here are *scoring* invariants,
   * not bookkeeping ones: §27 averages `riasec_compatibility` over every career linked to a
   * program, so a duplicate link is a career voting twice and a bent score.
   */
  async attachCareer(
    user: User,
    programId: string,
    careerId: string,
    ipAddress: string | null,
  ): Promise<{ program: Program; careers: Career[] }> {
    const program = await this.findProgram(programId);

    const career = await this.db.query.careers.findFirst({ where: eq(careers.id, careerId) });

    // A soft-deleted **or archived** career cannot be newly linked: the mapping row would be
    // inert on the day it was made, since §27 drops archived careers from the average. The
    // two cases share one message — an admin does not need to know which it was, and a
    // "deleted" vs "archived" distinction here would only leak the state of a row they can
    // no longer see.
    if (career?.deletedAt !== null || career.status !== 'active') {
      throw ApiError.validation({
        career_id: ['That career is not in the catalog, or has been archived.'],
      });
    }

    const duplicate = await this.db.query.programCareers.findFirst({
      where: and(
        eq(programCareers.programId, program.id),
        eq(programCareers.careerId, career.id),
      ),
    });

    if (duplicate) {
      throw this.alreadyLinked(career);
    }

    try {
      await this.db.insert(programCareers).values({
        id: uuid(),
        programId: program.id,
        careerId: career.id,
      });
    } catch (error) {
      // The pre-check above is a *race*: two concurrent requests can both find nothing and
      // both insert. The unique index is what actually guarantees the set semantics, and the
      // loser of that race arrives here — as a constraint violation that must surface as the
      // same 422 the pre-check would have given, not as a 500.
      if (isUniqueViolation(error)) {
        throw this.alreadyLinked(career);
      }

      throw error;
    }

    await this.audit.write({
      action: 'PROGRAM_CAREER_LINKED',
      module: MODULE,
      userId: user.id,
      targetType: 'program',
      targetId: program.id,
      newValues: { career_id: career.id, career_title: career.title },
      ipAddress,
    });

    return { program, careers: await this.careersForProgram(program.id) };
  }

  /**
   * Unlink a career from a program — a **real** delete, not a soft one.
   *
   * The join row records no event that anyone lived through (it is not `class_students`, an
   * enrollment a real student experienced), and both sides of it survive untouched.
   */
  async detachCareer(
    user: User,
    programId: string,
    careerId: string,
    ipAddress: string | null,
  ): Promise<{ program: Program; careers: Career[] }> {
    const program = await this.findProgram(programId);

    const link = await this.db.query.programCareers.findFirst({
      where: and(
        eq(programCareers.programId, program.id),
        eq(programCareers.careerId, careerId),
      ),
    });

    if (!link) {
      throw ApiError.notFound('That career is not linked to this program.');
    }

    await this.db.delete(programCareers).where(eq(programCareers.id, link.id));

    await this.audit.write({
      action: 'PROGRAM_CAREER_UNLINKED',
      module: MODULE,
      userId: user.id,
      targetType: 'program',
      targetId: program.id,
      oldValues: { career_id: careerId },
      ipAddress,
    });

    return { program, careers: await this.careersForProgram(program.id) };
  }

  // --- The Phase 4 read path -----------------------------------------------------------

  /**
   * The programs §27 may rank — **the single place recommendability is decided**, and Phase 4
   * is meant to ask nothing else.
   *
   * Recommendability is a property of the *chain*, not of the program row: an `active`
   * program under an `archived` college would otherwise be recommended at an institution the
   * admin has retired, and `programs.status` says nothing about whether the college still
   * offers it.
   */
  async rankablePrograms(): Promise<{ program: Program; college: College }[]> {
    const rows = await this.db
      .select({ program: programs, college: colleges })
      .from(programs)
      .innerJoin(colleges, eq(programs.collegeId, colleges.id))
      .where(
        and(
          eq(programs.status, 'active'),
          isNull(programs.deletedAt),
          eq(colleges.status, 'active'),
          isNull(colleges.deletedAt),
        ),
      );

    return rows;
  }

  /**
   * The unauthenticated `GET /programs/public` read (§20, Phase 6): the same active-chain
   * rule as `rankablePrograms` — what the engine would recommend is what the public may
   * browse — grouped by college for display, both levels alphabetical.
   */
  async publicCatalog(): Promise<{ college: College; programs: Program[] }[]> {
    const rows = await this.db
      .select({ program: programs, college: colleges })
      .from(programs)
      .innerJoin(colleges, eq(programs.collegeId, colleges.id))
      .where(
        and(
          eq(programs.status, 'active'),
          isNull(programs.deletedAt),
          eq(colleges.status, 'active'),
          isNull(colleges.deletedAt),
        ),
      )
      .orderBy(asc(colleges.name), asc(programs.name));

    const grouped = new Map<string, { college: College; programs: Program[] }>();

    for (const row of rows) {
      const entry = grouped.get(row.college.id) ?? { college: row.college, programs: [] };
      entry.programs.push(row.program);
      grouped.set(row.college.id, entry);
    }

    return [...grouped.values()];
  }

  /**
   * The careers that count toward a program's §27 RIASEC average: linked, live, and
   * **`active`**.
   *
   * FULLPLAN is genuinely silent here — §27 says "for every ACTIVE career" when ranking career
   * matches but "over all careers linked to this program" for the program score, and never
   * reconciles the two. Resolved in favour of §8's archive-don't-delete semantics: archiving
   * means "stop recommending this", so a career that is no longer recommended on its own must
   * not keep voting on the score of every program linked to it.
   *
   * A program whose careers are all archived is therefore indistinguishable from an unmapped
   * one, and takes §27's neutral 50 — rather than an average over nothing.
   */
  async scorableCareersFor(programId: string): Promise<Career[]> {
    const rows = await this.db
      .select({ career: careers })
      .from(programCareers)
      .innerJoin(careers, eq(programCareers.careerId, careers.id))
      .where(
        and(
          eq(programCareers.programId, programId),
          eq(careers.status, 'active'),
          isNull(careers.deletedAt),
        ),
      );

    return rows.map((row) => row.career);
  }

  // --- Address & employment outlook (migrations 0012, 0013) ----------------------------

  /** The employment-outlook lookup that populates the careers dropdown, in display order. */
  async listEmploymentOutlooks(): Promise<EmploymentOutlook[]> {
    return this.db
      .select()
      .from(employmentOutlooks)
      .orderBy(asc(employmentOutlooks.displayOrder), asc(employmentOutlooks.name));
  }

  /**
   * Every outlook keyed by id — one query for the whole (four-row) table, so serializing a page of
   * careers resolves each one's outlook name from memory rather than with a query per career (§20).
   */
  async outlooksById(): Promise<Map<string, EmploymentOutlook>> {
    const rows = await this.listEmploymentOutlooks();

    return new Map(rows.map((row) => [row.id, row]));
  }

  /**
   * Resolve each college's four address FKs to displayable `{ id, name }` places — **one query per
   * level for the whole list**, never one per college (§20's N+1 rule; the same shape as
   * `careersFor`/`programCounts`). A soft-deleted place is still resolved here: the college genuinely
   * still sits there, and only *setting* a new address (`validateCollegeAddress`) requires a live row.
   */
  async resolveLocations(list: College[]): Promise<Map<string, ResolvedLocation>> {
    const distinct = (pick: (college: College) => string | null): string[] => [
      ...new Set(list.map(pick).filter((value): value is string => value !== null)),
    ];

    const regionIds = distinct((college) => college.regionId);
    const provinceIds = distinct((college) => college.provinceId);
    const townIds = distinct((college) => college.townId);
    const barangayIds = distinct((college) => college.barangayId);

    const [regionRows, provinceRows, townRows, barangayRows] = await Promise.all([
      regionIds.length
        ? this.db.select({ id: regions.id, name: regions.name }).from(regions).where(inArray(regions.id, regionIds))
        : Promise.resolve([] as ResolvedPlace[]),
      provinceIds.length
        ? this.db.select({ id: provinces.id, name: provinces.name }).from(provinces).where(inArray(provinces.id, provinceIds))
        : Promise.resolve([] as ResolvedPlace[]),
      townIds.length
        ? this.db.select({ id: towns.id, name: towns.name }).from(towns).where(inArray(towns.id, townIds))
        : Promise.resolve([] as ResolvedPlace[]),
      barangayIds.length
        ? this.db.select({ id: barangays.id, name: barangays.name }).from(barangays).where(inArray(barangays.id, barangayIds))
        : Promise.resolve([] as ResolvedPlace[]),
    ]);

    const toMap = (rows: ResolvedPlace[]) => new Map(rows.map((row) => [row.id, row]));
    const regionMap = toMap(regionRows);
    const provinceMap = toMap(provinceRows);
    const townMap = toMap(townRows);
    const barangayMap = toMap(barangayRows);

    const located = new Map<string, ResolvedLocation>();

    for (const college of list) {
      located.set(college.id, {
        region: college.regionId ? (regionMap.get(college.regionId) ?? null) : null,
        province: college.provinceId ? (provinceMap.get(college.provinceId) ?? null) : null,
        town: college.townId ? (townMap.get(college.townId) ?? null) : null,
        barangay: college.barangayId ? (barangayMap.get(college.barangayId) ?? null) : null,
      });
    }

    return located;
  }

  /** One college's resolved address — the single-row form of `resolveLocations`. */
  async resolveLocation(college: College): Promise<ResolvedLocation> {
    const located = await this.resolveLocations([college]);

    return located.get(college.id)!;
  }

  /**
   * Validate a school-address chain (migration 0012). The chain must be **contiguous** (no province
   * without its region) and **correctly parented** (the chosen province actually belongs to the
   * chosen region), and every id must name a **live** row. Returns the four ids normalised to
   * `regionId`/… so the caller can drop them straight onto the college row.
   *
   * Only a live-row lookup can answer parentage, which is why this is a Service rule rather than a
   * schema one — the same reason the catalog's uniqueness checks live here. Errors are keyed by
   * field so the cascading dropdowns can point at the level that is wrong.
   */
  private async validateCollegeAddress(
    input: AddressInput,
  ): Promise<{
    regionId: string | null;
    provinceId: string | null;
    townId: string | null;
    barangayId: string | null;
  }> {
    const regionId = input.region_id ?? null;
    const provinceId = input.province_id ?? null;
    const townId = input.town_id ?? null;
    const barangayId = input.barangay_id ?? null;

    // Contiguity first — a child without its parent is a form the dropdowns should never submit, and
    // reporting it before any lookup keeps the messages precise.
    const gaps: Record<string, string[]> = {};
    if (provinceId && !regionId) gaps.region_id = ['Select a region first.'];
    if (townId && !provinceId) gaps.province_id = ['Select a province first.'];
    if (barangayId && !townId) gaps.town_id = ['Select a town or municipality first.'];
    if (Object.keys(gaps).length > 0) {
      throw ApiError.validation(gaps);
    }

    const errors: Record<string, string[]> = {};

    if (regionId) {
      const region = await this.db.query.regions.findFirst({ where: eq(regions.id, regionId) });
      if (region?.deletedAt !== null) {
        errors.region_id = ['That region is no longer available.'];
      }
    }

    if (provinceId) {
      const province = await this.db.query.provinces.findFirst({
        where: eq(provinces.id, provinceId),
      });
      if (province?.deletedAt !== null) {
        errors.province_id = ['That province is no longer available.'];
      } else if (regionId && province.regionId !== regionId) {
        errors.province_id = ['That province is not in the selected region.'];
      }
    }

    if (townId) {
      const town = await this.db.query.towns.findFirst({ where: eq(towns.id, townId) });
      if (town?.deletedAt !== null) {
        errors.town_id = ['That town or municipality is no longer available.'];
      } else if (provinceId && town.provinceId !== provinceId) {
        errors.town_id = ['That town or municipality is not in the selected province.'];
      }
    }

    if (barangayId) {
      const barangay = await this.db.query.barangays.findFirst({
        where: eq(barangays.id, barangayId),
      });
      if (barangay?.deletedAt !== null) {
        errors.barangay_id = ['That barangay is no longer available.'];
      } else if (townId && barangay.townId !== townId) {
        errors.barangay_id = ['That barangay is not in the selected town or municipality.'];
      }
    }

    if (Object.keys(errors).length > 0) {
      throw ApiError.validation(errors);
    }

    return { regionId, provinceId, townId, barangayId };
  }

  /** A non-null employment-outlook id must name a real row; `null` (no outlook) is always valid. */
  private async assertOutlookExists(id: string | null): Promise<void> {
    if (id === null) {
      return;
    }

    const found = await this.db.query.employmentOutlooks.findFirst({
      where: eq(employmentOutlooks.id, id),
    });

    if (!found) {
      throw ApiError.validation({
        employment_outlook_id: ['That employment outlook is not available.'],
      });
    }
  }

  // --- internals -----------------------------------------------------------------------

  /**
   * Every career linked to a program, **archived ones included** — this is the admin's view,
   * not the scorer's. Archiving is not unlinking: the chip stays, struck through, so restoring
   * the career brings its vote back rather than asking the admin to re-link it by hand.
   * `scorableCareersFor()` is the one that drops them.
   */
  private async careersForProgram(programId: string): Promise<Career[]> {
    const mapping = await this.careersFor([programId]);

    return mapping.get(programId) ?? [];
  }

  /**
   * `scorableCareersFor`, but for every program at once — **one query, not N** (§27, Phase 4).
   *
   * `RecommendationService` ranks the *entire* catalog on every generation, so calling the
   * single-program version in a loop meant one D1 round trip per program. That is a textbook N+1,
   * and on Cloudflare it is not merely slow: a Worker has a hard **subrequest limit** per request,
   * D1 queries count against it, and generation runs inside the student's `submit()` — which has
   * already spent its own budget scoring the attempt. Miniflare enforces no such limit, so the
   * loop passed 390 local tests and then silently generated **nothing** on the deployed Worker:
   * the listener threw, `dispatch()` swallowed it (correctly — a recommendation failure must not
   * fail a submitted assessment), and the student got a scored result and an empty
   * recommendations screen.
   *
   * Same rule as the single-program version: linked, live, and `active`. Archiving a career is
   * "stop recommending this", so it stops voting on the RIASEC average of every program it touches.
   */
  async scorableCareersForMany(programIds: string[]): Promise<Map<string, Career[]>> {
    const mapping = new Map<string, Career[]>();

    if (programIds.length === 0) {
      return mapping;
    }

    const rows = await this.db
      .select({ programId: programCareers.programId, career: careers })
      .from(programCareers)
      .innerJoin(careers, eq(programCareers.careerId, careers.id))
      .where(
        and(
          inArray(programCareers.programId, programIds),
          eq(careers.status, 'active'),
          isNull(careers.deletedAt),
        ),
      );

    for (const row of rows) {
      const list = mapping.get(row.programId) ?? [];
      list.push(row.career);
      mapping.set(row.programId, list);
    }

    return mapping;
  }

  /** One query for N programs — the nested college view would otherwise be N+1. */
  private async careersFor(programIds: string[]): Promise<Map<string, Career[]>> {
    const mapping = new Map<string, Career[]>();

    if (programIds.length === 0) {
      return mapping;
    }

    const rows = await this.db
      .select({ programId: programCareers.programId, career: careers })
      .from(programCareers)
      .innerJoin(careers, eq(programCareers.careerId, careers.id))
      .where(and(inArray(programCareers.programId, programIds), isNull(careers.deletedAt)))
      .orderBy(asc(careers.title));

    for (const row of rows) {
      const list = mapping.get(row.programId) ?? [];
      list.push(row.career);
      mapping.set(row.programId, list);
    }

    return mapping;
  }

  private async programCounts(collegeIds: string[]): Promise<Map<string, number>> {
    const counts = new Map<string, number>();

    if (collegeIds.length === 0) {
      return counts;
    }

    const rows = await this.db
      .select({ collegeId: programs.collegeId, value: count() })
      .from(programs)
      .where(and(inArray(programs.collegeId, collegeIds), isNull(programs.deletedAt)))
      .groupBy(programs.collegeId);

    for (const row of rows) {
      counts.set(row.collegeId, row.value);
    }

    return counts;
  }

  /**
   * Uniqueness is checked against **live rows only**, and case-insensitively.
   *
   * Live-only because these tables are soft-deleted (§12): a DB-level unique index would let
   * one deleted "University of Santo Tomas" permanently block anyone from ever adding the
   * real one. Case-insensitively because the whole reason `colleges` was promoted out of a
   * text column in v1.1 was naming drift — and "University of Santo Tomas" alongside
   * "university of santo tomas" is exactly that drift, one row apart.
   */
  private async assertCollegeNameFree(name: string, exceptId?: string): Promise<void> {
    const clash = await this.db
      .select({ id: colleges.id })
      .from(colleges)
      .where(
        and(
          sql`lower(${colleges.name}) = lower(${name})`,
          isNull(colleges.deletedAt),
          ...(exceptId ? [ne(colleges.id, exceptId)] : []),
        ),
      )
      .limit(1);

    if (clash.length > 0) {
      throw ApiError.validation({
        name: ['A college with this name is already in the catalog.'],
      });
    }
  }

  /** Scoped to the college, not global: "BSCS" at UP and at DLSU are different programs. */
  private async assertProgramCodeFree(
    collegeId: string,
    code: string,
    exceptId?: string,
  ): Promise<void> {
    const clash = await this.db
      .select({ id: programs.id })
      .from(programs)
      .where(
        and(
          eq(programs.collegeId, collegeId),
          // `code` is uppercased by the schema before it ever reaches here, so a plain
          // comparison is already case-insensitive in effect — see `schemas.ts`.
          eq(programs.code, code),
          isNull(programs.deletedAt),
          ...(exceptId ? [ne(programs.id, exceptId)] : []),
        ),
      )
      .limit(1);

    if (clash.length > 0) {
      throw ApiError.validation({
        code: ['This college already offers a program with that code.'],
      });
    }
  }

  private async assertCareerTitleFree(title: string, exceptId?: string): Promise<void> {
    const clash = await this.db
      .select({ id: careers.id })
      .from(careers)
      .where(
        and(
          sql`lower(${careers.title}) = lower(${title})`,
          isNull(careers.deletedAt),
          ...(exceptId ? [ne(careers.id, exceptId)] : []),
        ),
      )
      .limit(1);

    if (clash.length > 0) {
      throw ApiError.validation({
        title: ['A career with this title is already in the catalog.'],
      });
    }
  }

  private alreadyLinked(career: Career): ApiError {
    return ApiError.validation({
      career_id: [`${career.title} is already linked to this program.`],
    });
  }
}
