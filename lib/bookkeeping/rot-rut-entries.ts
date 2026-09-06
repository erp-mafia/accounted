import type { SupabaseClient } from '@supabase/supabase-js'
import type { CreateJournalEntryInput, JournalEntry } from '@/types'
import { roundOre } from '@/lib/money'
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
  }))
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
      ...legs.map((leg) => ({
        account_number: '1513',
        debit_amount: 0,
        credit_amount: leg.amount,
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
      },
    ],
  })
}
