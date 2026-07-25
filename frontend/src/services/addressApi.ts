import { httpClient, unwrap } from '@/services/httpClient';
import type {
  AddressListQuery,
  Barangay,
  BulkItem,
  BulkResult,
  Province,
  Region,
  Town,
} from '@/types/address';
import type { ApiSuccess } from '@/types/api';
import type { Paginated } from '@/types/class';

/**
 * The Philippine address hierarchy (backend migration 0011). Admin only.
 *
 * The nesting mirrors the API's, which mirrors the catalog's: a child is *listed and created under
 * its parent* (from the route, never the body — a place cannot be re-parented) and *deleted by its
 * own id*. There is no per-record update: reference rows are added in bulk and removed, not edited
 * one field at a time.
 */

/** Strip `undefined` query params so the request URL stays clean. */
function params(query: AddressListQuery): Record<string, string | number> {
  const out: Record<string, string | number> = {};

  if (query.search) out.search = query.search;
  if (query.page) out.page = query.page;
  if (query.per_page) out.per_page = query.per_page;
  if (query.sort) out.sort = query.sort;
  if (query.direction) out.direction = query.direction;

  return out;
}

export const addressApi = {
  // Regions ----------------------------------------------------------------

  listRegions(query: AddressListQuery = {}): Promise<Paginated<Region>> {
    return unwrap(
      httpClient.get<ApiSuccess<Paginated<Region>>>('/admin/regions', { params: params(query) }),
    );
  },

  importRegions(items: BulkItem[]): Promise<BulkResult<Region>> {
    return unwrap(httpClient.post<ApiSuccess<BulkResult<Region>>>('/admin/regions/bulk', { items }));
  },

  async removeRegion(id: string): Promise<void> {
    await httpClient.delete(`/admin/regions/${id}`);
  },

  // Provinces --------------------------------------------------------------

  listProvinces(regionId: string, query: AddressListQuery = {}): Promise<Paginated<Province>> {
    return unwrap(
      httpClient.get<ApiSuccess<Paginated<Province>>>(`/admin/regions/${regionId}/provinces`, {
        params: params(query),
      }),
    );
  },

  importProvinces(regionId: string, items: BulkItem[]): Promise<BulkResult<Province>> {
    return unwrap(
      httpClient.post<ApiSuccess<BulkResult<Province>>>(
        `/admin/regions/${regionId}/provinces/bulk`,
        { items },
      ),
    );
  },

  async removeProvince(id: string): Promise<void> {
    await httpClient.delete(`/admin/provinces/${id}`);
  },

  // Towns ------------------------------------------------------------------

  listTowns(provinceId: string, query: AddressListQuery = {}): Promise<Paginated<Town>> {
    return unwrap(
      httpClient.get<ApiSuccess<Paginated<Town>>>(`/admin/provinces/${provinceId}/towns`, {
        params: params(query),
      }),
    );
  },

  importTowns(provinceId: string, items: BulkItem[]): Promise<BulkResult<Town>> {
    return unwrap(
      httpClient.post<ApiSuccess<BulkResult<Town>>>(`/admin/provinces/${provinceId}/towns/bulk`, {
        items,
      }),
    );
  },

  async removeTown(id: string): Promise<void> {
    await httpClient.delete(`/admin/towns/${id}`);
  },

  // Barangays --------------------------------------------------------------

  listBarangays(townId: string, query: AddressListQuery = {}): Promise<Paginated<Barangay>> {
    return unwrap(
      httpClient.get<ApiSuccess<Paginated<Barangay>>>(`/admin/towns/${townId}/barangays`, {
        params: params(query),
      }),
    );
  },

  importBarangays(townId: string, items: BulkItem[]): Promise<BulkResult<Barangay>> {
    return unwrap(
      httpClient.post<ApiSuccess<BulkResult<Barangay>>>(`/admin/towns/${townId}/barangays/bulk`, {
        items,
      }),
    );
  },

  async removeBarangay(id: string): Promise<void> {
    await httpClient.delete(`/admin/barangays/${id}`);
  },
};
