import { httpClient, unwrap } from '@/services/httpClient';
import type { ApiSuccess } from '@/types/api';
import type {
  ClassRoom,
  CreateClassPayload,
  Paginated,
  UpdateClassPayload,
} from '@/types/class';

/**
 * Class management (FULLPLAN §20, Phase 1A).
 *
 * The join code is never sent: it is generated server-side at creation and rotated by
 * `regenerateCode`. A client that could choose its own code could choose a guessable one
 * (§38), so it is not an input anywhere in this module.
 */
export const classApi = {
  list(): Promise<Paginated<ClassRoom>> {
    return unwrap(httpClient.get<ApiSuccess<Paginated<ClassRoom>>>('/counselor/classes'));
  },

  get(id: string): Promise<ClassRoom> {
    return unwrap(httpClient.get<ApiSuccess<ClassRoom>>(`/counselor/classes/${id}`));
  },

  create(payload: CreateClassPayload): Promise<ClassRoom> {
    return unwrap(httpClient.post<ApiSuccess<ClassRoom>>('/counselor/classes', payload));
  },

  update(id: string, payload: UpdateClassPayload): Promise<ClassRoom> {
    return unwrap(httpClient.patch<ApiSuccess<ClassRoom>>(`/counselor/classes/${id}`, payload));
  },

  async remove(id: string): Promise<void> {
    await httpClient.delete(`/counselor/classes/${id}`);
  },

  /** Issues a fresh code. The previous one stops working immediately (§38). */
  regenerateCode(id: string): Promise<ClassRoom> {
    return unwrap(
      httpClient.post<ApiSuccess<ClassRoom>>(`/counselor/classes/${id}/regenerate-code`),
    );
  },
};
