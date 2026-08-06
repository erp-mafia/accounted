/**
 * Which extracted fields the Underlag rail should show for a document.
 *
 * A kassakvitto has no due date, no OCR reference, no invoice number and no
 * bankgiro: it is already paid. Rendering those as four empty boxes made the
 * rail read as "extraction failed" when in truth the concepts do not exist
 * on the document. The date is mislabelled too: on a receipt the document
 * date is the purchase date, not a "Fakturadatum".
 *
 * Two rules keep this safe when the AI classification is wrong:
 *   1. A field that HAS a value is never hidden.
 *   2. Hiding is reversible in one click (the caller renders a toggle), so
 *      a receipt that really does carry an invoice number stays reachable.
 *
 * React-free on purpose: this repo has no jsdom or testing-library, so
 * display logic is tested here rather than through the component.
 */

/** Concepts that exist on an invoice but not on a paid receipt. */
export const INVOICE_ONLY_FIELD_KEYS: ReadonlySet<string> = new Set([
  'invoice.dueDate',
  'invoice.invoiceNumber',
  'invoice.paymentReference',
  'supplier.bankgiro',
  'supplier.plusgiro',
])

/** Labels that read wrong on a receipt. */
export const RECEIPT_FIELD_LABELS: Readonly<Record<string, string>> = {
  'invoice.invoiceDate': 'Inköpsdatum',
}

export interface VisibleField {
  key: string
  label: string
}

export function selectInboxFields<T extends VisibleField>(opts: {
  /** extracted_data.documentKind; anything but 'receipt' keeps today's list. */
  documentKind: string | null | undefined
  fields: readonly T[]
  /** True when the field currently holds a value (draft or extracted). */
  hasValue: (key: string) => boolean
  /** User clicked "show invoice fields". */
  showAll: boolean
}): { shown: T[]; hiddenCount: number } {
  const { documentKind, fields, hasValue, showAll } = opts
  if (documentKind !== 'receipt') return { shown: [...fields], hiddenCount: 0 }

  const shown: T[] = []
  let hiddenCount = 0
  for (const field of fields) {
    if (!showAll && INVOICE_ONLY_FIELD_KEYS.has(field.key) && !hasValue(field.key)) {
      hiddenCount += 1
      continue
    }
    const label = RECEIPT_FIELD_LABELS[field.key]
    shown.push(label ? { ...field, label } : field)
  }
  return { shown, hiddenCount }
}
