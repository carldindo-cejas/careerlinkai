import axios, { AxiosError, type AxiosInstance } from 'axios';

import { useAuthStore } from '@/stores/authStore';
import { ApiRequestError, type ApiError, type ApiSuccess } from '@/types/api';

const baseURL = import.meta.env.VITE_API_BASE_URL;

if (!baseURL) {
  throw new Error('VITE_API_BASE_URL is not set. Copy .env.example to .env.');
}

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
