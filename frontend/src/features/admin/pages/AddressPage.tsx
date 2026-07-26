import type { UseQueryResult } from '@tanstack/react-query';
import { MapPin } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { cn } from '@/components/ui/cn';
import { AddressEditDialog } from '@/features/admin/components/AddressEditDialog';
import { AddressTable } from '@/features/admin/components/AddressTable';
import { BulkImportPanel } from '@/features/admin/components/BulkImportPanel';
import {
  useBarangays,
  useDeleteBarangay,
  useDeleteProvince,
  useDeleteRegion,
  useDeleteTown,
  useImportBarangays,
  useImportProvinces,
  useImportRegions,
  useImportTowns,
  useProvinces,
  useRegions,
  useTowns,
  useUpdateBarangay,
  useUpdateProvince,
  useUpdateRegion,
  useUpdateTown,
  type UpdateAddressArgs,
} from '@/features/admin/hooks/useAddresses';
import { toast } from '@/stores/toastStore';
import type {
  AddressListQuery,
  AddressRow,
  AddressSort,
  BulkItem,
  BulkResult,
  SortDirection,
} from '@/types/address';
import type { Paginated } from '@/types/class';

/**
 * Address management (backend migration 0011) — the Region → Province → Town → Barangay hierarchy
 * that will power cascading dropdowns across the system.
 *
 * One screen, four levels, reached by a tab. The deeper levels need a parent chosen first, so the
 * page owns the cascade (region → province → town) and hands the selected parent to whichever level
 * section is active. Only the active section is mounted, so only its table query runs and switching
 * tabs resets that level's search/sort/page for free.
 */

type Level = 'regions' | 'provinces' | 'towns' | 'barangays';

const TABS: { level: Level; label: string }[] = [
  { level: 'regions', label: 'Regions' },
  { level: 'provinces', label: 'Provinces' },
  { level: 'towns', label: 'Towns' },
  { level: 'barangays', label: 'Barangays' },
];

/** The parent picker fetches whole levels (they are short once scoped), not paginated pages. */
const OPTION_QUERY: AddressListQuery = { per_page: 100, sort: 'name' };

export function AddressPage() {
  const [level, setLevel] = useState<Level>('regions');
  const [regionId, setRegionId] = useState<string | null>(null);
  const [provinceId, setProvinceId] = useState<string | null>(null);
  const [townId, setTownId] = useState<string | null>(null);

  // Cascade option lists for the parent pickers.
  const regionOptions = useRegions(OPTION_QUERY);
  const provinceOptions = useProvinces(regionId, OPTION_QUERY);
  const townOptions = useTowns(provinceId, OPTION_QUERY);

  // Import + delete mutations — parent ids are read at call time, so passing '' when unselected is
  // harmless (the section that would fire them is not rendered until a parent is chosen).
  const importRegions = useImportRegions();
  const importProvinces = useImportProvinces(regionId ?? '');
  const importTowns = useImportTowns(provinceId ?? '');
  const importBarangays = useImportBarangays(townId ?? '');
  const updateRegion = useUpdateRegion();
  const updateProvince = useUpdateProvince(regionId ?? '');
  const updateTown = useUpdateTown(provinceId ?? '');
  const updateBarangay = useUpdateBarangay(townId ?? '');
  const deleteRegion = useDeleteRegion();
  const deleteProvince = useDeleteProvince();
  const deleteTown = useDeleteTown();
  const deleteBarangay = useDeleteBarangay();

  function chooseRegion(id: string | null) {
    setRegionId(id);
    setProvinceId(null);
    setTownId(null);
  }

  function chooseProvince(id: string | null) {
    setProvinceId(id);
    setTownId(null);
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold text-foreground">Address management</h1>
        <p className="text-sm text-muted-foreground">
          The Philippine address hierarchy — regions down to barangays — that powers the cascading
          location dropdowns across CareerLinkAI.
        </p>
      </div>

      <div className="flex flex-wrap gap-1 border-b border-border">
        {TABS.map((tab) => (
          <button
            key={tab.level}
            type="button"
            onClick={() => setLevel(tab.level)}
            className={cn(
              'border-b-2 px-4 py-2 text-sm font-medium transition-colors',
              level === tab.level
                ? 'border-primary text-foreground'
                : 'border-transparent text-muted-foreground hover:text-foreground',
            )}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Cascading parent pickers — only the ones the active level needs. */}
      {level !== 'regions' ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <ParentPicker
            label="Region"
            value={regionId}
            options={regionOptions.data?.items ?? []}
            loading={regionOptions.isPending}
            onChange={chooseRegion}
          />
          {level === 'towns' || level === 'barangays' ? (
            <ParentPicker
              label="Province"
              value={provinceId}
              options={provinceOptions.data?.items ?? []}
              loading={provinceOptions.isFetching}
              disabledHint={regionId ? undefined : 'Choose a region first'}
              onChange={chooseProvince}
            />
          ) : null}
          {level === 'barangays' ? (
            <ParentPicker
              label="Town / Municipality"
              value={townId}
              options={townOptions.data?.items ?? []}
              loading={townOptions.isFetching}
              disabledHint={provinceId ? undefined : 'Choose a province first'}
              onChange={setTownId}
            />
          ) : null}
        </div>
      ) : null}

      {level === 'regions' ? (
        <LevelSection
          noun="region"
          useList={useRegions}
          importMutation={importRegions}
          updateMutation={updateRegion}
          deleteMutation={deleteRegion}
        />
      ) : null}

      {level === 'provinces' ? (
        regionId ? (
          <LevelSection
            key={`prov-${regionId}`}
            noun="province"
            useList={(query) => useProvinces(regionId, query)}
            importMutation={importProvinces}
            updateMutation={updateProvince}
            deleteMutation={deleteProvince}
          />
        ) : (
          <SelectParentHint message="Select a region to view and manage its provinces." />
        )
      ) : null}

      {level === 'towns' ? (
        provinceId ? (
          <LevelSection
            key={`town-${provinceId}`}
            noun="town"
            useList={(query) => useTowns(provinceId, query)}
            importMutation={importTowns}
            updateMutation={updateTown}
            deleteMutation={deleteTown}
          />
        ) : (
          <SelectParentHint message="Select a region and province to view and manage their towns." />
        )
      ) : null}

      {level === 'barangays' ? (
        townId ? (
          <LevelSection
            key={`brgy-${townId}`}
            noun="barangay"
            useList={(query) => useBarangays(townId, query)}
            importMutation={importBarangays}
            updateMutation={updateBarangay}
            deleteMutation={deleteBarangay}
          />
        ) : (
          <SelectParentHint message="Select a region, province and town to view and manage their barangays." />
        )
      ) : null}
    </div>
  );
}

interface MutationLike<TArg, TResult> {
  mutateAsync: (arg: TArg) => Promise<TResult>;
  isPending: boolean;
  variables: TArg | undefined;
}

interface LevelSectionProps {
  noun: string;
  useList: (query: AddressListQuery) => UseQueryResult<Paginated<AddressRow>, Error>;
  importMutation: MutationLike<BulkItem[], BulkResult<AddressRow>>;
  updateMutation: MutationLike<UpdateAddressArgs, AddressRow>;
  deleteMutation: MutationLike<string, void>;
}

const PER_PAGE = 20;

/**
 * One level's full surface: bulk import on top, then its searchable/sortable/paginated table.
 *
 * `useList` is passed as a hook and called once here — the query state (search, sort, page) lives
 * in this component, so mounting a fresh section per parent gives each parent its own clean view.
 */
function LevelSection({
  noun,
  useList,
  importMutation,
  updateMutation,
  deleteMutation,
}: LevelSectionProps) {
  const [searchInput, setSearchInput] = useState('');
  const [page, setPage] = useState(1);
  const [sort, setSort] = useState<AddressSort>('name');
  const [direction, setDirection] = useState<SortDirection>('asc');
  const [editingRow, setEditingRow] = useState<AddressRow | null>(null);

  const search = useDebouncedValue(searchInput, 300);

  // A new search always returns to page one — page 4 of the unfiltered list rarely exists in the
  // filtered one, and a page beyond the last would come back empty.
  useEffect(() => setPage(1), [search]);

  const query: AddressListQuery = useMemo(
    () => ({ search: search || undefined, page, per_page: PER_PAGE, sort, direction }),
    [search, page, sort, direction],
  );

  const list = useList(query);

  function onSort(column: AddressSort) {
    if (column === sort) {
      setDirection((current) => (current === 'asc' ? 'desc' : 'asc'));
    } else {
      setSort(column);
      setDirection('asc');
    }
    setPage(1);
  }

  async function onDelete(row: AddressRow) {
    if (
      !window.confirm(
        `Delete ${row.name}? Anything beneath it in the hierarchy is removed with it. This can be undone by an administrator.`,
      )
    ) {
      return;
    }

    try {
      await deleteMutation.mutateAsync(row.id);
      toast.success(`Deleted ${row.name}.`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : `Could not delete ${row.name}.`);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <BulkImportPanel
        noun={noun}
        onImport={importMutation.mutateAsync}
        isImporting={importMutation.isPending}
      />

      <AddressTable
        noun={noun}
        data={list.data}
        isPending={list.isPending}
        isFetching={list.isFetching}
        isError={list.isError}
        errorMessage={list.error?.message}
        search={searchInput}
        onSearchChange={setSearchInput}
        sort={sort}
        direction={direction}
        onSort={onSort}
        page={page}
        onPageChange={setPage}
        onEdit={setEditingRow}
        onDelete={onDelete}
        deletingId={deleteMutation.isPending ? (deleteMutation.variables ?? null) : null}
      />

      <AddressEditDialog
        noun={noun}
        row={editingRow}
        onClose={() => setEditingRow(null)}
        onSave={updateMutation.mutateAsync}
        isSaving={updateMutation.isPending}
      />
    </div>
  );
}

function ParentPicker({
  label,
  value,
  options,
  loading,
  disabledHint,
  onChange,
}: {
  label: string;
  value: string | null;
  options: AddressRow[];
  loading: boolean;
  disabledHint?: string | undefined;
  onChange: (id: string | null) => void;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label>{label}</Label>
      <Select
        value={value ?? ''}
        disabled={Boolean(disabledHint)}
        onChange={(event) => onChange(event.target.value === '' ? null : event.target.value)}
      >
        <option value="">
          {disabledHint ?? (loading ? 'Loading…' : `Select a ${label.toLowerCase()}…`)}
        </option>
        {options.map((option) => (
          <option key={option.id} value={option.id}>
            {option.name}
          </option>
        ))}
      </Select>
    </div>
  );
}

function SelectParentHint({ message }: { message: string }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <MapPin className="size-4 text-muted-foreground" aria-hidden="true" />
          Choose a parent
        </CardTitle>
        <CardDescription>{message}</CardDescription>
      </CardHeader>
      <CardContent />
    </Card>
  );
}

/** Debounce a fast-changing value (the search box) so it drives one request, not one per keystroke. */
function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delayMs);

    return () => window.clearTimeout(timer);
  }, [value, delayMs]);

  return debounced;
}
