/**
 * The string-literal unions behind every TEXT + CHECK enum column (FULLPLAN §12).
 *
 * The CHECK constraint in the migration and the union here are the same rule written
 * twice — once for the database, once for the type checker. Keep them in lockstep: a value
 * added here without a matching migration will fail at runtime with a constraint error.
 */

export const USER_ROLES = ['admin', 'counselor', 'student'] as const;
export type UserRole = (typeof USER_ROLES)[number];

export const USER_STATUSES = ['pending', 'active', 'inactive', 'suspended'] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

export const STRANDS = ['Academic', 'Technical-Professional'] as const;
export type Strand = (typeof STRANDS)[number];
