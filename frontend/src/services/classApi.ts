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
/** The server clamps `per_page` at 100, so this is the largest page a caller may ask for. */
const CLASSES_PAGE_SIZE = 100;

export const classApi = {
  list(): Promise<Paginated<ClassRoom>> {
    return unwrap(httpClient.get<ApiSuccess<Paginated<ClassRoom>>>('/counselor/classes'));
  },

  /**
   * Every class the caller can see, with the pages walked and flattened.
   *
   * This exists for the assessment assignment picker, which has to offer *all* of them: a picker
   * showing the first twenty classes and calling that the list would silently make some classes
   * unassignable, and the person using it would have no way to tell. The walk is the same pattern
   * `assessmentApi.fetchAllResults` uses, and at thesis scale it is one request.
   */
  async listAll(): Promise<ClassRoom[]> {
    const items: ClassRoom[] = [];
    let page = 1;
    let lastPage = 1;

    do {
      const data = await unwrap(
        httpClient.get<ApiSuccess<Paginated<ClassRoom>>>('/counselor/classes', {
          params: { page, per_page: CLASSES_PAGE_SIZE },
        }),
      );

      items.push(...data.items);
      lastPage = data.pagination.last_page;
      page += 1;
    } while (page <= lastPage);

    return items;
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
