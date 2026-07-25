import { Hono, type Context } from 'hono';

import { createDatabase } from '@/db/client';
import type { AppEnv } from '@/env';
import { successEnvelope } from '@/lib/envelope';
import { clientIp, parseBody, parseQuery } from '@/lib/validation';
import { authenticate, requireUser } from '@/middleware/authenticate';
import { ensurePasswordChanged } from '@/middleware/ensure-password-changed';
import { ensureRole } from '@/middleware/ensure-role';
import { AddressService } from '@/modules/address/address-service';
import { bulkImportSchema, listAddressQuerySchema } from '@/modules/address/schemas';
import {
  serializeBarangay,
  serializeProvince,
  serializeRegion,
  serializeTown,
  type SerializedBulkResult,
} from '@/modules/address/serializers';

/**
 * The `/admin` Address route group (migration 0011) — the Philippine address hierarchy that will
 * power cascading dropdowns.
 *
 * Authorization is one layer, exactly as in the catalog group (§39): address data belongs to
 * nobody, so `admin` is the whole rule and there is no per-record policy behind this gate. The
 * route group is the only thing standing between these endpoints and a counselor.
 *
 * The nesting mirrors the catalog's: a child is *listed and created under its parent* (from the
 * route, never the body — a place cannot be re-parented) and *deleted by its own id*.
 */
export const adminAddressRoutes = new Hono<AppEnv>();

adminAddressRoutes.use('*', authenticate());
adminAddressRoutes.use('*', ensureRole('admin'));
adminAddressRoutes.use('*', ensurePasswordChanged());

function service(c: { env: AppEnv['Bindings'] }): AddressService {
  return new AddressService(createDatabase(c.env.DB));
}

function listQuery(c: Context<AppEnv>) {
  return parseQuery(c, listAddressQuerySchema, [
    'search',
    'page',
    'per_page',
    'sort',
    'direction',
  ]);
}

function bulkEnvelope<TItem>(result: SerializedBulkResult<TItem>, noun: string) {
  const { created, skipped } = result;
  const message =
    skipped.length === 0
      ? `Added ${created.length} ${noun}.`
      : `Added ${created.length} ${noun}; skipped ${skipped.length} already in the list.`;

  return successEnvelope(result, message);
}

// --- Regions ---------------------------------------------------------------------------

adminAddressRoutes.get('/regions', async (c) => {
  const page = await service(c).listRegions(listQuery(c));

  return c.json(
    successEnvelope(
      { items: page.items.map(serializeRegion), pagination: page.pagination },
      'Regions retrieved successfully.',
    ),
  );
});

adminAddressRoutes.post('/regions/bulk', async (c) => {
  const input = await parseBody(c, bulkImportSchema);
  const result = await service(c).importRegions(requireUser(c), input, clientIp(c));

  return c.json(
    bulkEnvelope({ created: result.created.map(serializeRegion), skipped: result.skipped }, 'regions'),
    201,
  );
});

adminAddressRoutes.delete('/regions/:id', async (c) => {
  await service(c).deleteRegion(requireUser(c), c.req.param('id'), clientIp(c));

  return c.body(null, 204);
});

// --- Provinces -------------------------------------------------------------------------

adminAddressRoutes.get('/regions/:regionId/provinces', async (c) => {
  const page = await service(c).listProvinces(c.req.param('regionId'), listQuery(c));

  return c.json(
    successEnvelope(
      { items: page.items.map(serializeProvince), pagination: page.pagination },
      'Provinces retrieved successfully.',
    ),
  );
});

adminAddressRoutes.post('/regions/:regionId/provinces/bulk', async (c) => {
  const input = await parseBody(c, bulkImportSchema);
  const result = await service(c).importProvinces(
    requireUser(c),
    c.req.param('regionId'),
    input,
    clientIp(c),
  );

  return c.json(
    bulkEnvelope(
      { created: result.created.map(serializeProvince), skipped: result.skipped },
      'provinces',
    ),
    201,
  );
});

adminAddressRoutes.delete('/provinces/:id', async (c) => {
  await service(c).deleteProvince(requireUser(c), c.req.param('id'), clientIp(c));

  return c.body(null, 204);
});

// --- Towns -----------------------------------------------------------------------------

adminAddressRoutes.get('/provinces/:provinceId/towns', async (c) => {
  const page = await service(c).listTowns(c.req.param('provinceId'), listQuery(c));

  return c.json(
    successEnvelope(
      { items: page.items.map(serializeTown), pagination: page.pagination },
      'Towns retrieved successfully.',
    ),
  );
});

adminAddressRoutes.post('/provinces/:provinceId/towns/bulk', async (c) => {
  const input = await parseBody(c, bulkImportSchema);
  const result = await service(c).importTowns(
    requireUser(c),
    c.req.param('provinceId'),
    input,
    clientIp(c),
  );

  return c.json(
    bulkEnvelope({ created: result.created.map(serializeTown), skipped: result.skipped }, 'towns'),
    201,
  );
});

adminAddressRoutes.delete('/towns/:id', async (c) => {
  await service(c).deleteTown(requireUser(c), c.req.param('id'), clientIp(c));

  return c.body(null, 204);
});

// --- Barangays -------------------------------------------------------------------------

adminAddressRoutes.get('/towns/:townId/barangays', async (c) => {
  const page = await service(c).listBarangays(c.req.param('townId'), listQuery(c));

  return c.json(
    successEnvelope(
      { items: page.items.map(serializeBarangay), pagination: page.pagination },
      'Barangays retrieved successfully.',
    ),
  );
});

adminAddressRoutes.post('/towns/:townId/barangays/bulk', async (c) => {
  const input = await parseBody(c, bulkImportSchema);
  const result = await service(c).importBarangays(
    requireUser(c),
    c.req.param('townId'),
    input,
    clientIp(c),
  );

  return c.json(
    bulkEnvelope(
      { created: result.created.map(serializeBarangay), skipped: result.skipped },
      'barangays',
    ),
    201,
  );
});

adminAddressRoutes.delete('/barangays/:id', async (c) => {
  await service(c).deleteBarangay(requireUser(c), c.req.param('id'), clientIp(c));

  return c.body(null, 204);
});
