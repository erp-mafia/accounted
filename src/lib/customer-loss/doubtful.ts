/**
 * Befarad kundförlust (build spec 4.2 F and F2, product decision F3).
 *
 * A befarad loss is a valuation reserve on the receivable: Dr 6352 / Cr 1519
 * for the open part of the claim net of its VAT. The claim still stands and
 * collection goes on, so the invoice keeps its status, and VAT is untouched
 * until the loss is konstaterad (ML 8 kap 16 § needs a konstaterad loss).
 *
 * Only an invoice that reached the ledger as a fordran gets a reserve: under
 * kontantmetoden an unpaid invoice was never booked, so there is nothing to
 * value (an invoice carried over a year-end is booked by its carry voucher
 * and does get one).
 *
 * When a payment or a credit makes part of the reserve unnecessary, the
 * excess comes back (Dr 1519 / Cr 6352, kind reversed_doubtful) in the same
 * run as the payment: releaseDoubtfulReserve().
 */
import { isOwedInvoiceStatus } from '@/lib/bookkeeping/matchable-statuses'
import type { SupabaseClient } from '@supabase/supabase-js'
import { roundOre, sumOre } from '@/lib/money'
import { createLogger } from '@/lib/logger'
import {
  doubtfulLines,
  reserveReleaseLines,
  reserveTarget,
  totalVat,
  vatSharesOfPart,
  type VatShare,
} from './amounts'
import { openClaimOnLedger, openClaimRefusal } from './eligibility'
import type { CustomerLossErrorCode, CustomerLossOutcome } from './errors'
import { bookDecision } from './record'
import { loadCustomerLossState, type CustomerLossState } from './state'
import type { CreateJournalEntryLineInput } from '@/types'
import { decisionDescription, invoiceLabel } from './text'

const log = createLogger('customer-loss/doubtful')

export interface RecordDoubtfulLossParams {
  invoiceId: string
  entryDate: string
  reason: string
  decidedBy: string
}

export interface DoubtfulPlan {
  /** The reserve to book now: the open part net of VAT, less any reserve already held. */
  reserve: number
  amount: number
  vat: number
  shares: VatShare[]
  lines: CreateJournalEntryLineInput[]
}

/** What a befarad decision would book on the invoice now, or why it cannot. */
export function planDoubtful(state: CustomerLossState): { ok: true; plan: DoubtfulPlan } | { ok: false; code: CustomerLossErrorCode; details?: Record<string, unknown> } {
  const refusal = openClaimRefusal(state)
  if (refusal) return { ok: false, code: refusal }
  if (!state.booked) return { ok: false, code: 'CUSTOMER_LOSS_DOUBTFUL_NOT_BOOKED' }

  const claim = openClaimOnLedger(state)
  if (!claim) return { ok: false, code: 'CUSTOMER_LOSS_LEDGER_MISMATCH' }
  const target = reserveTarget(claim)
  const toBook = roundOre(target - state.reserve)
  if (toBook <= 0) {
    return { ok: false, code: 'CUSTOMER_LOSS_ALREADY_RESERVED', details: { reserve: state.reserve } }
  }

  // The VAT that rides on the reserved part: informational (a reserve never
  // moves VAT), recorded so the row reads amount = net + VAT like the others.
  const fullShares = claim.shares
  const shares: VatShare[] =
    toBook === target
      ? fullShares
      : fullShares
          .map((s) => ({ ...s, vat: roundOre((s.vat * toBook) / target), base: roundOre((s.base * toBook) / target) }))
          .filter((s) => s.vat > 0)
  const vat = totalVat(shares)
  return {
    ok: true,
    plan: {
      reserve: toBook,
      amount: sumOre([toBook, vat]),
      vat,
      shares,
      lines: doubtfulLines(toBook, invoiceLabel(state.invoice)),
    },
  }
}

export async function recordDoubtfulLoss(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  params: RecordDoubtfulLossParams,
): Promise<CustomerLossOutcome> {
  const loaded = await loadCustomerLossState(supabase, companyId, params.invoiceId)
  if (!loaded.ok) return loaded
  const { state } = loaded
  const planned = planDoubtful(state)
  if (!planned.ok) return planned
  const { plan } = planned

  return bookDecision(supabase, companyId, userId, {
    state,
    kind: 'doubtful',
    entryDate: params.entryDate,
    description: decisionDescription('Befarad kundförlust', invoiceLabel(state.invoice), params.reason),
    lines: plan.lines,
    amount: plan.amount,
    net: plan.reserve,
    vat: plan.vat,
    shares: plan.shares,
    reason: params.reason,
    caseId: state.latestCase?.id ?? null,
    decidedBy: params.decidedBy,
  })
}

export interface ReleaseDoubtfulReserveParams {
  invoiceId: string
  /** The date of the payment or credit that made the reserve unnecessary. */
  entryDate: string
  decidedBy: string
  reason: string
}

/**
 * Release the part of a befarad reserve the invoice no longer needs. Returns
 * null when nothing is held or nothing is in excess. Runs whatever
 * CUSTOMER_LOSS_ENABLED says: it keeps the books right for a reserve already
 * booked.
 */
export async function releaseDoubtfulReserve(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  params: ReleaseDoubtfulReserveParams,
): Promise<CustomerLossOutcome | null> {
  const loaded = await loadCustomerLossState(supabase, companyId, params.invoiceId)
  if (!loaded.ok) return null
  const { state } = loaded
  if (state.reserve <= 0) return null

  const stillOpen =
    state.booked &&
    isOwedInvoiceStatus(state.invoice.status) &&
    state.invoice.remaining_amount > 0
  const claim = stillOpen ? openClaimOnLedger(state) : null
  // A claim the ledger and the reskontra disagree on keeps its reserve to the
  // reskontra's remaining amount, as before.
  const target = !stillOpen
    ? 0
    : reserveTarget(
        claim ?? {
          amount: state.invoice.remaining_amount,
          shares: vatSharesOfPart(state.openVat, state.basis, state.invoice.remaining_amount),
        },
      )
  const release = roundOre(state.reserve - target)
  if (release <= 0) return null

  const label = invoiceLabel(state.invoice)
  return bookDecision(supabase, companyId, userId, {
    state,
    kind: 'reversed_doubtful',
    entryDate: params.entryDate,
    description: decisionDescription('Återförd befarad kundförlust', label, params.reason),
    lines: reserveReleaseLines(release, label),
    amount: release,
    net: release,
    vat: 0,
    shares: [],
    reason: params.reason,
    caseId: state.latestCase?.id ?? null,
    decidedBy: params.decidedBy,
  })
}

/**
 * The hook the payment and credit paths call after they committed: releases
 * any excess reserve and never throws (the payment already stands). A
 * refusal (a locked period, say) is logged loudly; the reserve then stays
 * until the next payment, the konstaterad decision or a manual voucher.
 */
export async function releaseDoubtfulReserveAfterChange(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  params: { invoiceId: string; entryDate: string; trigger: 'payment' | 'credit_note' },
): Promise<void> {
  try {
    // One indexed read on every payment: only an invoice with a kundförlust
    // decision goes on to the full release.
    const { data: decisions, error: lookupError } = await supabase
      .from('invoice_write_offs')
      .select('id')
      .eq('company_id', companyId)
      .eq('invoice_id', params.invoiceId)
      .limit(1)
    if (lookupError) throw new Error(lookupError.message)
    if (!decisions || decisions.length === 0) return
    const outcome = await releaseDoubtfulReserve(supabase, companyId, userId, {
      invoiceId: params.invoiceId,
      entryDate: params.entryDate,
      decidedBy: userId,
      reason: params.trigger === 'payment' ? 'Betalning efter befarad kundförlust' : 'Kreditering efter befarad kundförlust',
    })
    if (outcome && !outcome.ok) {
      log.error('befarad reserve not released after a change on the invoice', new Error(outcome.code), {
        companyId,
        invoiceId: params.invoiceId,
        trigger: params.trigger,
        code: outcome.code,
      })
    }
  } catch (error) {
    log.error('befarad reserve release failed', error as Error, {
      companyId,
      invoiceId: params.invoiceId,
      trigger: params.trigger,
    })
  }
}
