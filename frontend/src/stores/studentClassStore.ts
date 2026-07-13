import { create } from 'zustand';
import { persist } from 'zustand/middleware';

import type { StudentClassSummary } from '@/types/class';

/**
 * The class a student joined, and the username they joined with (FULLPLAN §38).
 *
 * This is persisted, unlike the user object in authStore, for a plain reason: the join
 * response is the *only* place this data is returned, and Phase 1 has no endpoint a
 * student can call to ask "which class am I in?". Dropping it on reload would leave a
 * signed-in student on a shell that cannot name their own class.
 *
 * What is stored is what the join endpoint hands back — deliberately *not* the staff
 * ClassResource: no join code and no counselor id. The code is a shared secret and must
 * not be sitting in local storage on a machine the whole class uses (§38). Replace this
 * with a real GET when the student module gains one.
 */
interface StudentClassState {
  classRoom: StudentClassSummary | null;
  username: string | null;
  setClass: (classRoom: StudentClassSummary, username: string) => void;
  clear: () => void;
}

export const useStudentClassStore = create<StudentClassState>()(
  persist(
    (set) => ({
      classRoom: null,
      username: null,
      setClass: (classRoom, username) => set({ classRoom, username }),
      clear: () => set({ classRoom: null, username: null }),
    }),
    { name: 'careerlinkai.student-class' },
  ),
);
