/**
 * Commitments and holdings (Bolaget W5): what the company has promised and
 * what it holds that the ledger alone does not show. Agreements with their
 * expected payments and dates, ställda säkerheter and eventualförpliktelser
 * (ÅRL 5 kap. 14-16 §§), and the group structure. Descriptive things stay
 * documents-first: a thin row (what, counterparty, dates, document link) so
 * lists and deadlines work; nothing is read out of a document here.
 */

/** Every agreement kind: the ten the Arkiv pipeline derives, plus four that are only registered by hand. */
export const AGREEMENT_KINDS = [
  'rental',
  'lease',
  'loan',
  'subscription',
  'insurance',
  'employment',
  'shareholder',
  'investment',
  'customer',
  'permit',
  'ip_right',
  'domain',
  'guarantee',
  'other',
] as const
export type ManualAgreementKind = (typeof AGREEMENT_KINDS)[number]

export const AGREEMENT_PERIODS = ['monthly', 'quarterly', 'yearly', 'one_time'] as const
export type AgreementPeriod = (typeof AGREEMENT_PERIODS)[number]

export const AGREEMENT_STATUSES = ['active', 'ended'] as const
export type AgreementStatus = (typeof AGREEMENT_STATUSES)[number]

/** Kinds whose money arrives rather than leaves: a customer's fee, an investment. */
export const INCOMING_AGREEMENT_KINDS: readonly ManualAgreementKind[] = ['customer', 'investment']

/** Ställda säkerheter by K2 type (punkt 18.13-18.14), then eventualförpliktelser (18.15-18.19). */
export const SECURITY_KINDS = [
  'foretagsinteckning',
  'fastighetsinteckning',
  'aganderattsforbehall',
  'belanad_fordran',
  'other_security',
  'borgen',
  'other_contingency',
] as const
export type SecurityKind = (typeof SECURITY_KINDS)[number]

/** The kinds that are ställda säkerheter; the rest are eventualförpliktelser. */
export const PLEDGED_SECURITY_KINDS: readonly SecurityKind[] = [
  'foretagsinteckning',
  'fastighetsinteckning',
  'aganderattsforbehall',
  'belanad_fordran',
  'other_security',
]

export function isPledgedSecurity(kind: SecurityKind): boolean {
  return PLEDGED_SECURITY_KINDS.includes(kind)
}

export const GROUP_RELATIONS = ['parent', 'subsidiary', 'associate'] as const
export type GroupRelation = (typeof GROUP_RELATIONS)[number]

/** An agreement as every door answers it. */
export interface AgreementView {
  agreement_id: string
  kind: string
  origin: 'derived' | 'manual'
  title: string
  status: AgreementStatus
  counterparty_party_id: string | null
  counterparty_name: string | null
  starts_on: string | null
  ends_on: string | null
  notice_months: number | null
  renewal_terms: string | null
  amount: number | null
  currency: string
  period: AgreementPeriod | null
  first_due_on: string | null
  principal: number | null
  interest_rate: number | null
  document_id: string | null
  source_document_id: string | null
  notes: string | null
  next_payment: {
    due_on: string
    amount: number
    currency: string
    status: 'expected' | 'matched' | 'missed' | 'waived'
    direction: 'out' | 'in'
  } | null
  notice_deadline: { due_date: string; title: string } | null
  end_deadline: { due_date: string; title: string } | null
}

export interface ObligationView {
  obligation_id: string
  agreement_id: string
  agreement_title: string
  kind: string
  due_on: string
  amount: number
  currency: string
  direction: 'out' | 'in'
  status: 'expected' | 'matched' | 'missed' | 'waived'
  amount_is_estimate: boolean
  transaction_id: string | null
}

export interface SecurityView {
  security_id: string
  kind: SecurityKind
  pledged: boolean
  description: string
  amount: number
  in_favour_of_party_id: string | null
  in_favour_of_name: string | null
  for_group_company: boolean
  agreement_id: string | null
  valid_from: string | null
  valid_to: string | null
  document_id: string | null
  notes: string | null
}

export interface GroupLinkView {
  group_link_id: string
  relation: GroupRelation
  counterparty_name: string
  counterparty_org_number: string | null
  counterparty_registered_office: string | null
  party_id: string | null
  ownership_percent: number | null
  voting_percent: number | null
  valid_from: string | null
  valid_to: string | null
  bas_account: string | null
  linked_company_id: string | null
  notes: string | null
}

/** Whether a dated row holds on a day: from and to inclusive, an open end runs on. */
export function activeOn(row: { valid_from: string | null; valid_to: string | null }, day: string): boolean {
  return (row.valid_from == null || row.valid_from <= day) && (row.valid_to == null || row.valid_to >= day)
}
