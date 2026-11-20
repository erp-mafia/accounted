/**
 * What gnubok_create_supplier_invoice_from_inbox answers for a credit note
 * (issue #2980): nothing is staged, because a supplier's credit note is never
 * a payable of its own. The answer says which invoice it credits and hands
 * over to gnubok_credit_supplier_invoice with the inbox item, which books the
 * credit on the credit note's date with its document as underlag. A partial
 * credit note, an amount that does not fit, or no single invoice is handed
 * back to the agent (and the user) to decide, never guessed.
 */
import type { CreditTargetResolution } from '@/lib/supplier-invoices/credit-target'

export interface CreditNoteHandoff {
  message: string
  preview: Record<string, unknown>
  next?: { description: string; tool?: string; args?: Record<string, unknown> }
}

export function creditNoteHandoff(inboxItemId: string, target: CreditTargetResolution): CreditNoteHandoff {
  const preview = { document_kind: 'credit_note', credit_target: target }
  const invoice = target.invoice
  const label = invoice
    ? `${invoice.supplier_name ?? 'the supplier'}'s invoice ${invoice.supplier_invoice_number ?? invoice.supplier_invoice_id} (${invoice.total} ${invoice.currency})`
    : ''
  const lead = 'This inbox item is a credit note, not a supplier invoice: nothing was staged.'

  switch (target.status) {
    case 'matched':
      return {
        message: `${lead} It credits ${label}. Credit that invoice with the inbox item: the credit note's date, number and document are used.`,
        preview,
        next: {
          description: `Stage the credit of ${label} from this credit note.`,
          tool: 'gnubok_credit_supplier_invoice',
          args: { supplier_invoice_id: invoice!.supplier_invoice_id, inbox_item_id: inboxItemId },
        },
      }
    case 'partial':
      return {
        message: `${lead} It credits only part of ${label} (${target.credit_total} of ${invoice!.total}). gnubok_credit_supplier_invoice always credits the whole invoice, so do not use it: hand over to the user (book the credit note as its own verifikat in the app).`,
        preview,
      }
    case 'amount_differs':
      return {
        message: `${lead} It references ${label}, but its amount was not read, exceeds the invoice or is in another currency. Check the amount on the underlag and correct it with gnubok_set_inbox_extracted_data, then call this tool again.`,
        preview,
        next: {
          description: 'Correct totals on the inbox item from the underlag, then retry.',
          tool: 'gnubok_set_inbox_extracted_data',
          args: { inbox_item_id: inboxItemId },
        },
      }
    case 'already_credited':
      return {
        message: `${lead} The invoice it references, ${label}, is already credited. Tell the user; do not credit again.`,
        preview,
      }
    case 'ambiguous':
      return {
        message: `${lead} ${target.candidates.length} invoices fit it (preview.credit_target.candidates). Ask the user which one it credits, then call gnubok_credit_supplier_invoice with that supplier_invoice_id and this inbox_item_id.`,
        preview,
        next: {
          description: 'After the user picks the invoice from the candidates, stage its credit with this inbox item.',
          tool: 'gnubok_credit_supplier_invoice',
          args: { inbox_item_id: inboxItemId },
        },
      }
    default:
      return {
        message:
          target.candidates.length > 0
            ? `${lead} No invoice matches its reference or amount. preview.credit_target.candidates lists the supplier's invoices that can still be credited: ask the user which one it credits. If it is only part of an invoice, hand over.`
            : `${lead} No registered invoice from this supplier matches it. Find the original with gnubok_list_supplier_invoices, or ask the user.`,
        preview,
        ...(target.candidates.length > 0
          ? {
              next: {
                description: 'After the user picks the invoice, stage its credit with this inbox item.',
                tool: 'gnubok_credit_supplier_invoice',
                args: { inbox_item_id: inboxItemId },
              },
            }
          : {}),
      }
  }
}
