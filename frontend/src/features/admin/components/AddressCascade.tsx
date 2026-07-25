import { Combobox, type ComboboxOption } from '@/components/ui/combobox';
import { Label } from '@/components/ui/label';
import {
  useBarangays,
  useProvinces,
  useRegions,
  useTowns,
} from '@/features/admin/hooks/useAddresses';
import type { AddressListQuery, AddressRow } from '@/types/address';

/**
 * The cascading, searchable school-address picker (backend migration 0012): Region → Province →
 * Town → Barangay, each loading only after its parent is chosen and each searchable because the
 * lists are long. Reused by the add-college form and the college detail page's location editor.
 *
 * The parent owns the value; this component enforces the cascade's one rule — **choosing a parent
 * clears its descendants** — so a stale town can never hang under a region that no longer contains
 * it. The server re-validates the whole chain regardless (it is the authority); this keeps the UI
 * from ever presenting an impossible combination in the first place.
 */

export interface AddressValue {
  region_id: string | null;
  province_id: string | null;
  town_id: string | null;
  barangay_id: string | null;
}

export const emptyAddress: AddressValue = {
  region_id: null,
  province_id: null,
  town_id: null,
  barangay_id: null,
};

export interface AddressCascadeProps {
  value: AddressValue;
  onChange: (value: AddressValue) => void;
  errors?: Partial<Record<keyof AddressValue, string | undefined>>;
}

/** The pickers want whole levels (short once scoped to a parent), alphabetical — not paginated. */
const OPTION_QUERY: AddressListQuery = { per_page: 100, sort: 'name' };

const toOption = (row: AddressRow): ComboboxOption => ({ id: row.id, name: row.name });

export function AddressCascade({ value, onChange, errors }: AddressCascadeProps) {
  const regions = useRegions(OPTION_QUERY);
  const provinces = useProvinces(value.region_id, OPTION_QUERY);
  const towns = useTowns(value.province_id, OPTION_QUERY);
  const barangays = useBarangays(value.town_id, OPTION_QUERY);

  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <Field label="Region" htmlFor="address-region" error={errors?.region_id}>
        <Combobox
          id="address-region"
          value={value.region_id}
          options={(regions.data?.items ?? []).map(toOption)}
          loading={regions.isPending}
          clearable
          placeholder="Select a region…"
          searchPlaceholder="Search regions…"
          invalid={Boolean(errors?.region_id)}
          onChange={(id) => onChange({ region_id: id, province_id: null, town_id: null, barangay_id: null })}
        />
      </Field>

      <Field label="Province" htmlFor="address-province" error={errors?.province_id}>
        <Combobox
          id="address-province"
          value={value.province_id}
          options={(provinces.data?.items ?? []).map(toOption)}
          loading={provinces.isFetching}
          clearable
          disabledHint={value.region_id ? undefined : 'Choose a region first'}
          placeholder="Select a province…"
          searchPlaceholder="Search provinces…"
          invalid={Boolean(errors?.province_id)}
          onChange={(id) => onChange({ ...value, province_id: id, town_id: null, barangay_id: null })}
        />
      </Field>

      <Field label="Town / Municipality" htmlFor="address-town" error={errors?.town_id}>
        <Combobox
          id="address-town"
          value={value.town_id}
          options={(towns.data?.items ?? []).map(toOption)}
          loading={towns.isFetching}
          clearable
          disabledHint={value.province_id ? undefined : 'Choose a province first'}
          placeholder="Select a town or municipality…"
          searchPlaceholder="Search towns…"
          invalid={Boolean(errors?.town_id)}
          onChange={(id) => onChange({ ...value, town_id: id, barangay_id: null })}
        />
      </Field>

      <Field label="Barangay" htmlFor="address-barangay" error={errors?.barangay_id}>
        <Combobox
          id="address-barangay"
          value={value.barangay_id}
          options={(barangays.data?.items ?? []).map(toOption)}
          loading={barangays.isFetching}
          clearable
          disabledHint={value.town_id ? undefined : 'Choose a town first'}
          placeholder="Select a barangay…"
          searchPlaceholder="Search barangays…"
          invalid={Boolean(errors?.barangay_id)}
          onChange={(id) => onChange({ ...value, barangay_id: id })}
        />
      </Field>
    </div>
  );
}

function Field({
  label,
  htmlFor,
  error,
  children,
}: {
  label: string;
  htmlFor: string;
  error?: string | undefined;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
    </div>
  );
}
