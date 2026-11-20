import type { InvoiceDocumentType } from '@/types'

/**
 * The /invoices/new URL contract. The list's "Ny faktura" split button, the
 * quotes page, the command palette and the detail page's "Kopiera" link all
 * land here; the old list-dialog links (/invoices?new=1&quote=1,
 * /invoices?copy=<id>) are rewritten to it, so bookmarks and agent intents
 * keep working.
 *
 *   type=invoice|proforma|quote|delivery_note  preselect the document type
 *   type=self_billed                           a received självfaktura
 *   copy=<id>                                  a new invoice copied from <id>
 */

export const NEW_INVOICE_PATH = '/invoices/new'

export type NewEditorType = InvoiceDocumentType | 'self_billed'

export interface NewEditorParams {
  documentType: InvoiceDocumentType | null
  selfBilled: boolean
  copyFromId: string | null
}

type ParamSource =
  | URLSearchParams
  | Record<string, string | string[] | undefined>

function read(source: ParamSource, key: string): string | null {
  if (source instanceof URLSearchParams) return source.get(key)
  const value = source[key]
  if (Array.isArray(value)) return value[0] ?? null
  return value ?? null
}

function has(source: ParamSource, key: string): boolean {
  return source instanceof URLSearchParams ? source.has(key) : source[key] !== undefined
}

const DOCUMENT_TYPES: readonly InvoiceDocumentType[] = ['invoice', 'proforma', 'quote', 'delivery_note']

export function parseNewEditorParams(source: ParamSource): NewEditorParams {
  const copyFromId = read(source, 'copy')?.trim() || null
  const type = read(source, 'type')
  // Legacy list flags (?quote=1, ?proforma=1, ?self=1) still preselect.
  const selfBilled = !copyFromId && (type === 'self_billed' || has(source, 'self'))
  let documentType: InvoiceDocumentType | null = null
  if (!copyFromId && !selfBilled) {
    if (type && (DOCUMENT_TYPES as readonly string[]).includes(type)) documentType = type as InvoiceDocumentType
    else if (has(source, 'quote')) documentType = 'quote'
    else if (has(source, 'proforma')) documentType = 'proforma'
  }
  return { documentType, selfBilled, copyFromId }
}

export function newEditorHref(options: { type?: NewEditorType; copyFromId?: string } = {}): string {
  const params = new URLSearchParams()
  if (options.copyFromId) params.set('copy', options.copyFromId)
  else if (options.type && options.type !== 'invoice') params.set('type', options.type)
  const qs = params.toString()
  return qs ? `${NEW_INVOICE_PATH}?${qs}` : NEW_INVOICE_PATH
}

/**
 * The editor URL an old list link (?new=1 ..., ?copy=<id>) meant, or null
 * when the list URL does not ask for the editor.
 */
export function legacyListEditorHref(searchParams: URLSearchParams): string | null {
  if (!searchParams.has('new') && !searchParams.has('copy')) return null
  const parsed = parseNewEditorParams(searchParams)
  if (parsed.copyFromId) return newEditorHref({ copyFromId: parsed.copyFromId })
  if (parsed.selfBilled) return newEditorHref({ type: 'self_billed' })
  return newEditorHref({ type: parsed.documentType ?? 'invoice' })
}

// The editor owns the whole dashboard panel like a workspace (form left,
// live PDF right), so MainContainer renders these routes full-bleed: new,
// edit, and the credit page that shares the shell.
const FULL_BLEED_EDITOR_PATHS = [
  /^\/invoices\/new\/?$/,
  /^\/invoices\/[^/]+\/edit\/?$/,
  /^\/invoices\/[^/]+\/credit\/?$/,
]

export function isFullBleedEditorPath(pathname: string): boolean {
  return FULL_BLEED_EDITOR_PATHS.some((pattern) => pattern.test(pathname))
}
