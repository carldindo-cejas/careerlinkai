/**
 * The standard API envelopes (FULLPLAN §19).
 *
 * Every response from the backend uses one of these two shapes. Nothing in the app
 * should ever read a raw response body directly — go through the http client, which
 * unwraps the envelope and normalises errors.
 */

export interface ApiMeta {
  timestamp: string;
  current_page?: number;
  total?: number;
  last_page?: number;
}

export interface ApiSuccess<TData> {
  success: true;
  message: string;
  data: TData;
  meta: ApiMeta;
}

export interface ApiError {
  success: false;
  message: string;
  errors: Record<string, string[]>;
}

/**
 * A normalised failure, thrown by the http client so that callers never have to
 * unpick an axios error shape.
 */
export class ApiRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly errors: Record<string, string[]> = {},
  ) {
    super(message);
    this.name = 'ApiRequestError';
  }

  /** The first validation message for a field, if the server reported one. */
  fieldError(field: string): string | undefined {
    return this.errors[field]?.[0];
  }
}
