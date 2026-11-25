/**
 * The proposals whose verifikat their approval builds at the click, so their
 * staged preview states no rows: a supplier invoice from the inbox
 * (create_supplier_invoice_from_inbox) is registered by the approval, and its
 * registration verifikat is built from the invoice it registers. The card
 * beside a row's Godkänn in Rutin asks the server for those rows
 * (GET /api/pending-operations/[id]/verifikat), which works them out with the
 * approval's own code and writes nothing (lib/pending-operations/approval-verifikat.ts).
 *
 * Pure, with no server imports: the card and the route both read it.
 */
import { isRegisterBookedInvoiceParams } from '@/lib/invoices/register-booked-invoice-mode'

/** True for a proposal whose verifikat rows are built at the click, not staged. */
export function verifikatBuiltAtApproval(op: {
  operation_type: string
  params?: Record<string, unknown> | null
}): boolean {
  // A registration of an already-booked invoice posts nothing: its own sentence says so.
  return op.operation_type === 'create_supplier_invoice_from_inbox' && !isRegisterBookedInvoiceParams(op.params)
}

/** One verifikat the approval would post: its rows in kronor, as the engine gets them. */
export interface BuiltVerifikat {
  entry_date: string
  lines: Array<{
    account_number: string
    debit_amount: number
    credit_amount: number
    dimensions?: Record<string, string>
  }>
  total_debit: number
  total_credit: number
}

/** What approving the proposal would post, worked out now. */
export type ApprovalVerifikatAnswer =
  /** These verifikat, in the order the approval posts them. */
  | { posts: 'verifikat'; verifikat: BuiltVerifikat[] }
  /**
   * No verifikat now: under kontantmetoden the invoice is booked when it is
   * paid, and a company that defers invoice booking books it later.
   */
  | { posts: 'nothing' }
  /**
   * Known only at the click: an invoice in another currency staged without a
   * rate, which the approval asks Riksbanken for (and keeps in the shared rate
   * cache). The preview asks Riksbanken nothing and writes nothing.
   */
  | { posts: 'at_approval' }
  /** The approval would be refused, and why, in both languages. */
  | { posts: 'refused'; code: string; message_sv: string; message_en: string }
