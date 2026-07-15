import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import { BASE_URL, api } from './helpers';

/**
 * The app shell: the two §19 envelopes, the health check (§53), and the correlation id
 * (§52). Everything else in the suite depends on these being right, so they are asserted
 * once, here, rather than re-checked in every endpoint's tests.
 */

describe('GET /health', () => {
  it('reports healthy in the §19 success envelope', async () => {
    const response = await api('GET', '/health');

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      success: true,
      message: 'Service is healthy.',
      data: { status: 'ok', environment: 'local', version: 'v1' },
    });
    expect(typeof response.body.meta.timestamp).toBe('string');
  });
});

describe('the response envelope (§19)', () => {
  it('returns the error envelope, never a bare string, for an unknown route', async () => {
    const response = await api('GET', '/does-not-exist');

    expect(response.status).toBe(404);
    expect(response.body).toEqual({
      success: false,
      message: 'Resource not found.',
      errors: {},
    });
  });

  it('rejects a malformed JSON body as a 400, not a field-level 422', async () => {
    const response = await SELF.fetch(`${BASE_URL}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{ not json',
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      message: 'The request body must be valid JSON.',
    });
  });

  it('reports validation failures as 422 keyed by field name', async () => {
    const response = await api('POST', '/auth/login', {
      body: { email: 'not-an-email', password: '' },
    });

    expect(response.status).toBe(422);
    expect(response.body.success).toBe(false);
    expect(response.body.message).toBe('Validation failed.');
    expect(response.body.errors.email).toEqual(['Enter a valid email address.']);
    expect(response.body.errors.password).toEqual(['Your password is required.']);
  });
});

describe('correlation id (§52)', () => {
  it('echoes an inbound id back so a caller can stitch its own traces', async () => {
    const response = await SELF.fetch(`${BASE_URL}/health`, {
      headers: { 'X-Correlation-Id': 'trace-me-123' },
    });

    expect(response.headers.get('X-Correlation-Id')).toBe('trace-me-123');
  });

  it('mints one when the caller sends none', async () => {
    const response = await SELF.fetch(`${BASE_URL}/health`);

    expect(response.headers.get('X-Correlation-Id')).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });
});
