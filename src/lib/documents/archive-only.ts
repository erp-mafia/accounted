/**
 * An archive-only upload (crm#1848): an agent stores the underlag of a
 * verifikat that is already posted, to link it afterwards
 * (gnubok_link_documents_to_vouchers), and says so with archive_only on
 * gnubok_complete_document_upload. The document is archived like any other;
 * what is left out is the booking flow: no inbox item is filed and the inbox
 * reader makes no AI reading.
 *
 * The upload states that on the document row, as the reason no extraction
 * was made (extraction_model, the stamp every skipped reading already
 * carries). Arkiv types every new document on its own clock and would
 * otherwise queue a receipt or invoice in Underlag minutes later, before the
 * link lands (invoice-inbox route-from-arkiv.ts reads the stamp).
 *
 * The stamp holds only until the document is read for a booking after all:
 * a later extraction writes its own stamp over it, and from then on the
 * document is an ordinary archived one.
 */
export const ARCHIVE_ONLY_SKIP = 'archive_only'

/** The extraction_model stamp of an archive-only upload (extractionStamp of a skip). */
export const ARCHIVE_ONLY_STAMP = `skipped:${ARCHIVE_ONLY_SKIP}`

/** Uploaded archive-only and not read for a booking since. */
export function isArchiveOnlyUpload(doc: { extraction_model?: string | null }): boolean {
  return doc.extraction_model === ARCHIVE_ONLY_STAMP
}
