import type { SupabaseClient } from '@supabase/supabase-js'
import type { CreateJournalEntryInput, JournalEntry } from '@/types'
import { createJournalEntry, findFiscalPeriod } from './engine'

/**
 * Settlement voucher for a rot/rut payout from Skatteverket.
 *
 * When the agency pays out a begäran (one lump sum per request), the 1513
 * receivable created at invoicing (fakturamodellen) clears against the bank:
 *
 *   Debit  19xx bank account (default 1930)  [amount]
 *   Credit 1513 Skattereduktion rot/rut      [amount]
 *
 * One voucher per payout request: that mirrors the actual bank transaction.
 * At partial approval (delvis beviljad) the paid amount clears here and the
 * remainder stays on 1513 until the user corrects it (kundfordran/kundförlust
 * depending on the outcome with the buyer): deliberately manual, never
 * guessed.
 */
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
  const fiscalPeriodId = await findFiscalPeriod(supabase, companyId, params.paymentDate)
  if (!fiscalPeriodId) {
    throw new Error(`No open fiscal period found for payment date ${params.paymentDate}`)
  }

  const amount = Math.round(params.amount * 100) / 100
  const bankAccount = params.bankAccount ?? '1930'
  const label = params.deductionType === 'rot' ? 'ROT' : 'RUT'
  const description = `Utbetalning ${label}-avdrag från Skatteverket (${params.requestName})`

  const input: CreateJournalEntryInput = {
    fiscal_period_id: fiscalPeriodId,
    entry_date: params.paymentDate,
    description,
    source_type: 'rot_rut_payout',
    source_id: params.requestId,
    lines: [
      {
        account_number: bankAccount,
        debit_amount: amount,
        credit_amount: 0,
        line_description: description,
      },
      {
        account_number: '1513',
        debit_amount: 0,
        credit_amount: amount,
        line_description: description,
      },
    ],
  }

  return createJournalEntry(supabase, companyId, userId, input)
}
