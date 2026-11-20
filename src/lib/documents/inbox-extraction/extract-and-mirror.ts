import { extractInvoiceFields, type ExtractionInput, type ExtractionOutput } from './extract-invoice-fields'
import { mirrorExtractionToDocument } from './mirror-extraction'

/**
 * Read a document's invoice fields and stamp the outcome onto its row
 * (document_attachments extracted_data / extracted_at / extraction_model), for
 * the doors where nothing else is written in between: the inbox's "Tolka om",
 * the MCP document upload and the document-extraction handler.
 *
 * The inbox upload paths keep the two steps apart on purpose: their mirror
 * follows the inbox row's write (and, deferred, its compare-and-set claim),
 * so a worker that lost the race to a user's retry never overwrites the
 * retry's reading on the document.
 *
 * A throw from the extraction is not stamped: it propagates, and the row
 * keeps whatever reading it had (a "Tolka om" that crashes must not wipe the
 * reading the user was looking at). The document-extraction handler stamps
 * its own failed:exception.
 */
export async function extractAndMirror(
  documentId: string,
  input: ExtractionInput,
): Promise<ExtractionOutput> {
  const extraction = await extractInvoiceFields(input)
  await mirrorExtractionToDocument(documentId, {
    data: extraction.data,
    rawText: extraction.rawText,
    model: extraction.model ?? null,
    skipped: extraction.skipped ?? null,
    failure: extraction.failure ?? null,
  })
  return extraction
}
