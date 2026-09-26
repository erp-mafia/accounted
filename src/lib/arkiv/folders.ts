/**
 * The archive as folders (the Dokument tree, 2026-09-24): every document
 * type has one shelf, in a fixed order that reads from the rare and
 * long-lived (agreements, authority letters, corporate records) to the many
 * and routine (receipts, invoices, statements), with the documents nobody
 * has typed yet last, where their question is visible.
 */
import { DOC_TYPES } from '@/lib/documents/classify/taxonomy'

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

export const isFolderKey = (value: string): value is FolderKey => (FOLDER_ORDER as readonly string[]).includes(value)

/** A folder's count and type mix over the whole archive (arkiv_document_type_counts), not over a loaded page. */
export interface FolderCount {
  key: FolderKey
  count: number
  types: Array<{ doc_type: string; count: number }>
}

/** Type counts from the database sorted into folders, in FOLDER_ORDER, empty folders left out. */
export function foldersFromCounts(counts: ReadonlyArray<{ doc_type: string | null; n: number }>): FolderCount[] {
  const byKey = new Map<FolderKey, Map<string, number>>()
  for (const { doc_type, n } of counts) {
    if (!(n > 0)) continue
    const key = folderFor(doc_type)
    const types = byKey.get(key) ?? new Map<string, number>()
    types.set(doc_type ?? '', (types.get(doc_type ?? '') ?? 0) + n)
    byKey.set(key, types)
  }
  return FOLDER_ORDER.filter((key) => byKey.has(key)).map((key) => {
    const types = byKey.get(key) as Map<string, number>
    return {
      key,
      count: [...types.values()].reduce((a, b) => a + b, 0),
      types: [...types.entries()]
        .filter(([doc_type]) => doc_type !== '')
        .map(([doc_type, count]) => ({ doc_type, count }))
        .sort((a, b) => b.count - a.count || a.doc_type.localeCompare(b.doc_type)),
    }
  })
}

/**
 * Which rows a folder holds, as arkiv_document_page takes it: the untyped folder the rows with no type, the
 * other folder every typed row no other folder names (so a type the taxonomy has since dropped is never lost),
 * every other folder its own types.
 */
export function folderQuery(key: FolderKey): { mode: 'in' | 'not_in' | 'untyped'; types: string[] | null } {
  if (key === 'untyped') return { mode: 'untyped', types: null }
  if (key === 'other') return { mode: 'not_in', types: DOC_TYPES.filter((t) => folderFor(t) !== 'other') }
  return { mode: 'in', types: DOC_TYPES.filter((t) => folderFor(t) === key) }
}

/** Open on arrival: the untyped folder always (it asks something), the others when they are small. */
export function openByDefault(key: FolderKey, count: number): boolean {
  // Small folders open; a large untyped one is history still being read, not a pile to sort.
  return count <= OPEN_BY_DEFAULT_MAX
}
