import type { SupabaseClient } from '@supabase/supabase-js'
import type { CreateJournalEntryInput, JournalEntry } from '@/types'
import { ORE_ROUNDING_ACCOUNT, ORE_ROUNDING_SETTLEMENT_MAX, roundOre } from '@/lib/money'
import { createJournalEntry, findFiscalPeriod } from './engine'

/**
 * Settlement voucher for a rot/rut payout from Skatteverket.
 *
 * When the agency pays out a begäran, the 1513 receivable created at
 * invoicing (fakturamodellen) clears against the bank:
 *
 *   Debit  19xx bank account (default 1930)  [amount]
 *   Credit 1513 Skattereduktion rot/rut      [amount]
 *
 * One voucher per bank transfer: that mirrors the actual bank transaction.
 * Skatteverket decides per begäran but pays everything it decided that day
 * in ONE transfer, so a voucher may clear several begäran: one 1513 leg per
 * request (createRotRutPayoutSetEntry), the way match-batch books one bank
 * row against several customer invoices. The request side of the link is
 * rot_rut_payout_requests.settlement_journal_entry_id on every request the
 * voucher settles; source_id carries the first of them.
 *
 * A fully paid begäran also clears the öre its invoices carried on 1513 but
 * the whole-kronor BegartBelopp left out (oreRounding, lib/invoices/
 * rot-rut-receivable.ts): the leg credits 1513 with the full receivable and
 * 3740 Öresavrundning is debited the difference, so the bank leg stays the
 * paid amount:
 *
 *   Debit  19xx bank account                 [paid]
 *   Debit  3740 Öresavrundning               [oreRounding]
 *   Credit 1513 Skattereduktion rot/rut      [paid + oreRounding]
 *
 * At partial approval (delvis beviljad) the paid amount clears here and the
 * remainder stays on 1513 until the user corrects it (kundfordran/kundförlust
 * depending on the outcome with the buyer): deliberately manual, never
 * guessed.
 */
export interface RotRutPayoutLeg {
  requestId: string
  requestName: string
  deductionType: 'rot' | 'rut'
  /** What Skatteverket paid for this begäran (kr). */
  amount: number
  /**
   * The öre the invoices carry on 1513 beyond the paid kronor, under a krona
   * per invoice. Credited to 1513 on top of amount and debited to 3740. Omit
   * or 0 for none.
   */
  oreRounding?: number
  /** Invoices in the begäran: bounds oreRounding (< 1 kr each). Defaults to 1. */
  invoiceCount?: number
}

function deductionLabel(legs: Array<Pick<RotRutPayoutLeg, 'deductionType'>>): string {
  const types = new Set(legs.map((leg) => leg.deductionType))
  if (types.size === 1) return types.has('rut') ? 'RUT' : 'ROT'
  return 'ROT/RUT'
}

function payoutDescription(label: string, names: string[]): string {
  return `Utbetalning ${label}-avdrag från Skatteverket (${names.join(', ')})`
}

export async function createRotRutPayoutSetEntry(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  params: {
    paymentDate: string
    /** BAS 19xx account the payout landed on. Defaults to 1930. */
    bankAccount?: string
    /** One leg per begäran the transfer settles; at least one. */
    legs: RotRutPayoutLeg[]
  },
): Promise<JournalEntry> {
  if (params.legs.length === 0) {
    throw new Error('A rot/rut payout voucher needs at least one begäran')
  }
  const fiscalPeriodId = await findFiscalPeriod(supabase, companyId, params.paymentDate)
  if (!fiscalPeriodId) {
    throw new Error(`No open fiscal period found for payment date ${params.paymentDate}`)
  }

  const legs = params.legs.map((leg) => ({
    ...leg,
    amount: roundOre(leg.amount),
    oreRounding: roundOre(leg.oreRounding ?? 0),
  }))
  // Rounding is the truncation remainder: under a krona per invoice, so a leg
  // may reach a krona or more across several invoices (getRequestReceivable
  // enforces the per-invoice bound). Never negative, never more per leg than
  // the invoices it covers could leave.
  const badRounding = legs.find(
    (leg) =>
      leg.oreRounding < 0 ||
      leg.oreRounding >= ORE_ROUNDING_SETTLEMENT_MAX * Math.max(leg.invoiceCount ?? 1, 1),
  )
  if (badRounding) {
    throw new Error(`Invalid öre rounding ${badRounding.oreRounding} on begäran ${badRounding.requestName}`)
  }
  const total = roundOre(legs.reduce((sum, leg) => sum + leg.amount, 0))
  const bankAccount = params.bankAccount ?? '1930'
  const description = payoutDescription(
    deductionLabel(legs),
    legs.map((leg) => leg.requestName),
  )

  const input: CreateJournalEntryInput = {
    fiscal_period_id: fiscalPeriodId,
    entry_date: params.paymentDate,
    description,
    source_type: 'rot_rut_payout',
    source_id: legs[0].requestId,
    lines: [
      {
        account_number: bankAccount,
        debit_amount: total,
        credit_amount: 0,
        line_description: description,
      },
      ...legs
        .filter((leg) => leg.oreRounding > 0)
        .map((leg) => ({
          account_number: ORE_ROUNDING_ACCOUNT,
          debit_amount: leg.oreRounding,
          credit_amount: 0,
          line_description: `Öresavrundning ${deductionLabel([leg])}-avdrag (${leg.requestName})`,
        })),
      ...legs.map((leg) => ({
        account_number: '1513',
        debit_amount: 0,
        credit_amount: roundOre(leg.amount + leg.oreRounding),
        // A single begäran keeps the voucher text on both legs (as before);
        // a bundle names its own begäran on each 1513 leg.
        line_description:
          legs.length === 1
            ? description
            : payoutDescription(deductionLabel([leg]), [leg.requestName]),
      })),
    ],
  }

  return createJournalEntry(supabase, companyId, userId, input)
}

/** One begäran: the bundle voucher with a single 1513 leg. */
export async function createRotRutPayoutEntry(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  params: {
    requestId: string
    requestName: string
    deductionType: 'rot' | 'rut'
    paymentDate: string
    amount: number
    /** See RotRutPayoutLeg.oreRounding. */
    oreRounding?: number
    /** See RotRutPayoutLeg.invoiceCount. */
    invoiceCount?: number
    /** BAS 19xx account the payout landed on. Defaults to 1930. */
    bankAccount?: string
  },
): Promise<JournalEntry> {
  return createRotRutPayoutSetEntry(supabase, companyId, userId, {
    paymentDate: params.paymentDate,
    bankAccount: params.bankAccount,
    legs: [
      {
        requestId: params.requestId,
        requestName: params.requestName,
        deductionType: params.deductionType,
        amount: params.amount,
        oreRounding: params.oreRounding,
        invoiceCount: params.invoiceCount,
      },
    ],
  })
}

/**
 * Reclaim voucher for the share of a begäran Skatteverket refused.
 *
 * The 1513 fordran booked at issue was never paid by Skatteverket, so it is
 * the buyer's again (HUSFL 2009:194; swedish-invoice-compliance section 8:
 * "SKV denies: Debit 1510, Credit 1513"):
 *
 *   Debit  1510 Kundfordringar               [refused share, per invoice]
 *   Credit 1513 Skattereduktion rot/rut      [refused share, per invoice]
 *
 * One voucher per begäran (source_id = request id, guarded by the partial
 * unique index journal_entries_rot_rut_reclaim_live_unique), one 1510 and one
 * 1513 leg per invoice so the kundreskontra can be read per faktura.
 */
export interface RotRutReclaimLeg {
  invoiceId: string
  invoiceNumber: string | null
  /** The refused share for this invoice (kr). */
  amount: number
}

export async function createRotRutReclaimEntry(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  params: {
    requestId: string
    requestName: string
    deductionType: 'rot' | 'rut'
    bookingDate: string
    /** One leg per invoice with a refused share; at least one, all > 0. */
    legs: RotRutReclaimLeg[]
  },
): Promise<JournalEntry> {
  const legs = params.legs
    .map((leg) => ({ ...leg, amount: roundOre(leg.amount) }))
    .filter((leg) => leg.amount > 0)
  if (legs.length === 0) {
    throw new Error('A rot/rut reclaim voucher needs at least one refused share')
  }
  const fiscalPeriodId = await findFiscalPeriod(supabase, companyId, params.bookingDate)
  if (!fiscalPeriodId) {
    throw new Error(`No open fiscal period found for booking date ${params.bookingDate}`)
  }

  const label = params.deductionType === 'rut' ? 'RUT' : 'ROT'
  const description = `Nekat ${label}-avdrag från Skatteverket (${params.requestName})`
  const legDescription = (leg: RotRutReclaimLeg) =>
    `Nekat ${label}-avdrag faktura ${leg.invoiceNumber ?? leg.invoiceId}`

  const input: CreateJournalEntryInput = {
    fiscal_period_id: fiscalPeriodId,
    entry_date: params.bookingDate,
    description,
    source_type: 'rot_rut_reclaim',
    source_id: params.requestId,
    lines: [
      ...legs.map((leg) => ({
        account_number: '1510',
        debit_amount: leg.amount,
        credit_amount: 0,
        line_description: legDescription(leg),
      })),
      ...legs.map((leg) => ({
        account_number: '1513',
        debit_amount: 0,
        credit_amount: leg.amount,
        line_description: legDescription(leg),
      })),
    ],
  }

  return createJournalEntry(supabase, companyId, userId, input)
}
