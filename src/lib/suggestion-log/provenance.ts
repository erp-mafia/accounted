import { createHash } from 'node:crypto'
import { currentAppVersion } from '@/lib/reports/app-version'
import type { Transaction } from '@/types'
import type { LoggedSuggestion } from './classify'
import type { InboxSuggestion } from './inbox-classify'

/**
 * What a decision row records about the inputs and rules it was made on,
 * computed in the snapshot step BEFORE the booking (never derived later at
 * read time). Server-only: hashing uses node:crypto.
 *
 * input_hash = SHA-256 (lowercase hex) of the canonical JSON of the inputs.
 * Canonical JSON is RFC 8785 (JCS) for the values hashed here: object keys
 * sorted by UTF-16 code unit, no whitespace, members whose value is
 * undefined dropped, arrays in order, numbers in their shortest JSON form.
 * Anyone can recompute it from the row and the records it names:
 *
 *   bank line (schema 'bank_line.v1'):
 *     { schema, transaction: {BANK_LINE_INPUT_FIELDS, null when absent},
 *       document_sha256: document_attachments.sha256_hash of the row's
 *       pinned document or null, suggestions: suggestion_log.suggestions
 *       with matches_final removed from every element }
 *   underlag (schema 'inbox_item.v1'):
 *     { schema, document_id, document_sha256, suggestions: as above }
 *
 * The transaction fields are read when the snapshot is taken; a field the
 * person edits later (an unbooked row's working title) no longer matches,
 * which is the point of the hash.
 */

/** The bank-line fields an input hash covers: what the proposals and the booking read. */
export const BANK_LINE_INPUT_FIELDS = [
  'id',
  'date',
  'amount',
  'currency',
  'amount_sek',
  'exchange_rate',
  'description',
  'original_description',
  'merchant_name',
  'mcc_code',
  'reference',
  'counterparty_iban',
  'counterparty_account',
  'counterparty_org_number',
  'cash_account_id',
  'document_id',
] as const satisfies ReadonlyArray<keyof Transaction>

export function canonicalJson(value: unknown): string {
  if (value === undefined || value === null) return 'null'
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v)).join(',')}]`
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>
    const keys = Object.keys(record).filter((k) => record[k] !== undefined).sort()
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(record[k])}`).join(',')}}`
  }
  // Strings, booleans and finite numbers: JSON.stringify is the JCS form; a
  // non-finite number has no JSON form and becomes null, as JSON does.
  return JSON.stringify(value) ?? 'null'
}

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/** A suggestion as offered: matches_final is decided after the booking, so it is no input. */
type Offered<T> = Omit<T, 'matches_final'>

export function bankLineInputHash(input: {
  transaction: Partial<Transaction>
  documentSha256: string | null
  suggestions: Array<Offered<LoggedSuggestion>>
}): string {
  const transaction: Record<string, unknown> = {}
  for (const field of BANK_LINE_INPUT_FIELDS) transaction[field] = input.transaction[field] ?? null
  return sha256Hex(
    canonicalJson({
      schema: 'bank_line.v1',
      transaction,
      document_sha256: input.documentSha256,
      suggestions: input.suggestions,
    }),
  )
}

export function inboxInputHash(input: {
  documentId: string | null
  documentSha256: string | null
  suggestions: Array<Offered<InboxSuggestion>>
}): string {
  return sha256Hex(
    canonicalJson({
      schema: 'inbox_item.v1',
      document_id: input.documentId,
      document_sha256: input.documentSha256,
      suggestions: input.suggestions,
    }),
  )
}

/**
 * A pipeline revision with the running program version (the commit the
 * build was made from, dated in app_releases) as build metadata:
 * 'bank-proposals.1+a38016f12abc'. The revision says when the rules changed
 * on purpose; the program version pins the exact code. A build that does not
 * know its version (self-hosted without the commit SHA) records the revision.
 */
export function withProgramVersion(revision: string): string {
  const program = currentAppVersion()
  return program ? `${revision}+${program}` : revision
}

/** The assistant read's reasoning, kept as a hash: the read itself is overwritten by the next one. */
export function reasoningSha256(reasoning: string | null | undefined): string | null {
  return typeof reasoning === 'string' && reasoning.length > 0 ? sha256Hex(reasoning) : null
}
