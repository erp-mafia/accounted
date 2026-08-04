import type { SupabaseClient } from '@supabase/supabase-js'
import { createJournalEntry } from '@/lib/bookkeeping/engine'

export async function seedSandboxJournalEntries(params: {
  supabase: SupabaseClient
  companyId: string
  userId: string
  fiscalPeriodId: string
  invoiceId: string
  invoiceEntryDate: string
  paymentEntryDate: string
}) {
  const {
    supabase,
    companyId,
    userId,
    fiscalPeriodId,
    invoiceId,
    invoiceEntryDate,
    paymentEntryDate,
  } = params
  const revenueDims = { '1': 'BUTIK', '6': 'P001' }

  const invoiceEntry = await createJournalEntry(supabase, companyId, userId, {
    fiscal_period_id: fiscalPeriodId,
    voucher_series: 'A',
    entry_date: invoiceEntryDate,
    description: 'Faktura F-2026001, Björk & Partner AB',
    source_type: 'invoice_created',
    source_id: invoiceId,
    lines: [
      {
        account_number: '1510',
        debit_amount: 18750,
        credit_amount: 0,
        dimensions: {},
      },
      {
        account_number: '3001',
        debit_amount: 0,
        credit_amount: 15000,
        dimensions: revenueDims,
      },
      {
        account_number: '2611',
        debit_amount: 0,
        credit_amount: 3750,
        dimensions: {},
      },
    ],
  })

  const paymentEntry = await createJournalEntry(supabase, companyId, userId, {
    fiscal_period_id: fiscalPeriodId,
    voucher_series: 'A',
    entry_date: paymentEntryDate,
    description: 'Betalning faktura F-2026001, Björk & Partner AB',
    source_type: 'invoice_paid',
    source_id: invoiceId,
    lines: [
      {
        account_number: '1930',
        debit_amount: 18750,
        credit_amount: 0,
        dimensions: {},
      },
      {
        account_number: '1510',
        debit_amount: 0,
        credit_amount: 18750,
        dimensions: {},
      },
    ],
  })

  return { invoiceEntry, paymentEntry }
}
