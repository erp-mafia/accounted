import { isDocType, type DocType } from '@/lib/documents/classify/taxonomy'

/**
 * The type the model's free-text guess points at, when its doc_type is only
 * "other". The classifier often knew better than its answer: a receipt
 * addressed to a person was typed "other" with the guess "payment receipt for
 * Vercel cloud services" (prod 2026-09-26), and the dialog then proposed
 * "Övrigt". Null when the guess names nothing we recognise.
 */
export function typeFromSuggestion(suggested: string | null | undefined): DocType | null {
  if (!suggested) return null
  const s = suggested.trim().toLowerCase()
  if (isDocType(s)) return s
  if (/credit[ _-]?note|kreditnota|kreditfaktura/.test(s)) return 'credit_note'
  if (/receipt|kvitto/.test(s)) return 'receipt'
  if (/supplier[ _-]?invoice|leverantörsfaktura|invoice|faktura|bill\b/.test(s)) return 'supplier_invoice'
  if (/bank[ _-]?statement|kontoutdrag/.test(s)) return 'bank_statement'
  return null
}
