import { formatVoucher } from '@/lib/bookkeeping/voucher-series-resolver'

/**
 * The verifikat a document is already attached to, and why that ends the
 * question of moving it.
 *
 * enforce_document_journal_entry_immutability (latest definition in migration
 * 20260705100000) refuses ANY change of document_attachments.journal_entry_id
 * once it is set, whatever the status of the verifikat holding it: posted,
 * reversed, draft. The only exemption is relink_documents_to_correction,
 * which correctEntry calls to carry the underlag from the corrected verifikat
 * to its correction. Every app-side guard must therefore refuse a move off
 * ANY other holder; one that only refused a posted holder let a document on a
 * reversed verifikat through staging and into a raw trigger error at approval
 * (HTTP 500 "Något gick fel", agent feedback seq 932068, 845101, 824135).
 */
export interface DocumentLinkHolder {
  journal_entry_id: string
  status: string | null
  voucher_series: string | null
  voucher_number: number | null
}

/** "verifikation A12", or the draft wording when the holder has no number yet. */
function holderLabelSv(holder: DocumentLinkHolder | null): string {
  if (!holder) return 'en annan verifikation'
  const label = formatVoucher(holder)
  return label === '-' ? 'ett verifikationsutkast' : `verifikation ${label}`
}

function holderLabelEn(holder: DocumentLinkHolder | null): string {
  if (!holder) return 'another verifikat'
  const label = formatVoucher(holder)
  return label === '-'
    ? `a draft verifikat (journal_entry_id ${holder.journal_entry_id})`
    : `verifikat ${label} (journal_entry_id ${holder.journal_entry_id}, status ${holder.status ?? 'unknown'})`
}

/** Swedish refusal for moving a document off the verifikat that holds it. */
export function documentHeldElsewhereReasonSv(holder: DocumentLinkHolder | null): string {
  const base = `Bilagan är redan kopplad till ${holderLabelSv(holder)} och kan inte flyttas till en annan verifikation (BFL 5 kap 6 §).`
  if (holder?.status === 'reversed') {
    return (
      `${base} Verifikationen är makulerad och behåller sitt underlag. ` +
      'Underlaget följer bara med till en rättelse som görs med Rätta (correct_entry) på den bokförda verifikationen.'
    )
  }
  if (holder?.status === 'posted') {
    return `${base} Är den verifikationen fel, rätta den (Rätta, correct_entry): då följer underlaget med till rättelsen.`
  }
  return base
}

/** English counterpart for message_en, naming the holder by id so an agent can act on it. */
export function documentHeldElsewhereReasonEn(holder: DocumentLinkHolder | null): string {
  const base =
    `The document is already linked to ${holderLabelEn(holder)} and cannot be moved to another verifikat: ` +
    'a document link is permanent once set (BFL 5 kap 6 §).'
  if (holder?.status === 'reversed') {
    return (
      `${base} A reversed verifikat keeps its underlag. Underlag travels to a correction only through ` +
      'gnubok_correct_entry on the posted verifikat, which moves it to the correction automatically.'
    )
  }
  if (holder?.status === 'posted') {
    return `${base} If that verifikat is wrong, correct it with gnubok_correct_entry: the underlag moves to the correction.`
  }
  return base
}

/** The immutability trigger's own refusal text. */
export function isDocumentImmutabilityRefusal(message: string | null | undefined): boolean {
  return !!message && message.includes('BFL_DOCUMENT_IMMUTABILITY')
}

/**
 * Thrown by linkToJournalEntry when the immutability trigger refuses the
 * write. The message keeps the words "already linked" that the document link
 * route maps to DOC_LINK_ALREADY_LINKED (409).
 */
export class DocumentAlreadyLinkedError extends Error {
  readonly code = 'DOC_LINK_ALREADY_LINKED'
  constructor(documentId: string) {
    super(`Failed to link document: document ${documentId} is already linked to a journal entry and the link cannot change`)
    this.name = 'DocumentAlreadyLinkedError'
  }
}
