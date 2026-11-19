import { COLUMN_MAPPING_CONFIDENCE } from '../register-import-flow'
import { cellOrNull } from './column-utils'

/**
 * Checks a detected column mapping against the file's data before the review
 * step trusts it (customers, suppliers).
 *
 * Detection reads headers only, and a confident wrong guess skipped the
 * mapping step and turned every row red: the Spiris customer export's
 * "InvoicePostalCode" was read as the e-mail column, every postal code failed
 * the e-mail check, the review step could only delete rows and the import
 * button never enabled (PH 204). A column whose every filled cell fails the
 * shape of the field it was mapped to is not that field, whatever its header
 * says.
 */

/** One field whose cells have a shape the mapping can be checked against. */
export interface ColumnShapeCheck<K extends string> {
  /** The detected-columns key, e.g. 'email_col'. */
  key: K
  /** The field as the mapping step labels it, e.g. 'E-post'. */
  field: string
  /** True when one filled cell has the field's shape. */
  accepts: (value: string) => boolean
}

/**
 * Filled cells needed before the data can overrule a header: one bad e-mail
 * is a typo in that row, two or more and none valid is a wrong column.
 */
const MIN_CELLS_TO_OVERRULE = 2

/** Under the wizard's gate, so the mapping step opens for the user to choose. */
const BELOW_MAPPING_GATE = COLUMN_MAPPING_CONFIDENCE - 0.05

/** The header as the user wrote it, or its position when it is blank. */
export function columnName(headers: readonly string[], index: number): string {
  return headers[index]?.trim() || `kolumn ${index + 1}`
}

/**
 * Unmap every checked column whose filled cells all fail its field's shape,
 * and say so. When anything was unmapped the confidence drops under the
 * mapping gate, so the wizard opens the mapping step with that field empty
 * instead of a review step whose rows cannot be fixed. Only for a detected
 * mapping: a mapping the user chose is used as chosen.
 */
export function unmapColumnsTheDataContradicts<C extends { confidence: number }, K extends keyof C & string>(
  columns: C,
  headers: readonly string[],
  dataRows: readonly (readonly unknown[])[],
  checks: readonly ColumnShapeCheck<K>[],
): { columns: C; warnings: string[] } {
  let result = columns
  const warnings: string[] = []

  for (const check of checks) {
    const index = result[check.key]
    if (typeof index !== 'number' || index < 0) continue
    const cells = dataRows
      .map((row) => cellOrNull(row[index]))
      .filter((v): v is string => v !== null)
    if (cells.length < MIN_CELLS_TO_OVERRULE || cells.some(check.accepts)) continue

    result = { ...result, [check.key]: null }
    warnings.push(
      `Kolumnen "${columnName(headers, index)}" läses inte in som ${check.field}: `
      + `inget värde i den passar fältet (till exempel "${cells[0]}"). `
      + 'Välj rätt kolumn i kolumnmappningen.',
    )
  }

  if (warnings.length > 0 && result.confidence >= BELOW_MAPPING_GATE) {
    result = { ...result, confidence: BELOW_MAPPING_GATE }
  }
  return { columns: result, warnings }
}
