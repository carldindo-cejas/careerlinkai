import { and, asc, count, desc, eq, inArray, isNull, like, ne, or, sql, type SQL } from 'drizzle-orm';
import type { AnySQLiteColumn, SQLiteTable } from 'drizzle-orm/sqlite-core';

import type { Database } from '@/db/client';
import {
  barangays,
  provinces,
  regions,
  towns,
  type Barangay,
  type Province,
  type Region,
  type Town,
  type User,
} from '@/db/schema';
import { uuid } from '@/lib/crypto';
import { now } from '@/lib/datetime';
import { translateUniqueViolation } from '@/lib/db-errors';
import { ApiError, paginate, type PaginatedData } from '@/lib/envelope';
import type { BulkImportInput, ListAddressQuery, UpdateAddressInput } from '@/modules/address/schemas';
import type { SerializedBulkResult } from '@/modules/address/serializers';
import type { AuditAction } from '@/modules/platform/audit-service';
import { AuditService } from '@/modules/platform/audit-service';

/**
 * The Philippine address hierarchy — Region → Province → Town → Barangay (migration 0011).
 *
 * Like the catalog (§39), there is no per-record policy: address data belongs to nobody, it is
 * global reference data, and `role:admin` is the entire rule. The route group is the only gate.
 *
 * The four levels are structurally identical — a name, an optional code, a parent, a soft-delete —
 * so their shared mechanics are written once against `AnySQLiteColumn`/`SQLiteTable` and the four
 * public surfaces name their table, parent, and row-builder. The one genuinely subtle rule,
 * "ignore duplicates," therefore lives in exactly one place: `partitionByName`.
 */

const MODULE = 'Address';

/** The shared column view every level exposes, so the generic helpers can work across all four. */
interface Level {
  table: SQLiteTable;
  id: AnySQLiteColumn;
  name: AnySQLiteColumn;
  code: AnySQLiteColumn;
  createdAt: AnySQLiteColumn;
  deletedAt: AnySQLiteColumn;
}

const REGION_LEVEL: Level = {
  table: regions,
  id: regions.id,
  name: regions.name,
  code: regions.code,
  createdAt: regions.createdAt,
  deletedAt: regions.deletedAt,
};

const PROVINCE_LEVEL: Level = {
  table: provinces,
  id: provinces.id,
  name: provinces.name,
  code: provinces.code,
  createdAt: provinces.createdAt,
  deletedAt: provinces.deletedAt,
};

const TOWN_LEVEL: Level = {
  table: towns,
  id: towns.id,
  name: towns.name,
  code: towns.code,
  createdAt: towns.createdAt,
  deletedAt: towns.deletedAt,
};

const BARANGAY_LEVEL: Level = {
  table: barangays,
  id: barangays.id,
  name: barangays.name,
  code: barangays.code,
  createdAt: barangays.createdAt,
  deletedAt: barangays.deletedAt,
};

export class AddressService {
  private readonly audit: AuditService;

  constructor(private readonly db: Database) {
    this.audit = new AuditService(db);
  }

  // --- Regions -------------------------------------------------------------------------

  async listRegions(query: ListAddressQuery): Promise<PaginatedData<Region>> {
    return this.listLevel<Region>(REGION_LEVEL, query);
  }

  async findRegion(id: string): Promise<Region> {
    const region = await this.db.query.regions.findFirst({ where: eq(regions.id, id) });

    if (region?.deletedAt !== null) {
      throw ApiError.notFound('Region not found.');
    }

    return region;
  }

  async importRegions(
    user: User,
    input: BulkImportInput,
    ipAddress: string | null,
  ): Promise<SerializedBulkResult<Region>> {
    const timestamp = now();

    return this.importLevel<Region>(REGION_LEVEL, undefined, input, 'REGIONS_BULK_IMPORTED', 'region', user, ipAddress, (item) => ({
      id: uuid(),
      code: item.code ?? null,
      name: item.name,
      createdAt: timestamp,
      updatedAt: timestamp,
      deletedAt: null,
    }));
  }

  /** Rename a region (or fix its PSGC code). Regions have no parent, so uniqueness is global. */
  async updateRegion(
    user: User,
    id: string,
    input: UpdateAddressInput,
    ipAddress: string | null,
  ): Promise<Region> {
    const existing = await this.findRegion(id);

    return this.updateLevel(
      REGION_LEVEL,
      existing,
      undefined,
      input,
      'REGION_UPDATED',
      'region',
      user,
      ipAddress,
    );
  }

  async deleteRegion(user: User, id: string, ipAddress: string | null): Promise<void> {
    const region = await this.findRegion(id);
    const timestamp = now();

    const provinceIds = await this.liveChildIds(PROVINCE_LEVEL, provinces.regionId, [region.id]);
    const townIds = await this.liveChildIds(TOWN_LEVEL, towns.provinceId, provinceIds);
    const barangayIds = await this.liveChildIds(BARANGAY_LEVEL, barangays.townId, townIds);

    await this.cascadeSoftDelete(timestamp, [
      [REGION_LEVEL, [region.id]],
      [PROVINCE_LEVEL, provinceIds],
      [TOWN_LEVEL, townIds],
      [BARANGAY_LEVEL, barangayIds],
    ]);

    await this.auditDelete(user, 'REGION_DELETED', 'region', region.id, region.name, ipAddress, {
      provinces: provinceIds.length,
      towns: townIds.length,
      barangays: barangayIds.length,
    });
  }

  // --- Provinces -----------------------------------------------------------------------

  async listProvinces(regionId: string, query: ListAddressQuery): Promise<PaginatedData<Province>> {
    await this.findRegion(regionId);

    return this.listLevel<Province>(PROVINCE_LEVEL, query, eq(provinces.regionId, regionId));
  }

  async findProvince(id: string): Promise<Province> {
    const province = await this.db.query.provinces.findFirst({ where: eq(provinces.id, id) });

    if (province?.deletedAt !== null) {
      throw ApiError.notFound('Province not found.');
    }

    return province;
  }

  async importProvinces(
    user: User,
    regionId: string,
    input: BulkImportInput,
    ipAddress: string | null,
  ): Promise<SerializedBulkResult<Province>> {
    const region = await this.findRegion(regionId);
    const timestamp = now();

    return this.importLevel<Province>(PROVINCE_LEVEL, eq(provinces.regionId, region.id), input, 'PROVINCES_BULK_IMPORTED', 'province', user, ipAddress, (item) => ({
      id: uuid(),
      regionId: region.id,
      code: item.code ?? null,
      name: item.name,
      createdAt: timestamp,
      updatedAt: timestamp,
      deletedAt: null,
    }), { region_id: region.id });
  }

  /** Rename a province. Uniqueness is scoped to its region — the same rule the bulk import uses. */
  async updateProvince(
    user: User,
    id: string,
    input: UpdateAddressInput,
    ipAddress: string | null,
  ): Promise<Province> {
    const existing = await this.findProvince(id);

    return this.updateLevel(
      PROVINCE_LEVEL,
      existing,
      eq(provinces.regionId, existing.regionId),
      input,
      'PROVINCE_UPDATED',
      'province',
      user,
      ipAddress,
    );
  }

  async deleteProvince(user: User, id: string, ipAddress: string | null): Promise<void> {
    const province = await this.findProvince(id);
    const timestamp = now();

    const townIds = await this.liveChildIds(TOWN_LEVEL, towns.provinceId, [province.id]);
    const barangayIds = await this.liveChildIds(BARANGAY_LEVEL, barangays.townId, townIds);

    await this.cascadeSoftDelete(timestamp, [
      [PROVINCE_LEVEL, [province.id]],
      [TOWN_LEVEL, townIds],
      [BARANGAY_LEVEL, barangayIds],
    ]);

    await this.auditDelete(user, 'PROVINCE_DELETED', 'province', province.id, province.name, ipAddress, {
      towns: townIds.length,
      barangays: barangayIds.length,
    });
  }

  // --- Towns ---------------------------------------------------------------------------

  async listTowns(provinceId: string, query: ListAddressQuery): Promise<PaginatedData<Town>> {
    await this.findProvince(provinceId);

    return this.listLevel<Town>(TOWN_LEVEL, query, eq(towns.provinceId, provinceId));
  }

  async findTown(id: string): Promise<Town> {
    const town = await this.db.query.towns.findFirst({ where: eq(towns.id, id) });

    if (town?.deletedAt !== null) {
      throw ApiError.notFound('Town not found.');
    }

    return town;
  }

  async importTowns(
    user: User,
    provinceId: string,
    input: BulkImportInput,
    ipAddress: string | null,
  ): Promise<SerializedBulkResult<Town>> {
    const province = await this.findProvince(provinceId);
    const timestamp = now();

    return this.importLevel<Town>(TOWN_LEVEL, eq(towns.provinceId, province.id), input, 'TOWNS_BULK_IMPORTED', 'town', user, ipAddress, (item) => ({
      id: uuid(),
      provinceId: province.id,
      code: item.code ?? null,
      name: item.name,
      createdAt: timestamp,
      updatedAt: timestamp,
      deletedAt: null,
    }), { province_id: province.id });
  }

  /** Rename a town or municipality. Uniqueness is scoped to its province. */
  async updateTown(
    user: User,
    id: string,
    input: UpdateAddressInput,
    ipAddress: string | null,
  ): Promise<Town> {
    const existing = await this.findTown(id);

    return this.updateLevel(
      TOWN_LEVEL,
      existing,
      eq(towns.provinceId, existing.provinceId),
      input,
      'TOWN_UPDATED',
      'town',
      user,
      ipAddress,
    );
  }

  async deleteTown(user: User, id: string, ipAddress: string | null): Promise<void> {
    const town = await this.findTown(id);
    const timestamp = now();

    const barangayIds = await this.liveChildIds(BARANGAY_LEVEL, barangays.townId, [town.id]);

    await this.cascadeSoftDelete(timestamp, [
      [TOWN_LEVEL, [town.id]],
      [BARANGAY_LEVEL, barangayIds],
    ]);

    await this.auditDelete(user, 'TOWN_DELETED', 'town', town.id, town.name, ipAddress, {
      barangays: barangayIds.length,
    });
  }

  // --- Barangays -----------------------------------------------------------------------

  async listBarangays(townId: string, query: ListAddressQuery): Promise<PaginatedData<Barangay>> {
    await this.findTown(townId);

    return this.listLevel<Barangay>(BARANGAY_LEVEL, query, eq(barangays.townId, townId));
  }

  async findBarangay(id: string): Promise<Barangay> {
    const barangay = await this.db.query.barangays.findFirst({ where: eq(barangays.id, id) });

    if (barangay?.deletedAt !== null) {
      throw ApiError.notFound('Barangay not found.');
    }

    return barangay;
  }

  async importBarangays(
    user: User,
    townId: string,
    input: BulkImportInput,
    ipAddress: string | null,
  ): Promise<SerializedBulkResult<Barangay>> {
    const town = await this.findTown(townId);
    const timestamp = now();

    return this.importLevel<Barangay>(BARANGAY_LEVEL, eq(barangays.townId, town.id), input, 'BARANGAYS_BULK_IMPORTED', 'barangay', user, ipAddress, (item) => ({
      id: uuid(),
      townId: town.id,
      code: item.code ?? null,
      name: item.name,
      createdAt: timestamp,
      updatedAt: timestamp,
      deletedAt: null,
    }), { town_id: town.id });
  }

  /** Rename a barangay. Uniqueness is scoped to its town or municipality. */
  async updateBarangay(
    user: User,
    id: string,
    input: UpdateAddressInput,
    ipAddress: string | null,
  ): Promise<Barangay> {
    const existing = await this.findBarangay(id);

    return this.updateLevel(
      BARANGAY_LEVEL,
      existing,
      eq(barangays.townId, existing.townId),
      input,
      'BARANGAY_UPDATED',
      'barangay',
      user,
      ipAddress,
    );
  }

  async deleteBarangay(user: User, id: string, ipAddress: string | null): Promise<void> {
    const barangay = await this.findBarangay(id);
    const timestamp = now();

    await this.cascadeSoftDelete(timestamp, [[BARANGAY_LEVEL, [barangay.id]]]);

    await this.auditDelete(user, 'BARANGAY_DELETED', 'barangay', barangay.id, barangay.name, ipAddress);
  }

  // --- Shared mechanics ----------------------------------------------------------------

  /**
   * List one level: live rows only, optionally scoped to a parent, with `search` (matched against
   * name *and* code), the allow-listed `sort`, and `page`/`per_page` pagination.
   */
  private async listLevel<TRow>(
    level: Level,
    query: ListAddressQuery,
    parentScope?: SQL,
  ): Promise<PaginatedData<TRow>> {
    const search = query.search?.trim();
    const searchScope =
      search && search.length > 0
        ? or(like(level.name, `%${search}%`), like(level.code, `%${search}%`))
        : undefined;

    const where = and(isNull(level.deletedAt), parentScope, searchScope);

    const sortColumn =
      query.sort === 'code'
        ? level.code
        : query.sort === 'created_at'
          ? level.createdAt
          : level.name;
    const order = query.direction === 'desc' ? desc(sortColumn) : asc(sortColumn);

    const [total] = await this.db.select({ value: count() }).from(level.table).where(where);

    const items = (await this.db
      .select()
      .from(level.table)
      .where(where)
      .orderBy(order)
      .limit(query.per_page)
      .offset((query.page - 1) * query.per_page)) as TRow[];

    return paginate(items, total?.value ?? 0, query.page, query.per_page);
  }

  /**
   * The bulk-import path shared by all four levels: dedupe the payload, insert the survivors, and
   * audit the batch as one act. `buildRow` is the only per-level piece — it stamps the parent id.
   */
  private async importLevel<TRow extends { id: string; name: string }>(
    level: Level,
    parentScope: SQL | undefined,
    input: BulkImportInput,
    action: AuditAction,
    targetType: string,
    user: User,
    ipAddress: string | null,
    buildRow: (item: { name: string; code?: string }) => TRow,
    auditExtra: Record<string, unknown> = {},
  ): Promise<SerializedBulkResult<TRow>> {
    const existing = (await this.db
      .select({ name: level.name })
      .from(level.table)
      .where(and(isNull(level.deletedAt), parentScope))) as { name: string }[];

    const { survivors, skipped } = partitionByName(
      input.items,
      existing.map((row) => row.name),
    );

    const rows = survivors.map(buildRow);

    if (rows.length > 0) {
      // **The insert has to be chunked, or it 500s on real D1.** A single multi-row insert binds
      // one parameter per column *per row*, and D1 caps a statement at 100 bound parameters
      // (developers.cloudflare.com/d1/platform/limits). A province/town/barangay row is seven
      // columns, so ~15 pasted places already blows past the cap — the statement is rejected and the
      // whole import fails. Miniflare enforces no such limit, which is exactly why the hermetic suite
      // never caught it: the bug only exists on the deployed Worker. `chunkForD1` splits the rows so
      // every statement stays well under the cap, and `db.batch()` runs them as one implicit
      // transaction — the same atomicity the cascade delete relies on, so a large paste is all-or-
      // nothing rather than half-imported.
      const statements = chunkForD1(rows).map((chunk) =>
        this.db.insert(level.table).values(chunk).onConflictDoNothing(),
      );

      // `onConflictDoNothing` is still the race backstop within each chunk: the dedupe above wins the
      // common case, but two admins importing the same list at once both pass it, and the partial
      // unique index is what actually holds the line. DO NOTHING lets the loser's duplicates drop
      // rather than 500.
      await this.db.batch(
        statements as [(typeof statements)[number], ...(typeof statements)[number][]],
      );

      await this.audit.write({
        action,
        module: MODULE,
        userId: user.id,
        targetType,
        newValues: { count: rows.length, names: rows.map((row) => row.name), ...auditExtra },
        ipAddress,
      });
    }

    return { created: rows, skipped };
  }

  /**
   * The edit path shared by all four levels: check the new name is free among live siblings, apply
   * the change, and audit it. The parent is never touched — `updateAddressSchema` does not carry one,
   * so a rename cannot become a re-parenting. `parentScope` is the same predicate the level's list and
   * import use, so "free" means "no other live place with this name *under the same parent*".
   */
  private async updateLevel<TRow extends Region>(
    level: Level,
    existing: TRow,
    parentScope: SQL | undefined,
    input: UpdateAddressInput,
    action: AuditAction,
    targetType: string,
    user: User,
    ipAddress: string | null,
  ): Promise<TRow> {
    await this.assertNameFree(level, input.name, parentScope, existing.id);

    const changes = { name: input.name, code: input.code, updatedAt: now() };

    try {
      await this.db.update(level.table).set(changes).where(eq(level.id, existing.id));
    } catch (error) {
      // The pre-check wins the common case; the partial unique index is the real guard, and the loser
      // of a concurrent rename race arrives here — translated to the same field-level 422 rather than
      // a raw 500 (the codebase-wide isUniqueViolation rule).
      translateUniqueViolation(error, 'name', 'A place with this name already exists here.');
    }

    await this.audit.write({
      action,
      module: MODULE,
      userId: user.id,
      targetType,
      targetId: existing.id,
      oldValues: { name: existing.name, code: existing.code },
      newValues: { name: input.name, code: input.code },
      ipAddress,
    });

    return { ...existing, ...changes };
  }

  /**
   * "No other live sibling already has this name," case-insensitively — the update-time twin of the
   * bulk import's dedupe, scoped to the same parent and excluding the row being edited so renaming a
   * place to the case-variant of its own name (or to itself) is not a false clash.
   */
  private async assertNameFree(
    level: Level,
    name: string,
    parentScope: SQL | undefined,
    exceptId: string,
  ): Promise<void> {
    const clash = await this.db
      .select({ id: level.id })
      .from(level.table)
      .where(
        and(
          sql`lower(${level.name}) = lower(${name})`,
          isNull(level.deletedAt),
          parentScope,
          ne(level.id, exceptId),
        ),
      )
      .limit(1);

    if (clash.length > 0) {
      throw ApiError.validation({
        name: ['A place with this name already exists here.'],
      });
    }
  }

  /** The live descendant ids one level down — the building block of the cascade soft-delete. */
  private async liveChildIds(
    level: Level,
    parentColumn: AnySQLiteColumn,
    parentIds: string[],
  ): Promise<string[]> {
    if (parentIds.length === 0) {
      return [];
    }

    const rows = (await this.db
      .select({ id: level.id })
      .from(level.table)
      .where(and(inArray(parentColumn, parentIds), isNull(level.deletedAt)))) as { id: string }[];

    return rows.map((row) => row.id);
  }

  /**
   * Soft-delete a whole subtree in one atomic `db.batch()` — D1 has no interactive transactions,
   * so the batch is what keeps a delete from stopping half-cascaded (0004's rule for the college →
   * program cascade, here one level deeper). Empty id-sets are skipped rather than issuing a
   * no-op UPDATE.
   */
  private async cascadeSoftDelete(
    timestamp: string,
    levels: [Level, string[]][],
  ): Promise<void> {
    const statements = levels
      .filter(([, ids]) => ids.length > 0)
      .map(([level, ids]) =>
        this.db
          .update(level.table)
          .set({ deletedAt: timestamp, updatedAt: timestamp })
          .where(inArray(level.id, ids)),
      );

    if (statements.length === 0) {
      return;
    }

    await this.db.batch(statements as [(typeof statements)[number], ...(typeof statements)[number][]]);
  }

  private async auditDelete(
    user: User,
    action: AuditAction,
    targetType: string,
    targetId: string,
    name: string,
    ipAddress: string | null,
    cascade: Record<string, number> = {},
  ): Promise<void> {
    await this.audit.write({
      action,
      module: MODULE,
      userId: user.id,
      targetType,
      targetId,
      oldValues: { name, ...cascade },
      ipAddress,
    });
  }
}

/**
 * D1 rejects any statement binding more than 100 parameters, and a multi-row insert binds one per
 * column per row. This splits a set of rows into chunks small enough that `rows × columns` stays
 * safely under that ceiling, deriving the column count from the row shape (six for a region, seven
 * for the parented levels) rather than hard-coding it per level. A conservative budget of 90 leaves
 * head-room for any future column without re-tuning, and the size is floored at one so a single wide
 * row is still emitted rather than dropped.
 *
 * Pure and table-agnostic, like `partitionByName`, so the arithmetic is unit-testable without a
 * database. The 100-parameter cap is a real, deployed-only limit — see `importLevel` for why the
 * hermetic suite never surfaced it.
 */
// D1's hard cap is 100 bound parameters per statement; 90 leaves head-room for a future column.
const D1_PARAM_BUDGET = 90;

export function chunkForD1<TRow extends object>(rows: TRow[]): TRow[][] {
  if (rows.length === 0) {
    return [];
  }

  const columnsPerRow = Math.max(1, Object.keys(rows[0]!).length);
  const maxRows = Math.max(1, Math.floor(D1_PARAM_BUDGET / columnsPerRow));

  const chunks: TRow[][] = [];
  for (let start = 0; start < rows.length; start += maxRows) {
    chunks.push(rows.slice(start, start + maxRows));
  }

  return chunks;
}

/**
 * "Ignore duplicates," as a pure function — no database, no table types, so it is trivially
 * testable. Dedupes on two axes, both case-insensitively (matching the `COLLATE NOCASE` partial
 * unique index that backstops it): within the payload (the same line pasted twice, first wins) and
 * against the names already live in this parent scope. "Manila" and "manila" are one place; the
 * second is a skip, not a second row.
 */
export function partitionByName(
  items: { name: string; code?: string }[],
  existingNames: string[],
): {
  survivors: { name: string; code?: string }[];
  skipped: { name: string; reason: 'duplicate' }[];
} {
  const seen = new Set(existingNames.map((name) => name.toLowerCase()));

  const survivors: { name: string; code?: string }[] = [];
  const skipped: { name: string; reason: 'duplicate' }[] = [];

  for (const item of items) {
    const key = item.name.toLowerCase();

    if (seen.has(key)) {
      skipped.push({ name: item.name, reason: 'duplicate' });
      continue;
    }

    seen.add(key);
    survivors.push(item);
  }

  return { survivors, skipped };
}
