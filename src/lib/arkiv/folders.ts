/**
 * The archive as folders (the Dokument tree, 2026-09-24): every document
 * type has one shelf, in a fixed order that reads from the rare and
 * long-lived (agreements, authority letters, corporate records) to the many
 * and routine (receipts, invoices, statements), with the documents nobody
 * has typed yet last, where their question is visible.
 */
export type FolderKey =
  | 'agreements'
  | 'authority'
  | 'corporate'
  | 'receipts'
  | 'supplier_invoices'
  | 'customer_invoices'
  | 'bank_statements'
  | 'other'
  | 'untyped'

export const FOLDER_ORDER: readonly FolderKey[] = [
  'agreements',
  'authority',
  'corporate',
  'receipts',
  'supplier_invoices',
  'customer_invoices',
  'bank_statements',
  'other',
  'untyped',
]

/** A folder with at most this many documents opens on arrival; a bigger one is a heading until clicked. */
export const OPEN_BY_DEFAULT_MAX = 12

export function folderFor(docType: string | null | undefined): FolderKey {
  if (!docType) return 'untyped'
  if (docType.startsWith('agreement.')) return 'agreements'
  if (docType.startsWith('registration.') || docType.startsWith('filing.') || docType.startsWith('decision.')) return 'authority'
  if (docType.startsWith('minutes.') || docType === 'share_subscription_list' || docType === 'annual_report') return 'corporate'
  if (docType === 'receipt') return 'receipts'
  if (docType === 'supplier_invoice' || docType === 'credit_note') return 'supplier_invoices'
  if (docType === 'customer_invoice') return 'customer_invoices'
  if (docType === 'bank_statement' || docType === 'tax_account_statement') return 'bank_statements'
  return 'other'
}

export interface Folder<T> {
  key: FolderKey
  rows: T[]
  /** How many of each type the folder holds, most common first; one entry when the folder is one type. */
  types: Array<{ doc_type: string; count: number }>
}

/** The rows sorted into folders, in FOLDER_ORDER, empty folders left out. */
export function groupByFolder<T extends { doc_type: string | null }>(rows: readonly T[]): Array<Folder<T>> {
  const byKey = new Map<FolderKey, T[]>()
  for (const row of rows) {
    const key = folderFor(row.doc_type)
    const list = byKey.get(key)
    if (list) list.push(row)
    else byKey.set(key, [row])
  }
  return FOLDER_ORDER.filter((key) => byKey.has(key)).map((key) => {
    const list = byKey.get(key) as T[]
    const counts = new Map<string, number>()
    for (const row of list) counts.set(row.doc_type ?? '', (counts.get(row.doc_type ?? '') ?? 0) + 1)
    const types = [...counts.entries()]
      .filter(([doc_type]) => doc_type !== '')
      .map(([doc_type, count]) => ({ doc_type, count }))
      .sort((a, b) => b.count - a.count || a.doc_type.localeCompare(b.doc_type))
    return { key, rows: list, types }
  })
}

/** Open on arrival: the untyped folder always (it asks something), the others when they are small. */
export function openByDefault(key: FolderKey, count: number): boolean {
  // Small folders open; a large untyped one is history still being read, not a pile to sort.
  return count <= OPEN_BY_DEFAULT_MAX
}
