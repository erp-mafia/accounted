/**
 * "Godkänn <motpart> automatiskt nästa gång, upp till X kr?": the same
 * counterparty booked the same way N times, proposed as a company grant
 * (lib/grants), the autonomy half of Phase 3.
 *
 * Behind GRANT_SUGGESTIONS (off unless `true` or `1`): Jakob's master
 * switch for the whole feature. With it off this detector never runs, the
 * create_grant executor refuses, and the staging door never asks the claim
 * gate, so nothing changes for anyone.
 *
 * Wakes on transaction.categorized (every categorize door,
 * lib/transactions/categorize-core.ts). company_grant_candidate (migration
 * 20261017100500) reads the evidence in SQL: the company's latest
 * GRANT_SUGGESTION_MIN_BOOKINGS staged categorizations of that counterparty
 * that a person approved (never one a grant let through), still posted and
 * touching exactly the accounts they showed, all with the identical booking
 * pattern, none with anything a grant never covers; no active grant for the
 * counterparty and grants not paused. The proposal is a create_grant
 * operation for exactly that pattern, any key credential of the company,
 * and a limit a little above the largest of those bookings, rounded up. It
 * is high risk and web-only: an owner or admin accepts it in the app,
 * never their agent, and nothing books unattended before that yes.
 *
 * The dedupe key is the counterparty's (hashed: the key itself has spaces
 * and Swedish letters the key format does not allow), so "Visa aldrig"
 * holds for that counterparty whatever pattern comes next.
 *
 * Slice 2, the same rules for a known supplier's invoices from the inbox:
 * it also wakes on supplier_invoice.registered (the executor of every
 * approved gnubok_create_supplier_invoice_from_inbox emits it), and
 * company_supplier_grant_candidate (migration 20261018100300) reads the
 * latest five staged inbox invoices of that supplier a person approved,
 * still posted, never credited, never one a grant let through, all with the
 * identical pattern (VAT treatment, reverse-charge kind, every line's
 * account and VAT rate, the verifikat's accounts) and nothing a grant never
 * covers. The proposal is a create_grant for that supplier by id, with the
 * limit on the invoice total (incl. VAT) by the same rule. Its key is the
 * supplier's id (create_grant:supplier-<uuid>). A database without the
 * function yet (deploy order) proposes nothing, quietly.
 */
import { createHash } from 'node:crypto'
import { roundOre } from '@/lib/money'
import { grantsEnabled } from '@/lib/grants/flag'
import {
  GrantPatternSchema,
  SupplierInvoiceGrantPatternSchema,
  type CreateGrantParams,
  type GrantPattern,
  type SupplierInvoiceGrantPattern,
} from '@/lib/grants/types'
import { SUGGESTION_RANKS } from '../package-proposals'
import type { Detector, DetectorContext, SuggestionProposal } from '../types'

/**
 * GRANT_SUGGESTIONS (lib/grants/flag.ts), Jakob's master switch for the
 * whole grants feature: the detector runs only while it is on.
 */
export const grantSuggestionsEnabled = grantsEnabled

/** How many approved bookings in a row, all the same way, before a grant is proposed. */
export const GRANT_SUGGESTION_MIN_BOOKINGS = 5

export interface GrantCandidate {
  counterpartyKey: string
  counterpartyLabel: string
  pattern: GrantPattern
  bookingCount: number
  maxAmountSek: number
  lastBooked: string | null
}

/** A supplier whose inbox invoices were booked the same way again and again. */
export interface SupplierInvoiceGrantCandidate {
  supplierId: string
  supplierLabel: string
  pattern: SupplierInvoiceGrantPattern
  bookingCount: number
  maxAmountSek: number
  lastBooked: string | null
}

type Subject = { candidate: GrantCandidate } | { supplierCandidate: SupplierInvoiceGrantCandidate }

interface SupplierCandidateRow {
  candidate: boolean
  reason?: string
  supplier_id?: string
  counterparty_label?: string
  pattern?: unknown
  booking_count?: number
  max_amount_sek?: number | string | null
  last_booked?: string | null
}

/** Codes meaning "this database does not have the function yet" (deploy order). */
const NOT_IN_DATABASE_CODES: ReadonlySet<string> = new Set(['42883', '42P01', 'PGRST202', 'PGRST205'])

interface CandidateRow {
  candidate: boolean
  reason?: string
  counterparty_key?: string
  counterparty_label?: string
  pattern?: unknown
  booking_count?: number
  max_amount_sek?: number | string | null
  last_booked?: string | null
}

/**
 * The proposed limit: the largest booking plus a tenth, rounded up to a
 * round number (100 kr steps up to 1 000 kr, 500 kr steps up to 10 000 kr,
 * then 1 000 kr steps). A price that creeps up a little still fits; a
 * different kind of purchase from the same counterparty does not.
 */
export function suggestedGrantLimit(maxAmountSek: number): number {
  const target = roundOre(maxAmountSek * 1.1)
  const step = target <= 1000 ? 100 : target <= 10000 ? 500 : 1000
  return Math.max(step, Math.ceil(roundOre(target / step)) * step)
}

/** "5 000 kr": whole kronor, Swedish grouping. */
export function formatKronor(amount: number): string {
  return `${new Intl.NumberFormat('sv-SE', { maximumFractionDigits: 0 }).format(Math.round(amount))} kr`
}

const VAT_PHRASES: Record<string, string> = {
  standard_25: 'moms 25 %',
  reduced_12: 'moms 12 %',
  reduced_6: 'moms 6 %',
  reverse_charge: 'omvänd betalningsskyldighet',
  exempt: 'ingen moms',
  export: 'export utan moms',
}

/** "konto 6540, moms 25 %": the booking a grant permits, said plainly. */
export function describeGrantPattern(pattern: Pick<GrantPattern, 'account_number' | 'vat_treatment'>): string {
  const vat = pattern.vat_treatment ? (VAT_PHRASES[pattern.vat_treatment] ?? pattern.vat_treatment) : 'momsen som kategorin anger'
  return `konto ${pattern.account_number}, ${vat}`
}

/** The suggestion key per counterparty: create_grant:cp-<16 hex of its SHA-256>. */
export function grantSuggestionKey(counterpartyKey: string): string {
  return `create_grant:cp-${createHash('sha256').update(counterpartyKey, 'utf8').digest('hex').slice(0, 16)}`
}

export function grantProposal(candidate: GrantCandidate): SuggestionProposal {
  const limit = suggestedGrantLimit(candidate.maxAmountSek)
  const booking = describeGrantPattern(candidate.pattern)
  const params: CreateGrantParams = {
    operation_type: 'categorize_transaction',
    counterparty_key: candidate.counterpartyKey,
    counterparty_label: candidate.counterpartyLabel,
    pattern: candidate.pattern,
    amount_limit_sek: limit,
    monthly_limit_sek: null,
    credential: { kind: 'any' },
    evidence: {
      booking_count: candidate.bookingCount,
      max_amount_sek: candidate.maxAmountSek,
      last_booked: candidate.lastBooked,
    },
    source: 'suggestion',
  }
  return {
    key: grantSuggestionKey(candidate.counterpartyKey),
    operationType: 'create_grant',
    params: params as unknown as Record<string, unknown>,
    title: `Godkänn ${candidate.counterpartyLabel} automatiskt nästa gång, upp till ${formatKronor(limit)}?`,
    reason:
      `Samma motpart bokad på samma sätt ${candidate.bookingCount} gånger (${booking}). ` +
      `Med regeln bokför din agent nästa transaktion från ${candidate.counterpartyLabel} likadant utan att fråga, ` +
      `upp till ${formatKronor(limit)}. Allt som avviker väntar på dig som i dag, och du ser varje sådan bokföring under Bokfört enligt regel.`,
    rank: SUGGESTION_RANKS.grant,
    preview: {
      counterparty: candidate.counterpartyLabel,
      booking,
      account_number: candidate.pattern.account_number,
      vat_treatment: candidate.pattern.vat_treatment,
      line_accounts: candidate.pattern.line_accounts,
      amount_limit_sek: limit,
      booking_count: candidate.bookingCount,
      max_amount_sek: candidate.maxAmountSek,
      credential: 'Alla nycklar i företaget',
    },
  }
}

/** "konton 6211 och 6212": the accounts a supplier-invoice rule books the lines on, said plainly. */
function describeAccounts(accounts: string[]): string {
  if (accounts.length === 1) return `konto ${accounts[0]}`
  return `konton ${accounts.slice(0, -1).join(', ')} och ${accounts[accounts.length - 1]}`
}

/** "konto 6212, moms 25 %": what a supplier-invoice rule permits, said plainly. */
export function describeSupplierInvoiceGrantPattern(pattern: Pick<SupplierInvoiceGrantPattern, 'item_lines' | 'vat_treatment'>): string {
  const accounts = [...new Set(pattern.item_lines.map((l) => l.split(':')[0]))]
  return `${describeAccounts(accounts)}, ${VAT_PHRASES[pattern.vat_treatment] ?? pattern.vat_treatment}`
}

/** The suggestion key per supplier: create_grant:supplier-<its id>. */
export function supplierGrantSuggestionKey(supplierId: string): string {
  return `create_grant:supplier-${supplierId.toLowerCase()}`
}

export function supplierInvoiceGrantProposal(candidate: SupplierInvoiceGrantCandidate): SuggestionProposal {
  const limit = suggestedGrantLimit(candidate.maxAmountSek)
  const booking = describeSupplierInvoiceGrantPattern(candidate.pattern)
  const params: CreateGrantParams = {
    operation_type: 'create_supplier_invoice_from_inbox',
    supplier_id: candidate.supplierId,
    counterparty_label: candidate.supplierLabel,
    pattern: candidate.pattern,
    amount_limit_sek: limit,
    monthly_limit_sek: null,
    credential: { kind: 'any' },
    evidence: {
      booking_count: candidate.bookingCount,
      max_amount_sek: candidate.maxAmountSek,
      last_booked: candidate.lastBooked,
    },
    source: 'suggestion',
  }
  return {
    key: supplierGrantSuggestionKey(candidate.supplierId),
    operationType: 'create_grant',
    params: params as unknown as Record<string, unknown>,
    title: `Godkänn ${candidate.supplierLabel} automatiskt nästa gång, upp till ${formatKronor(limit)}?`,
    reason:
      `Samma leverantör bokförd på samma sätt ${candidate.bookingCount} gånger (${booking}). ` +
      `Med regeln registrerar och bokför din agent nästa faktura från ${candidate.supplierLabel} i inkorgen likadant utan att fråga, ` +
      `upp till ${formatKronor(limit)} inklusive moms. Allt som avviker väntar på dig som i dag, och du ser varje sådan bokföring under Bokfört enligt regel.`,
    rank: SUGGESTION_RANKS.grant,
    preview: {
      supplier: candidate.supplierLabel,
      supplier_id: candidate.supplierId,
      booking,
      item_lines: candidate.pattern.item_lines,
      vat_treatment: candidate.pattern.vat_treatment,
      reverse_charge_kind: candidate.pattern.reverse_charge_kind,
      line_accounts: candidate.pattern.line_accounts,
      amount_limit_sek: limit,
      booking_count: candidate.bookingCount,
      max_amount_sek: candidate.maxAmountSek,
      credential: 'Alla nycklar i företaget',
    },
  }
}

/** The candidate for the supplier of the invoice just registered, or null. */
export async function readSupplierGrantCandidate(ctx: DetectorContext, supplierId: string): Promise<SupplierInvoiceGrantCandidate | null> {
  const { data, error } = await ctx.supabase.rpc('company_supplier_grant_candidate', {
    p_company_id: ctx.companyId,
    p_supplier_id: supplierId,
    p_min_count: GRANT_SUGGESTION_MIN_BOOKINGS,
  })
  if (error) {
    // Before migration 20261018100300 there is nothing to read: no suggestion, nothing to log.
    if (!(error.code && NOT_IN_DATABASE_CODES.has(error.code))) {
      ctx.log.warn('supplier grant candidate could not be read; no grant suggestion', { companyId: ctx.companyId, code: error.code, error: error.message })
    }
    return null
  }
  const row = (data ?? null) as SupplierCandidateRow | null
  if (!row?.candidate || !row.supplier_id) return null
  const pattern = SupplierInvoiceGrantPatternSchema.safeParse(row.pattern)
  const maxAmount = Number(row.max_amount_sek)
  if (!pattern.success || !Number.isFinite(maxAmount) || maxAmount <= 0) return null
  return {
    supplierId: row.supplier_id,
    supplierLabel: (row.counterparty_label ?? '').trim().slice(0, 120) || 'Leverantören',
    pattern: pattern.data,
    bookingCount: Number(row.booking_count ?? 0),
    maxAmountSek: maxAmount,
    lastBooked: row.last_booked ?? null,
  }
}

/** The candidate for the bank line just booked, or null (no evidence, unreadable, or the database lacks the function). */
export async function readGrantCandidate(ctx: DetectorContext, transactionId: string): Promise<GrantCandidate | null> {
  const { data, error } = await ctx.supabase.rpc('company_grant_candidate', {
    p_company_id: ctx.companyId,
    p_transaction_id: transactionId,
    p_min_count: GRANT_SUGGESTION_MIN_BOOKINGS,
  })
  if (error) {
    ctx.log.warn('grant candidate could not be read; no grant suggestion', { companyId: ctx.companyId, code: error.code, error: error.message })
    return null
  }
  const row = (data ?? null) as CandidateRow | null
  if (!row?.candidate || !row.counterparty_key) return null
  const pattern = GrantPatternSchema.safeParse(row.pattern)
  const maxAmount = Number(row.max_amount_sek)
  if (!pattern.success || !Number.isFinite(maxAmount) || maxAmount <= 0) return null
  return {
    counterpartyKey: row.counterparty_key,
    counterpartyLabel: (row.counterparty_label ?? row.counterparty_key).trim().slice(0, 120) || row.counterparty_key,
    pattern: pattern.data,
    bookingCount: Number(row.booking_count ?? 0),
    maxAmountSek: maxAmount,
    lastBooked: row.last_booked ?? null,
  }
}

export const grantCandidateDetector: Detector<Subject> = {
  id: 'grant-candidate',
  trigger: { kind: 'event', eventTypes: ['transaction.categorized', 'supplier_invoice.registered'] },
  enabled: grantSuggestionsEnabled,
  subjects: async (ctx, event) => {
    if (event?.type === 'supplier_invoice.registered') {
      const invoice = event.payload.supplierInvoice
      // A credit note is never evidence for a rule.
      if (!invoice || invoice.is_credit_note === true) return []
      const supplierId = invoice.supplier_id
      if (typeof supplierId !== 'string' || !supplierId) return []
      const supplierCandidate = await readSupplierGrantCandidate(ctx, supplierId)
      return supplierCandidate ? [{ supplierCandidate }] : []
    }
    if (event?.type !== 'transaction.categorized') return []
    const transactionId = event.payload.transaction?.id
    if (typeof transactionId !== 'string' || !transactionId) return []
    const candidate = await readGrantCandidate(ctx, transactionId)
    return candidate ? [{ candidate }] : []
  },
  // The evidence was read in one statement with the subject; what is left to
  // hold is that it is enough to stand behind a limit.
  condition: async (_ctx, subject) => {
    const evidence = 'candidate' in subject ? subject.candidate : subject.supplierCandidate
    return evidence.bookingCount >= GRANT_SUGGESTION_MIN_BOOKINGS && evidence.maxAmountSek > 0
  },
  propose: (subject) => ('candidate' in subject ? grantProposal(subject.candidate) : supplierInvoiceGrantProposal(subject.supplierCandidate)),
}
