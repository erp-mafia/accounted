import type { PeppolReader } from '@/lib/documents/reading/load'
import { parseUblJsonDocument } from './peppol-inbound-ubl'
import { peppolDocumentToExtraction } from './peppol-inbox-delivery'

/**
 * The Peppol side of the one reading (lib/documents/reading): the archive
 * row's UBL-JSON parsed and mapped exactly as the delivery mapped it into
 * the Inkorg, so the reading's xml values line up with the item's own.
 * Passed in by the reading's callers outside the kernel: the inbox block may
 * not import this block.
 */
export const peppolReader: PeppolReader = {
  parse: parseUblJsonDocument,
  toExtraction: peppolDocumentToExtraction,
}
