/**
 * The Fora uppmärkning on an employee: the FOK code the employee is reported
 * to Fora under and the date it applies from (employees.fora_fok_id and
 * fora_fok_start_date, migration 20261022201639).
 *
 * Since 2024-01-01 employees covered by Avtalspension SAF-LO (usually
 * arbetare) are marked up with a FOK code and a start date, and their pay is
 * reported to Fora every month (Fora's file specification v1.37, section 2).
 * The employer reads its valid codes on Fora's Mina sidor; most have one.
 *
 * Rules, checked on the row as it would be stored, on every door (dashboard,
 * v1 and MCP, through CreateEmployeeSchema and validateEmployeeUpdate) and
 * backed by CHECK constraints:
 *   - the code is 'FOK' plus six digits;
 *   - the code and its start date are set together or not at all;
 *   - only employment_type 'employee' carries a code: owners and board
 *     members are never marked up at Fora.
 *
 * Dependency-free so the employee form can share the format check.
 */

export const FORA_FOK_ID_PATTERN = /^FOK\d{6}$/

export const FORA_FOK_ID_FORMAT = 'Fora-koden ska vara FOK följt av sex siffror, t.ex. FOK306834 (koden finns på Foras Mina sidor)'
export const FORA_FOK_START_REQUIRED = 'Ange från vilket datum Fora-koden gäller'
export const FORA_FOK_ID_REQUIRED = 'Ange Fora-koden (FOK följt av sex siffror) som startdatumet gäller'
export const FORA_FOK_EMPLOYEE_ONLY =
  'Fora-kod kan bara anges för anställda: ägare och styrelseledamöter märks inte upp hos Fora. Ta bort koden först'

export interface ForaMarkupFields {
  employment_type?: unknown
  fora_fok_id?: unknown
  fora_fok_start_date?: unknown
}

export interface ForaMarkupIssue {
  field: 'fora_fok_id' | 'fora_fok_start_date'
  message: string
}

/** Upper-cases and trims a typed code ("fok306834 " is FOK306834); empty is null. */
export function normalizeForaFokId(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null
  const trimmed = value.trim().toUpperCase()
  return trimmed === '' ? null : trimmed
}

/** True when the update names a key the markup rules read. */
export function touchesForaMarkup(patch: Record<string, unknown>): boolean {
  return 'fora_fok_id' in patch || 'fora_fok_start_date' in patch || 'employment_type' in patch
}

/** Every problem with the markup on a stored-shape row, empty when it may be written. */
export function validateForaMarkup(row: ForaMarkupFields): ForaMarkupIssue[] {
  const issues: ForaMarkupIssue[] = []
  const fokId = row.fora_fok_id ?? null
  const start = row.fora_fok_start_date ?? null

  if (fokId !== null && (typeof fokId !== 'string' || !FORA_FOK_ID_PATTERN.test(fokId))) {
    issues.push({ field: 'fora_fok_id', message: FORA_FOK_ID_FORMAT })
  }
  if (fokId !== null && start === null) {
    issues.push({ field: 'fora_fok_start_date', message: FORA_FOK_START_REQUIRED })
  }
  if (fokId === null && start !== null) {
    issues.push({ field: 'fora_fok_id', message: FORA_FOK_ID_REQUIRED })
  }
  // employment_type defaults to 'employee' on create, so an absent type is one.
  if (fokId !== null && (row.employment_type ?? 'employee') !== 'employee') {
    issues.push({ field: 'fora_fok_id', message: FORA_FOK_EMPLOYEE_ONLY })
  }
  return issues
}
