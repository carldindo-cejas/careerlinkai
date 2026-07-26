import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { addressApi } from '@/services/addressApi';
import type { AddressListQuery, BulkItem, UpdateAddressPayload } from '@/types/address';

/** The argument every level's update mutation takes: which row, and the new name/code. */
export interface UpdateAddressArgs {
  id: string;
  payload: UpdateAddressPayload;
}

/**
 * Address hooks (FULLPLAN §36). Components call these; these call `services/addressApi`.
 *
 * Query keys are scoped by parent id *and* the list query (search/page/sort), so paginating or
 * searching one level fetches independently and an import at that level invalidates every page of
 * it at once. Each level's cache is keyed under its parent, so an import or delete invalidates only
 * the branch it touched.
 */

export const addressKeys = {
  regions: (query: AddressListQuery = {}) => ['addresses', 'regions', query] as const,
  provinces: (regionId: string, query: AddressListQuery = {}) =>
    ['addresses', 'provinces', regionId, query] as const,
  towns: (provinceId: string, query: AddressListQuery = {}) =>
    ['addresses', 'towns', provinceId, query] as const,
  barangays: (townId: string, query: AddressListQuery = {}) =>
    ['addresses', 'barangays', townId, query] as const,
};

// Regions ------------------------------------------------------------------

export function useRegions(query: AddressListQuery = {}) {
  return useQuery({
    queryKey: addressKeys.regions(query),
    queryFn: () => addressApi.listRegions(query),
  });
}

export function useImportRegions() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (items: BulkItem[]) => addressApi.importRegions(items),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['addresses', 'regions'] });
    },
  });
}

export function useUpdateRegion() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ id, payload }: UpdateAddressArgs) => addressApi.updateRegion(id, payload),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['addresses', 'regions'] });
    },
  });
}

export function useDeleteRegion() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (id: string) => addressApi.removeRegion(id),
    onSuccess: () => {
      // A region delete cascades to provinces/towns/barangays server-side, so the whole address
      // tree may have shifted — invalidate all of it rather than guessing which branches moved.
      void queryClient.invalidateQueries({ queryKey: ['addresses'] });
    },
  });
}

// Provinces ----------------------------------------------------------------

export function useProvinces(regionId: string | null, query: AddressListQuery = {}) {
  return useQuery({
    queryKey: addressKeys.provinces(regionId ?? '', query),
    queryFn: () => addressApi.listProvinces(regionId as string, query),
    enabled: regionId !== null,
  });
}

export function useImportProvinces(regionId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (items: BulkItem[]) => addressApi.importProvinces(regionId, items),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['addresses', 'provinces', regionId] });
    },
  });
}

export function useUpdateProvince(regionId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ id, payload }: UpdateAddressArgs) => addressApi.updateProvince(id, payload),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['addresses', 'provinces', regionId] });
    },
  });
}

export function useDeleteProvince() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (id: string) => addressApi.removeProvince(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['addresses', 'provinces'] });
      void queryClient.invalidateQueries({ queryKey: ['addresses', 'towns'] });
      void queryClient.invalidateQueries({ queryKey: ['addresses', 'barangays'] });
    },
  });
}

// Towns --------------------------------------------------------------------

export function useTowns(provinceId: string | null, query: AddressListQuery = {}) {
  return useQuery({
    queryKey: addressKeys.towns(provinceId ?? '', query),
    queryFn: () => addressApi.listTowns(provinceId as string, query),
    enabled: provinceId !== null,
  });
}

export function useImportTowns(provinceId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (items: BulkItem[]) => addressApi.importTowns(provinceId, items),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['addresses', 'towns', provinceId] });
    },
  });
}

export function useUpdateTown(provinceId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ id, payload }: UpdateAddressArgs) => addressApi.updateTown(id, payload),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['addresses', 'towns', provinceId] });
    },
  });
}

export function useDeleteTown() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (id: string) => addressApi.removeTown(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['addresses', 'towns'] });
      void queryClient.invalidateQueries({ queryKey: ['addresses', 'barangays'] });
    },
  });
}

// Barangays ----------------------------------------------------------------

export function useBarangays(townId: string | null, query: AddressListQuery = {}) {
  return useQuery({
    queryKey: addressKeys.barangays(townId ?? '', query),
    queryFn: () => addressApi.listBarangays(townId as string, query),
    enabled: townId !== null,
  });
}

export function useImportBarangays(townId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (items: BulkItem[]) => addressApi.importBarangays(townId, items),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['addresses', 'barangays', townId] });
    },
  });
}

export function useUpdateBarangay(townId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ id, payload }: UpdateAddressArgs) => addressApi.updateBarangay(id, payload),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['addresses', 'barangays', townId] });
    },
  });
}

export function useDeleteBarangay() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (id: string) => addressApi.removeBarangay(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['addresses', 'barangays'] });
    },
  });
}
