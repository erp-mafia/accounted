/**
 * pg-real test for get_ledger_deep_context.
 *
 * The deep, full-history analysis behind the "Vad din agent vet" page: merges
 * counterparties across name variants, mines booked verifikat for spend, and
 * detects recurrence. Verifies variant-merging, occurrence/spend rollup,
 * dominant-account + share, recurrence cadence, and supplier entities.
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { randomUUID } from 'node:crypto'
import { getPool } from './setup'
import { seedCompany, insertDraftJournalEntry } from './fixtures'

async function insertLines(
  journalEntryId: string,
  lines: Array<{ account: string; debit: number; credit: number }>,
): Promise<void> {
  for (const line of lines) {
    await getPool().query(
      `INSERT INTO public.journal_entry_lines
         (journal_entry_id, account_number, debit_amount, credit_amount)
       VALUES ($1, $2, $3, $4)`,
      [journalEntryId, line.account, line.debit, line.credit],
    )
  }
}

async function bookMerchant(params: {
  userId: string
  companyId: string
  fiscalPeriodId: string
  merchantName: string
  date: string
  expenseAccount: string
  amount: number
  voucherNumber: number
}): Promise<void> {
  const entryId = await insertDraftJournalEntry({
    userId: params.userId,
    companyId: params.companyId,
    fiscalPeriodId: params.fiscalPeriodId,
    entryDate: params.date,
    status: 'posted',
    voucherNumber: params.voucherNumber,
    sourceType: 'bank_transaction',
  })
  await insertLines(entryId, [
    { account: params.expenseAccount, debit: params.amount, credit: 0 },
    { account: '1930', debit: 0, credit: params.amount },
  ])
  await getPool().query(
    `INSERT INTO public.transactions
       (id, company_id, user_id, currency, amount, date, description, journal_entry_id, merchant_name, category)
     VALUES ($1,$2,$3,'SEK',$4,$5,$6,$7,$8,'expense_software')`,
    [randomUUID(), params.companyId, params.userId, -params.amount, params.date,
     `Payment ${params.merchantName}`, entryId, params.merchantName],
  )
}

type DeepEntity = {
  name: string
  key: string
  variants: string[]
  variant_count: number
  occurrences: number
  total_amount: number
  first_seen: string
  last_seen: string
  cadence_days: number | null
  dominant_account_number: string | null
  dominant_account_share: number | null
  dominant_vat?: string | null
}
type Deep = { counterparty_entities: DeepEntity[]; supplier_entities: DeepEntity[] }

async function callRpc(companyId: string, fromDate: string | null): Promise<Deep> {
  const res = await getPool().query(
    `SELECT public.get_ledger_deep_context($1, $2) AS d`,
    [companyId, fromDate],
  )
  return res.rows[0].d as Deep
}

describe('get_ledger_deep_context', () => {
  let userId: string
  let companyId: string
  let fiscalPeriodId: string

  beforeAll(async () => {
    const seeded = await seedCompany()
    userId = seeded.userId
    companyId = seeded.companyId
    fiscalPeriodId = seeded.fiscalPeriodId

    // Klarna under 3 name variants, monthly, all to 5420, 100 kr each.
    await bookMerchant({ userId, companyId, fiscalPeriodId, merchantName: 'KLARNA AB', date: '2026-04-01', expenseAccount: '5420', amount: 100, voucherNumber: 1 })
    await bookMerchant({ userId, companyId, fiscalPeriodId, merchantName: 'SWISH KLARNA AB', date: '2026-05-01', expenseAccount: '5420', amount: 100, voucherNumber: 2 })
    await bookMerchant({ userId, companyId, fiscalPeriodId, merchantName: 'KORTKÖP KLARNA AB 2026-06-01', date: '2026-06-01', expenseAccount: '5420', amount: 100, voucherNumber: 3 })

    // A one-off different merchant.
    await bookMerchant({ userId, companyId, fiscalPeriodId, merchantName: 'SL', date: '2026-05-10', expenseAccount: '5810', amount: 50, voucherNumber: 4 })

    // A supplier with 2 invoices.
    const supplierId = randomUUID()
    await getPool().query(`INSERT INTO public.suppliers (id, user_id, company_id, name) VALUES ($1,$2,$3,'Telia Sverige AB')`,
      [supplierId, userId, companyId])
    let arr = 1
    for (const [d, total] of [['2026-04-15', 500], ['2026-05-15', 500]] as const) {
      const invId = randomUUID()
      await getPool().query(
        `INSERT INTO public.supplier_invoices
           (id,user_id,company_id,supplier_id,arrival_number,supplier_invoice_number,invoice_date,due_date,status,vat_treatment,is_credit_note,subtotal,vat_amount,total,total_sek)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$7,'registered','standard_25',false,400,100,500,$8)`,
        [invId, userId, companyId, supplierId, arr++, `SI-${arr}`, d, total],
      )
      await getPool().query(
        `INSERT INTO public.supplier_invoice_items (supplier_invoice_id,description,quantity,unit_price,line_total,account_number,vat_rate,vat_amount)
         VALUES ($1,'Line',1,400,400,'6212',0.25,100)`,
        [invId],
      )
    }
  })

  it('merges counterparty name variants into one entity with spend + cadence', async () => {
    const deep = await callRpc(companyId, null)
    const klarna = deep.counterparty_entities.find((e) => e.key === 'klarna')
    expect(klarna).toBeDefined()
    expect(klarna!.occurrences).toBe(3)
    expect(klarna!.variant_count).toBe(3)
    expect(klarna!.variants.length).toBeGreaterThanOrEqual(3)
    expect(klarna!.dominant_account_number).toBe('5420')
    expect(klarna!.dominant_account_share).toBe(1)
    expect(klarna!.total_amount).toBe(300)
    expect(klarna!.first_seen).toBe('2026-04-01')
    expect(klarna!.last_seen).toBe('2026-06-01')
    // Monthly cadence: gaps of 30 and 31 days -> median ~30.
    expect(klarna!.cadence_days).toBeGreaterThanOrEqual(30)
    expect(klarna!.cadence_days).toBeLessThanOrEqual(31)
  })

  it('keeps a one-off merchant as a single-occurrence entity', async () => {
    const deep = await callRpc(companyId, null)
    const sl = deep.counterparty_entities.find((e) => e.key === 'sl')
    expect(sl!.occurrences).toBe(1)
    expect(sl!.variant_count).toBe(1)
    expect(sl!.cadence_days).toBeNull()
    expect(sl!.dominant_account_number).toBe('5810')
  })

  it('aggregates supplier entities with spend and dominant account', async () => {
    const deep = await callRpc(companyId, null)
    const telia = deep.supplier_entities.find((e) => e.name === 'Telia Sverige AB')
    expect(telia).toBeDefined()
    expect(telia!.occurrences).toBe(2)
    expect(telia!.total_amount).toBe(1000)
    expect(telia!.dominant_account_number).toBe('6212')
    expect(telia!.dominant_vat).toBe('standard_25')
    expect(telia!.cadence_days).toBeGreaterThanOrEqual(30)
  })

  it('respects the from_date bound', async () => {
    const deep = await callRpc(companyId, '2026-05-15')
    const klarna = deep.counterparty_entities.find((e) => e.key === 'klarna')
    // Only the 2026-06-01 Klarna booking is on/after the bound.
    expect(klarna!.occurrences).toBe(1)
  })

  it('isolates by company', async () => {
    const other = await seedCompany()
    const deep = await callRpc(other.companyId, null)
    expect(deep.counterparty_entities).toEqual([])
    expect(deep.supplier_entities).toEqual([])
  })
})
