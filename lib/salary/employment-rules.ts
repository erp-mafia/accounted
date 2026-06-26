import type { EntityType } from '@/types'

/**
 * Employment policy: which employment types an entity type may put on payroll.
 *
 * An enskild firma is not a separate legal person from its owner, so the owner
 * cannot be their own employee and cannot be paid lön — owner compensation is
 * *egna uttag* (BAS 2013), booked against equity, never a salary cost. Board
 * members (styrelse) are an aktiebolag concept and likewise don't exist for an
 * EF. Ordinary employees (employment_type 'employee') are fully allowed for an
 * EF that hires staff and book identically to an aktiebolag (7xxx + 27xx/29xx
 * + 1930, never the 20xx equity accounts).
 *
 * This module is the application-layer mirror of the
 * `enforce_ef_no_owner_employee` database trigger (the load-bearing,
 * all-paths enforcement). Keep the two in sync — the forbidden set below must
 * match the trigger's. See issue #782.
 */
export const EF_FORBIDDEN_EMPLOYMENT_TYPES = ['company_owner', 'board_member'] as const

/** User-facing Swedish error when an EF tries to put its owner/board on payroll. */
export const EF_OWNER_EMPLOYMENT_ERROR =
  'En enskild firma kan inte ha sin ägare eller styrelse som anställd. ' +
  'Som ägare tar du ut pengar via eget uttag (konto 2013), inte lön. ' +
  'Lägg bara upp dina anställda (anställningstyp "employee").'

/**
 * Whether `employmentType` is permitted for a company of `entityType`.
 * Permissive for everything except owner/board employment on an enskild firma,
 * and for unknown/empty inputs (which the schema's enum check handles).
 */
export function isEmploymentTypeAllowedForEntity(
  entityType: EntityType | null | undefined,
  employmentType: string | null | undefined,
): boolean {
  if (entityType !== 'enskild_firma') return true
  if (!employmentType) return true
  return !(EF_FORBIDDEN_EMPLOYMENT_TYPES as readonly string[]).includes(employmentType)
}
