import { isUuid } from '@/lib/invariants/uuid'

/**
 * Where a proposal's underlag is, read off the staged operation.
 *
 * Only the two link previews showed the document they were about; a proposal
 * that books an underlag (create_voucher from the inbox, a supplier invoice,
 * an expense claim) or removes one printed its figures and left the approver
 * to find the document somewhere else. The document is resolved here for
 * every operation type, so a new type that carries a document shows it
 * without its preview having to remember to.
 */

/** Previews that render their document themselves, beside what it is linked to. */
const RENDERS_OWN_DOCUMENT = new Set(['attach_document_to_transaction', 'link_document_to_voucher'])

/** The supplier invoice's own document is the underlag; the staged operation carries only the invoice id. */
const SUPPLIER_INVOICE_TYPES = new Set(['link_supplier_invoice_voucher', 'approve_supplier_invoice'])

/** Once resolved, the file these point at may be gone. */
const REMOVES_DOCUMENT = new Set(['delete_document', 'delete_inbox_item'])

/** A file by its id, as opposed to a supplier invoice whose file is looked up. */
export interface DocumentFileRef {
  kind: 'document'
  documentId: string
  fileName: string | null
  mime: string | null
}

export type ProposalDocumentRef = DocumentFileRef | { kind: 'supplier_invoice'; supplierInvoiceId: string }

export interface ProposalDocumentInput {
  operation_type: string
  preview_data?: unknown
  params?: unknown
  status?: string
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null
}

export function proposalDocumentRef(op: ProposalDocumentInput): ProposalDocumentRef | null {
  if (RENDERS_OWN_DOCUMENT.has(op.operation_type)) return null
  if (REMOVES_DOCUMENT.has(op.operation_type) && op.status != null && op.status !== 'pending') return null
  const params = record(op.params)
  const preview = record(op.preview_data)

  const documentId = isUuid(params.document_id)
    ? params.document_id
    : isUuid(preview.document_id)
      ? preview.document_id
      : null
  if (documentId) {
    return {
      kind: 'document',
      documentId,
      fileName: text(preview.document_file_name) ?? text(preview.file_name),
      mime: text(preview.document_mime_type),
    }
  }
  if (SUPPLIER_INVOICE_TYPES.has(op.operation_type) && isUuid(params.supplier_invoice_id)) {
    return { kind: 'supplier_invoice', supplierInvoiceId: params.supplier_invoice_id }
  }
  return null
}

/**
 * The file on a bank row, read off an answer of GET
 * /api/transactions/[id]/underlag (the document pinned to the row, or
 * matched to it from the inbox). Null when the row has none. One reading for
 * the proposal that names one bank row and the one that names several.
 */
export function bankRowDocumentRef(answer: unknown): DocumentFileRef | null {
  const document = record(record(answer).document)
  if (!isUuid(document.id)) return null
  return { kind: 'document', documentId: document.id, fileName: text(document.file_name), mime: text(document.mime_type) }
}
