/**
 * The Philippine address hierarchy — Region → Province → Town → Barangay (backend migration 0011).
 * Mirrors the backend serializers in `modules/address/serializers.ts`; keep the two in lockstep.
 *
 * The four levels share one flat shape — an id, an optional PSGC `code`, a `name`, timestamps —
 * plus their parent id, so a single table component renders all four.
 */

export interface Region {
  id: string;
  code: string | null;
  name: string;
  created_at: string | null;
  updated_at: string | null;
}

export interface Province extends Region {
  region_id: string;
}

export interface Town extends Region {
  province_id: string;
}

export interface Barangay extends Region {
  town_id: string;
}

/** Any level, for the shared table — every level is at least a `Region`-shaped row. */
export type AddressRow = Region;

/** One pasted line, ready to import. `code` is optional and normally absent from a paste. */
export interface BulkItem {
  name: string;
  code?: string;
}

/** What a bulk import returns: the rows created, and the ones skipped as duplicates. */
export interface BulkResult<TItem extends AddressRow> {
  created: TItem[];
  skipped: { name: string; reason: 'duplicate' }[];
}

export type AddressSort = 'name' | 'code' | 'created_at';
export type SortDirection = 'asc' | 'desc';

export interface AddressListQuery {
  search?: string | undefined;
  page?: number | undefined;
  per_page?: number | undefined;
  sort?: AddressSort | undefined;
  direction?: SortDirection | undefined;
}
