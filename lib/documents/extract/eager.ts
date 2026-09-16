import { ACTING_FIELDS } from './acting'
import type { ExtractionSchemaDef } from './schemas'
import { FIELD_PREDICATES } from '@/lib/arkiv/facts/predicates'

/**
 * What is read the moment a document arrives, and what waits for a
 * question. Eager: the fields the map needs to name, date and file a
 * document; the fields something acts on; and the fields that become
 * company facts asked for again and again (who signs, share capital, what
 * the AGM decided). Everything else in a schema is the vocabulary of what
 * an agent may ask a document later (gnubok_ask_document), read from the
 * text at that moment with a page and a quote, never pre-extracted. The
 * record underneath is the full text either way.
 */
const MAP_FIELDS: Record<string, string[]> = {
  receipt: ['merchant_name', 'receipt_date', 'total_amount', 'currency'],
  supplier_invoice: ['supplier_name', 'invoice_number', 'invoice_date', 'due_date', 'total_amount', 'currency'],
  credit_note: ['supplier_name', 'credit_note_number', 'credit_date', 'total_amount', 'currency'],
  customer_invoice: ['customer_name', 'invoice_number', 'invoice_date', 'total_amount', 'currency'],
  bank_statement: ['bank_name', 'period_start', 'period_end', 'closing_balance', 'currency'],
  tax_account_statement: ['period_start', 'period_end', 'closing_balance'],
  'registration.bolagsverket': ['company_name', 'issued_on', 'registration_date'],
  'filing.bolagsverket': ['filing_type', 'filed_on'],
  'decision.skatteverket': ['decision_type', 'decision_date', 'amount'],
  'minutes.board': ['meeting_date'],
  'minutes.agm': ['meeting_date', 'meeting_kind'],
  share_subscription_list: ['decision_date', 'issuer_name'],
  annual_report: ['fiscal_year_start', 'fiscal_year_end', 'signed_on'],
  'agreement.rental': ['premises_address', 'signed_on'],
  'agreement.lease': ['object_description', 'signed_on'],
  'agreement.loan': ['loan_number', 'signed_on'],
  'agreement.subscription': ['service_description', 'signed_on'],
  'agreement.insurance': ['policy_number', 'cover_description', 'signed_on'],
  'agreement.employment': ['role_title', 'starts_on', 'signed_on'],
  'agreement.shareholder': ['company_name', 'parties_summary', 'effective_on', 'signed_on'],
  'agreement.investment': ['signed_on'],
  'agreement.customer': ['service_description', 'signed_on'],
  'agreement.other': ['subject', 'starts_on', 'signed_on'],
  generic: ['counterparty_name', 'counterparty_org_number', 'document_date', 'total_amount', 'currency', 'key_terms'],
}

/** Facts about the company itself are asked for again and again: read them at once. Agreement facts beyond the acting ones wait for a question. */
const FACTS_EAGER_TYPES = new Set([
  'registration.bolagsverket',
  'decision.skatteverket',
  'filing.bolagsverket',
  'minutes.board',
  'minutes.agm',
  'share_subscription_list',
  'annual_report',
])

export function eagerFields(schemaType: string): Set<string> {
  const names = new Set<string>([...(MAP_FIELDS[schemaType] ?? []), ...(ACTING_FIELDS[schemaType] ?? [])])
  if (FACTS_EAGER_TYPES.has(schemaType)) for (const m of FIELD_PREDICATES[schemaType] ?? []) for (const f of [m.field, m.validFromField, m.validToField]) if (f) names.add(f)
  return names
}

/** The schema with only its eager fields: what the two readings are asked for on arrival. */
export function eagerSchema(def: ExtractionSchemaDef): ExtractionSchemaDef {
  const eager = eagerFields(def.schemaType)
  return { ...def, fields: def.fields.filter((f) => eager.has(f.name)) }
}
