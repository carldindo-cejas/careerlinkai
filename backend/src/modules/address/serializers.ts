import type { Barangay, Province, Region, Town } from '@/db/schema';

/**
 * Address response shaping (migration 0011). Allow-lists, as everywhere else — a field is emitted
 * because it is named here, never because it happens to be on the row. The frontend's
 * `types/address.ts` is the mirror image of what is below.
 *
 * The four levels share one flat shape (`id`, `code`, `name`, timestamps) plus their parent id,
 * so the frontend can render all four tables with a single component.
 */

export interface SerializedRegion {
  id: string;
  code: string | null;
  name: string;
  created_at: string | null;
  updated_at: string | null;
}

export function serializeRegion(region: Region): SerializedRegion {
  return {
    id: region.id,
    code: region.code,
    name: region.name,
    created_at: region.createdAt,
    updated_at: region.updatedAt,
  };
}

export interface SerializedProvince extends SerializedRegion {
  region_id: string;
}

export function serializeProvince(province: Province): SerializedProvince {
  return {
    id: province.id,
    region_id: province.regionId,
    code: province.code,
    name: province.name,
    created_at: province.createdAt,
    updated_at: province.updatedAt,
  };
}

export interface SerializedTown extends SerializedRegion {
  province_id: string;
}

export function serializeTown(town: Town): SerializedTown {
  return {
    id: town.id,
    province_id: town.provinceId,
    code: town.code,
    name: town.name,
    created_at: town.createdAt,
    updated_at: town.updatedAt,
  };
}

export interface SerializedBarangay extends SerializedRegion {
  town_id: string;
}

export function serializeBarangay(barangay: Barangay): SerializedBarangay {
  return {
    id: barangay.id,
    town_id: barangay.townId,
    code: barangay.code,
    name: barangay.name,
    created_at: barangay.createdAt,
    updated_at: barangay.updatedAt,
  };
}

/**
 * The bulk-import result the frontend renders as "42 added, 3 skipped (already in the list)".
 * `skipped` carries the name and why, so the admin sees exactly which pasted lines were ignored
 * rather than a bare count.
 */
export interface SerializedBulkResult<TItem> {
  created: TItem[];
  skipped: { name: string; reason: 'duplicate' }[];
}
