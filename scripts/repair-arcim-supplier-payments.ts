/**
 * One-off prod repair for Arcim Technology AB (2026-06-11).
 *
 * Context: two supplier invoices were left in inconsistent half-states:
 *  - 20250928 (TIC): match-supplier-invoice marked it paid but the payment
 *    voucher failed (AccountsNotInChartError: 3740 missing) and the failure
 *    was swallowed. No payment JE, payments row + tx unlinked to any JE.
 *  - 18299 (RosholmDell): bank sync auto-linked transactions.supplier_invoice_id
 *    at high confidence without booking a payment; invoice stuck 'registered'.
 *  - Both registration vouchers (A64/A65) booked the expense on 5010 (form
 *    default) instead of 5420 / 6580.
 *
 * Runs through the real engine (createJournalEntry / correctEntry) so voucher
 * numbering, balance triggers, and correction links behave exactly as in-app.
 * Idempotent: every step checks its precondition and skips if already done.
 *
 * Usage: npx tsx scripts/repair-arcim-supplier-payments.ts [--execute]
 * Without --execute it only prints the plan and preconditions (dry run).
 */
import fs from 'fs'
import path from 'path'
import { createClient } from '@supabase/supabase-js'
import { createJournalEntry, findFiscalPeriod } from '@/lib/bookkeeping/engine'
import { correctEntry } from '@/lib/core/bookkeeping/storno-service'

const COMPANY_ID = 'ed461bc1-dbb5-4568-ae20-9337515878e2'
const USER_ID = '9762dd12-7009-4ba2-aa9f-f9966d53e077'

const TIC_INVOICE_ID = '580b3c81-ced8-4a5a-8757-97ddef7919d5'
const TIC_PAYMENT_ROW_ID = 'bcfc57d3-2a8a-47cc-8b70-a0650089d9d1'
const TIC_TX_ID = '8e608944-a82c-4a1b-8807-bb7d2d6092b6'
const TIC_REGISTRATION_JE = '667db3a5-c388-42eb-a05f-0b45f26fb3db' // A64

const RD_INVOICE_ID = 'bbb2ecd4-e373-4b1e-9908-927d9c906fbc'
const RD_TX_ID = 'b5339acc-d47c-406a-8f3d-d1d9b4d82f93'
const RD_REGISTRATION_JE = 'f1a06d39-331b-4eb5-92cb-5f47d5e52881' // A65

const PAYMENT_DATE = '2026-06-08'

// BAS 2026 metadata, copied verbatim from lib/bookkeeping/bas-data/
const MISSING_ACCOUNTS = [
  {
    account_number: '3740',
    account_name: 'Öres- och kronutjämning',
    account_class: 3,
    account_group: '37',
    account_type: 'revenue',
    normal_balance: 'debit',
    description: 'Öresskillnad som uppstår vid avrundning av betalningar (öret).',
    sru_code: '7310',
    k2_excluded: false,
  },
  {
    account_number: '6580',
    account_name: 'Advokat- och rättegångskostnader',
    account_class: 6,
    account_group: '65',
    account_type: 'expense',
    normal_balance: 'debit',
    description: 'Advokat- och rättegångskostnader',
    sru_code: '7321',
    k2_excluded: false,
  },
]

function loadEnv(): { url: string; key: string } {
  const envPath = path.resolve(process.cwd(), '.env.local')
  const lines = fs.readFileSync(envPath, 'utf8').split('\n')
  const vars: Record<string, string> = {}
  for (const line of lines) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/)
    if (m) vars[m[1]] = m[2].trim()
  }
  const url = vars.NEXT_PUBLIC_SUPABASE_URL
  const key = vars.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('Missing Supabase env in .env.local')
  if (!url.includes('pwxtzglxptnnvjrpixpg')) {
    throw new Error(`Refusing to run against unexpected project: ${url}`)
  }
  return { url, key }
}

const EXECUTE = process.argv.includes('--execute')

async function main() {
  const { url, key } = loadEnv()
  const supabase = createClient(url, key, { auth: { persistSession: false } })

  const mode = EXECUTE ? 'EXECUTE' : 'DRY RUN'
  console.log(`=== Arcim supplier payment repair: ${mode} ===\n`)

  // ---------- Step 0: verify preconditions ----------
  const { data: tic } = await supabase
    .from('supplier_invoices')
    .select('status, paid_amount, remaining_amount, payment_journal_entry_id')
    .eq('id', TIC_INVOICE_ID).eq('company_id', COMPANY_ID).single()
  const { data: rd } = await supabase
    .from('supplier_invoices')
    .select('status, paid_amount, remaining_amount, payment_journal_entry_id')
    .eq('id', RD_INVOICE_ID).eq('company_id', COMPANY_ID).single()
  if (!tic || !rd) throw new Error('Could not load invoices')
  console.log('TIC invoice:', tic)
  console.log('RD invoice :', rd)

  const fiscalPeriodId = await findFiscalPeriod(supabase, COMPANY_ID, PAYMENT_DATE)
  if (!fiscalPeriodId) throw new Error(`No fiscal period for ${PAYMENT_DATE}`)
  console.log('Fiscal period:', fiscalPeriodId, '\n')

  // ---------- Step 1: ensure 3740 + 6580 exist ----------
  for (const acc of MISSING_ACCOUNTS) {
    const { data: existing } = await supabase
      .from('chart_of_accounts')
      .select('id')
      .eq('company_id', COMPANY_ID)
      .eq('account_number', acc.account_number)
      .maybeSingle()
    if (existing) {
      console.log(`[skip] account ${acc.account_number} already in chart`)
      continue
    }
    console.log(`[plan] add account ${acc.account_number} ${acc.account_name}`)
    if (EXECUTE) {
      const { error } = await supabase.from('chart_of_accounts').insert({
        ...acc,
        company_id: COMPANY_ID,
        user_id: USER_ID,
        is_active: true,
      })
      if (error) throw new Error(`Insert ${acc.account_number} failed: ${error.message}`)
      console.log(`[done] account ${acc.account_number} added`)
    }
  }

  // ---------- Step 2: TIC payment voucher + link backfill ----------
  if (tic.payment_journal_entry_id) {
    console.log('[skip] TIC already has payment_journal_entry_id')
  } else {
    console.log('[plan] TIC payment voucher: D 2440 11231.25 / K 1930 11231.00 / K 3740 0.25')
    if (EXECUTE) {
      const je = await createJournalEntry(supabase, COMPANY_ID, USER_ID, {
        fiscal_period_id: fiscalPeriodId,
        entry_date: PAYMENT_DATE,
        description:
          'Utbetalning leverantörsfaktura 20250928, The Intelligence Company AB (publ)',
        source_type: 'supplier_invoice_paid',
        source_id: TIC_INVOICE_ID,
        lines: [
          { account_number: '2440', debit_amount: 11231.25, credit_amount: 0, line_description: 'Kvittning leverantörsskuld' },
          { account_number: '1930', debit_amount: 0, credit_amount: 11231, line_description: 'Utbetalning från bank' },
          { account_number: '3740', debit_amount: 0, credit_amount: 0.25, line_description: 'Öresavrundning' },
        ],
      })
      console.log(`[done] TIC payment voucher ${je.voucher_series}-${je.voucher_number} (${je.id})`)

      const upd1 = await supabase.from('supplier_invoices')
        .update({ payment_journal_entry_id: je.id, transaction_id: TIC_TX_ID })
        .eq('id', TIC_INVOICE_ID).eq('company_id', COMPANY_ID)
      if (upd1.error) throw new Error(`TIC invoice backfill failed: ${upd1.error.message}`)

      const upd2 = await supabase.from('supplier_invoice_payments')
        .update({ journal_entry_id: je.id })
        .eq('id', TIC_PAYMENT_ROW_ID).eq('company_id', COMPANY_ID)
      if (upd2.error) throw new Error(`TIC payment row backfill failed: ${upd2.error.message}`)

      const upd3 = await supabase.from('transactions')
        .update({ journal_entry_id: je.id })
        .eq('id', TIC_TX_ID).eq('company_id', COMPANY_ID)
      if (upd3.error) throw new Error(`TIC tx backfill failed: ${upd3.error.message}`)
      console.log('[done] TIC links backfilled (invoice, payment row, transaction)')
    }
  }

  // ---------- Step 3: RosholmDell payment voucher + full settle ----------
  if (rd.status === 'paid') {
    console.log('[skip] RD invoice already paid')
  } else {
    console.log('[plan] RD payment voucher: D 2440 29890 / K 1930 29890; settle invoice')
    if (EXECUTE) {
      const je = await createJournalEntry(supabase, COMPANY_ID, USER_ID, {
        fiscal_period_id: fiscalPeriodId,
        entry_date: PAYMENT_DATE,
        description: 'Utbetalning leverantörsfaktura 18299, RosholmDell Advokatbyrå AB',
        source_type: 'supplier_invoice_paid',
        source_id: RD_INVOICE_ID,
        lines: [
          { account_number: '2440', debit_amount: 29890, credit_amount: 0, line_description: 'Kvittning leverantörsskuld' },
          { account_number: '1930', debit_amount: 0, credit_amount: 29890, line_description: 'Utbetalning från bank' },
        ],
      })
      console.log(`[done] RD payment voucher ${je.voucher_series}-${je.voucher_number} (${je.id})`)

      const upd1 = await supabase.from('supplier_invoices')
        .update({
          status: 'paid',
          paid_amount: 29890,
          remaining_amount: 0,
          paid_at: new Date().toISOString(),
          payment_journal_entry_id: je.id,
          transaction_id: RD_TX_ID,
        })
        .eq('id', RD_INVOICE_ID).eq('company_id', COMPANY_ID).eq('status', 'registered')
        .select('id')
      if (upd1.error || !upd1.data?.length) {
        throw new Error(`RD invoice settle failed: ${upd1.error?.message ?? 'status changed concurrently'}`)
      }

      const ins = await supabase.from('supplier_invoice_payments').insert({
        user_id: USER_ID,
        company_id: COMPANY_ID,
        supplier_invoice_id: RD_INVOICE_ID,
        payment_date: PAYMENT_DATE,
        amount: 29890,
        currency: 'SEK',
        exchange_rate_difference: 0,
        journal_entry_id: je.id,
        transaction_id: RD_TX_ID,
      })
      if (ins.error) throw new Error(`RD payment row insert failed: ${ins.error.message}`)

      const upd2 = await supabase.from('transactions')
        .update({ journal_entry_id: je.id, is_business: true })
        .eq('id', RD_TX_ID).eq('company_id', COMPANY_ID)
      if (upd2.error) throw new Error(`RD tx backfill failed: ${upd2.error.message}`)
      console.log('[done] RD invoice settled + links backfilled')
    }
  }

  // ---------- Step 4: corrections A64 (5010→5420) and A65 (5010→6580) ----------
  const corrections = [
    {
      label: 'A64 (TIC): 5010 → 5420 Programvaror',
      entryId: TIC_REGISTRATION_JE,
      lines: [
        { account_number: '5420', debit_amount: 8985, credit_amount: 0, line_description: 'Leverantörsfaktura 20250928, The Intelligence Company AB (publ) (ankomst 1)' },
        { account_number: '2641', debit_amount: 2246.25, credit_amount: 0, line_description: 'Ingående moms 25% Leverantörsfaktura 20250928, The Intelligence Company AB (publ) (ankomst 1)' },
        { account_number: '2440', debit_amount: 0, credit_amount: 11231.25, line_description: 'Leverantörsfaktura 20250928, The Intelligence Company AB (publ) (ankomst 1)' },
      ],
    },
    {
      label: 'A65 (RosholmDell): 5010 → 6580 Advokat- och rättegångskostnader',
      entryId: RD_REGISTRATION_JE,
      lines: [
        { account_number: '6580', debit_amount: 23912, credit_amount: 0, line_description: 'Leverantörsfaktura 18299, RosholmDell Advokatbyrå AB (ankomst 2)' },
        { account_number: '2641', debit_amount: 5978, credit_amount: 0, line_description: 'Ingående moms 25% Leverantörsfaktura 18299, RosholmDell Advokatbyrå AB (ankomst 2)' },
        { account_number: '2440', debit_amount: 0, credit_amount: 29890, line_description: 'Leverantörsfaktura 18299, RosholmDell Advokatbyrå AB (ankomst 2)' },
      ],
    },
  ]

  for (const c of corrections) {
    const { data: orig } = await supabase
      .from('journal_entries')
      .select('status')
      .eq('id', c.entryId).eq('company_id', COMPANY_ID).single()
    if (!orig) throw new Error(`Original entry not found for ${c.label}`)
    if (orig.status !== 'posted') {
      console.log(`[skip] ${c.label}: original status is '${orig.status}' (already corrected?)`)
      continue
    }
    console.log(`[plan] correct ${c.label}`)
    if (EXECUTE) {
      const { reversal, corrected } = await correctEntry(
        supabase, COMPANY_ID, USER_ID, c.entryId, c.lines,
      )
      console.log(
        `[done] ${c.label}: storno ${reversal.voucher_series}-${reversal.voucher_number}, ` +
        `corrected ${corrected.voucher_series}-${corrected.voucher_number}`,
      )
    }
  }

  // ---------- Step 5: verify ----------
  if (EXECUTE) {
    const { data: ap } = await supabase
      .from('journal_entry_lines')
      .select('debit_amount, credit_amount, journal_entry:journal_entries!inner(company_id, status)')
      .eq('account_number', '2440')
      .eq('journal_entry.company_id', COMPANY_ID)
      .in('journal_entry.status', ['posted', 'reversed'])
    const apNet = (ap ?? []).reduce((s, l) => s + (l.credit_amount ?? 0) - (l.debit_amount ?? 0), 0)
    console.log(`\n2440 net balance over posted entries: ${Math.round(apNet * 100) / 100} (expect 0)`)
  }

  console.log('\nDone.')
}

main().catch((err) => {
  console.error('\nREPAIR FAILED:', err)
  process.exit(1)
})
