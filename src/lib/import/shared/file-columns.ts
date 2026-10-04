import { cellOrNull } from './column-utils'

/**
 * One column of an uploaded register file (customers, suppliers, articles), as
 * the review step shows it: the import fields read from it, or none when the
 * import leaves the column behind.
 */
export interface FileColumnUse<K extends string> {
  /** 0-based position in the file. */
  index: number
  /** Header as written in the file, trimmed; '' when the header cell is blank. */
  header: string
  /** Fields read from this column, in the order of `fields`. Empty: not imported. */
  fields: K[]
}

/**
 * Describe how a register import reads its file, column by column, in file
 * order. `columns` is the parse result's `detected_columns` (or the user's
 * mapping); only the keys in `fields` count as fields, so the `confidence`
 * score next to them is never mistaken for a column index.
 *
 * A column with neither a header nor a value in the preview rows is left out:
 * spreadsheets often carry trailing blank columns. A headerless column that
 * holds data stays in, because that data is dropped too.
 */
export function describeFileColumns<K extends string>(
  headers: readonly unknown[],
  previewRows: readonly (readonly unknown[])[],
  columns: Readonly<Record<K, number | null>>,
  fields: readonly K[],
): FileColumnUse<K>[] {
  const width = Math.max(headers.length, ...previewRows.map((row) => row.length))

  const fieldsByIndex = new Map<number, K[]>()
  for (const field of fields) {
    const index = columns[field]
    // Detection writes -1 for a name column it could not find.
    if (index === null || !Number.isInteger(index) || index < 0 || index >= width) continue
    const list = fieldsByIndex.get(index) ?? []
    list.push(field)
    fieldsByIndex.set(index, list)
  }

  const out: FileColumnUse<K>[] = []
  for (let index = 0; index < width; index++) {
    const header = cellOrNull(headers[index]) ?? ''
    const used = fieldsByIndex.get(index) ?? []
    const hasData = previewRows.some((row) => cellOrNull(row[index]) !== null)
    if (used.length === 0 && header === '' && !hasData) continue
    out.push({ index, header, fields: used })
  }
  return out
}
