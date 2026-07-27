import axios, { AxiosError, type AxiosInstance } from 'axios';

import { useAuthStore } from '@/stores/authStore';
import { ApiRequestError, type ApiError, type ApiSuccess } from '@/types/api';

/**
 * The API base path (FULLPLAN §19).
 *
 * A **relative** path, and that is the whole point: since the frontend and the Hono API are one
 * Cloudflare Worker deployment, `/api/v1` resolves to whatever origin is serving the page —
 * localhost:5173 behind Vite's dev proxy, the staging Worker, careerlinkai.online. The app is
 * same-origin with its API by construction, so there is no build-time origin to get wrong and no
 * CORS to negotiate.
 *
 * This replaced a required `VITE_API_BASE_URL` holding an absolute cross-origin URL, which had to
 * be right in three places at once (the frontend's `.env` for the mode being built, the backend's
 * `FRONTEND_URL` for that environment's CORS allow-list, and the deploy target) or the app booted
 * and then failed every request with an error the browser reports as a CORS failure. The variable
 * is still honoured as an override — pointing a local Vite at a deployed API is the one case that
 * still needs it — but nothing sets it in normal operation.
 */
const baseURL = import.meta.env.VITE_API_BASE_URL ?? '/api/v1';

export const httpClient: AxiosInstance = axios.create({
  baseURL,
  headers: {
    Accept: 'application/json',
    'Content-Type': 'application/json',
  },
});

/**
 * Attach the bearer token to every request (FULLPLAN §19).
 *
 * Both staff login and passwordless student access issue the same token type, so a
 * single interceptor covers both flows.
 */
httpClient.interceptors.request.use((config) => {
  const { token } = useAuthStore.getState();

  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }

  return config;
});

/**
 * Normalise every failure into an ApiRequestError, and sign the user out on a 401 so
 * a revoked or expired token cannot leave the app in a half-authenticated state.
 */
httpClient.interceptors.response.use(
  (response) => response,
  (error: AxiosError<ApiError>) => {
    const status = error.response?.status ?? 0;
    const body = error.response?.data;

    if (status === 401) {
      useAuthStore.getState().clear();
    }

    return Promise.reject(
      new ApiRequestError(
        body?.message ?? error.message ?? 'The request failed.',
        status,
        body?.errors ?? {},
      ),
    );
  },
);

/** Unwrap the §19 success envelope down to its `data` payload. */
export async function unwrap<TData>(request: Promise<{ data: ApiSuccess<TData> }>): Promise<TData> {
  const response = await request;

  return response.data.data;
}
