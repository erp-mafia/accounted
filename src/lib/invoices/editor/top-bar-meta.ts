import type { InvoiceDocumentType } from '@/types'

/**
 * The invoice editor's top-bar meta line: what the document is right now and,
 * while it has no number of its own, the number it will get and when
 * ("Utkast · får nummer 004 när den skickas"). It replaced two chips beside
 * the preview tabs ("1 sida", "Nummer 004 preliminärt"): the number belongs
 * with the document's state, and the page count is said by the status line
 * under the preview only when there is more than one page.
 */

/** When a document of this type takes its number. */
export type NumberingMoment = 'save' | 'send'

export function numberingMoment(documentType: InvoiceDocumentType): NumberingMoment {
  // Quotes and följesedlar are numbered at insert from their own series. A
  // faktura or proforma takes its F-number when it is issued: sent, marked
  // sent or created; an unnumbered "Spara som utkast" draft at finalize.
  return documentType === 'quote' || documentType === 'delivery_note' ? 'save' : 'send'
}

/** One segment of the meta line, as a key of the invoice_editor_shell namespace. */
export type TopBarMetaPart =
  | { key: 'meta_draft' }
  | { key: 'meta_saved'; values: { time: string } }
  | { key: 'meta_copy'; values: { number: string } }
  | { key: 'meta_number_on_send' | 'meta_number_on_save'; values: { number: string } }

export interface TopBarMetaInput {
  /** A received självfaktura carries the seller's number: no meta at all. */
  selfBilled: boolean
  /** Copy mode: the number of the document being copied. */
  copyOf: string | null
  /** Edit mode: when the draft was last saved, already formatted. */
  savedAt: string | null
  documentType: InvoiceDocumentType
  /**
   * The number the document will get; null when it already has its own
   * (edit mode, numbered) or none is known (a följesedel, a failed peek).
   */
  preliminaryNumber: string | null
}

/** The meta line's segments, joined with " · " by the caller. Empty = no meta. */
export function resolveTopBarMeta(input: TopBarMetaInput): TopBarMetaPart[] {
  if (input.selfBilled) return []
  const parts: TopBarMetaPart[] = []
  if (input.copyOf) parts.push({ key: 'meta_copy', values: { number: input.copyOf } })
  else if (input.savedAt) parts.push({ key: 'meta_saved', values: { time: input.savedAt } })
  else parts.push({ key: 'meta_draft' })
  const number = input.preliminaryNumber?.trim()
  if (number) {
    parts.push({
      key: numberingMoment(input.documentType) === 'save' ? 'meta_number_on_save' : 'meta_number_on_send',
      values: { number },
    })
  }
  return parts
}
