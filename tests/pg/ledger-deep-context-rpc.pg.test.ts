/**
 * pg-real test for get_ledger_deep_context.
 *
 * The deep, full-history analysis behind the "Vad din agent vet" page: merges
 * counterparties across name variants, mines booked verifikat for spend, and
 * detects recurrence. Verifies variant-merging, occurrence/spend rollup,
 * dominant-account + share, recurrence cadence, and supplier entities.
 *
 * Also covers the SEK honesty contract from migration 20260726150000: a
 * foreign-currency row is summed and ranked at its SEK value when one can be
 * established, and is excluded from the total and counted in
 * `unconverted_fx_count` when it cannot. SEK rows must be unaffected.
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { randomUUID } from 'node:crypto'
import { getPool } from './setup'
import { seedCompany, insertPostedJournalEntry } from './fixtures'

async function bookMerchant(params: {
  userId: string
  companyId: string
  fiscalPeriodId: string
  merchantName: string
  date: string
  expenseAccount: string
  amount: number
  voucherNumber: number
  /** Transaction currency. Omitted = SEK, the shape every pre-FX case uses. */
  currency?: string
  /** transactions.amount_sek: the value converted at ingest. Null = none stored. */
  amountSek?: number | null
  /** transactions.exchange_rate: the rate recorded on the row. Null = none. */
  exchangeRate?: number | null
}): Promise<void> {
  const entryId = await insertPostedJournalEntry({
    userId: params.userId,
    companyId: params.companyId,
    fiscalPeriodId: params.fiscalPeriodId,
    entryDate: params.date,
    voucherNumber: params.voucherNumber,
    sourceType: 'bank_transaction',
    lines: [
      { accountNumber: params.expenseAccount, debitAmount: params.amount, creditAmount: 0 },
      { accountNumber: '1930', debitAmount: 0, creditAmount: params.amount },
    ],
  })
  await getPool().query(
    `INSERT INTO public.transactions
       (id, company_id, user_id, currency, amount, amount_sek, exchange_rate,
        date, description, journal_entry_id, merchant_name, category)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'expense_software')`,
    [randomUUID(), params.companyId, params.userId, params.currency ?? 'SEK',
     -params.amount, params.amountSek ?? null, params.exchangeRate ?? null, params.date,
     `Payment ${params.merchantName}`, entryId, params.merchantName],
  )
}

/**
 * A supplier with exactly one invoice, in whatever currency shape the test
 * needs. `totalSek`/`exchangeRate` null is the shape a foreign invoice gets
 * when the caller omitted the rate: that is the case the RPC must not count as
 * kronor.
 */
async function bookSupplierInvoice(params: {
  userId: string
  companyId: string
  supplierName: string
  date: string
  account: string
  total: number
  currency?: string
  totalSek?: number | null
  exchangeRate?: number | null
  arrivalNumber: number
}): Promise<void> {
  const supplierId = randomUUID()
  await getPool().query(
    `INSERT INTO public.suppliers (id, user_id, company_id, name) VALUES ($1,$2,$3,$4)`,
    [supplierId, params.userId, params.companyId, params.supplierName],
  )
  const invId = randomUUID()
  await getPool().query(
    `INSERT INTO public.supplier_invoices
       (id,user_id,company_id,supplier_id,arrival_number,supplier_invoice_number,
        invoice_date,due_date,status,vat_treatment,is_credit_note,
        currency,subtotal,vat_amount,total,total_sek,exchange_rate)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$7,'registered','standard_25',false,
             $8,$9,0,$9,$10,$11)`,
    [invId, params.userId, params.companyId, supplierId, params.arrivalNumber,
     `SI-${params.arrivalNumber}`, params.date, params.currency ?? 'SEK',
     params.total, params.totalSek ?? null, params.exchangeRate ?? null],
  )
  await getPool().query(
    `INSERT INTO public.supplier_invoice_items (supplier_invoice_id,description,quantity,unit_price,line_total,account_number,vat_rate,vat_amount)
     VALUES ($1,'Line',1,$2,$2,$3,0,0)`,
    [invId, params.total, params.account],
  )
}

type DeepEntity = {
  name: string
  key: string
  variants: string[]
  variant_count: number
  occurrences: number
  total_amount: number
  unconverted_fx_count: number
  first_seen: string
  last_seen: string
  cadence_days: number | null
  dominant_account_number: string | null
  dominant_account_share: number | null
  dominant_account_count: number | null
  dominant_account_total: number | null
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

    // --- FX cohort (migration 20260726150000) -------------------------------
    // Four single-booking counterparties chosen so that reading the raw amount
    // produces a DIFFERENT ranking than reading the SEK value, because
    // total_amount is the sort key:
    //   SEK value  EUROSTORE 1250, DOLLARDEPOT 1150, KRONKIOSK 800, YENYARD 0
    //   pre-fix    EUROSTORE 1250, KRONKIOSK 800, YENYARD 500, DOLLARDEPOT 100
    //
    // EUR converted at ingest: amount_sek is what the row states.
    await bookMerchant({
      userId, companyId, fiscalPeriodId, merchantName: 'EUROSTORE', date: '2026-06-10',
      expenseAccount: '5410', amount: 100, voucherNumber: 5,
      currency: 'EUR', amountSek: -1250,
    })
    // EUR with no amount_sek but the rate on the row: deterministic arithmetic.
    await bookMerchant({
      userId, companyId, fiscalPeriodId, merchantName: 'DOLLARDEPOT', date: '2026-06-11',
      expenseAccount: '5411', amount: 100, voucherNumber: 6,
      currency: 'USD', exchangeRate: 11.5,
    })
    // Plain SEK, sitting between the two FX values so the ranking is decisive.
    await bookMerchant({
      userId, companyId, fiscalPeriodId, merchantName: 'KRONKIOSK', date: '2026-06-12',
      expenseAccount: '5412', amount: 800, voucherNumber: 7,
    })
    // EUR with neither: no SEK value exists. Must be excluded and counted, and
    // must NOT enter the total as the number 500.
    await bookMerchant({
      userId, companyId, fiscalPeriodId, merchantName: 'YENYARD', date: '2026-06-13',
      expenseAccount: '5413', amount: 500, voucherNumber: 8,
      currency: 'EUR',
    })

    // AP side, the worse of the two: total_sek is NULL on every foreign invoice
    // registered without an exchange_rate, so this is live data, not legacy.
    await bookSupplierInvoice({
      userId, companyId, supplierName: 'Rated Foreign AB', date: '2026-06-10',
      account: '6230', total: 100, currency: 'EUR', exchangeRate: 11.5, arrivalNumber: 10,
    })
    await bookSupplierInvoice({
      userId, companyId, supplierName: 'Unrated Foreign AB', date: '2026-06-11',
      account: '6231', total: 500, currency: 'EUR', arrivalNumber: 11,
    })
  })

  it('merges counterparty name variants into one entity with spend + cadence', async () => {
    const deep = await callRpc(companyId, null)
    const klarna = deep.counterparty_entities.find((e) => e.key === 'klarna')
    expect(klarna).toBeDefined()
    expect(klarna!.occurrences).toBe(3)
    expect(klarna!.variant_count).toBe(3)
    expect(klarna!.variants.length).toBeGreaterThanOrEqual(3)
    expect(klarna!.dominant_account_number).toBe('5420')
    // Laplace-smoothed (3+1)/(3+2): consistent history, but n=3 is not certainty.
    expect(klarna!.dominant_account_share).toBe(0.8)
    expect(klarna!.dominant_account_count).toBe(3)
    expect(klarna!.dominant_account_total).toBe(3)
    expect(klarna!.total_amount).toBe(300)
    // SEK rows: amount_sek is NULL by design, the coalesce still resolves to
    // `amount`, and nothing is withheld.
    expect(klarna!.unconverted_fx_count).toBe(0)
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
    // The P3 bug this guards: a single booking must NOT read as 100%.
    // Laplace (1+1)/(1+2) = 0.67, with the raw 1-of-1 evidence exposed.
    expect(sl!.dominant_account_share).toBe(0.67)
    expect(sl!.dominant_account_count).toBe(1)
    expect(sl!.dominant_account_total).toBe(1)
  })

  it('aggregates supplier entities with spend and dominant account', async () => {
    const deep = await callRpc(companyId, null)
    const telia = deep.supplier_entities.find((e) => e.name === 'Telia Sverige AB')
    expect(telia).toBeDefined()
    expect(telia!.occurrences).toBe(2)
    expect(telia!.total_amount).toBe(1000)
    expect(telia!.unconverted_fx_count).toBe(0)
    expect(telia!.dominant_account_number).toBe('6212')
    // Laplace-smoothed (2+1)/(2+2).
    expect(telia!.dominant_account_share).toBe(0.75)
    expect(telia!.dominant_account_count).toBe(2)
    expect(telia!.dominant_account_total).toBe(2)
    expect(telia!.dominant_vat).toBe('standard_25')
    expect(telia!.cadence_days).toBeGreaterThanOrEqual(30)
  })

  it('converts a foreign booking at the SEK value stored on the row', async () => {
    const deep = await callRpc(companyId, null)
    const e = deep.counterparty_entities.find((x) => x.name === 'EUROSTORE')
    expect(e).toBeDefined()
    // 100 EUR, amount_sek = -1250. The magnitude is 1250 kr, not 100.
    expect(e!.total_amount).toBe(1250)
    expect(e!.unconverted_fx_count).toBe(0)
    expect(e!.occurrences).toBe(1)
  })

  it('converts a foreign booking through the exchange_rate on the row', async () => {
    const deep = await callRpc(companyId, null)
    const e = deep.counterparty_entities.find((x) => x.name === 'DOLLARDEPOT')
    expect(e).toBeDefined()
    // 100 USD at 11.5, no amount_sek stored: 1150 kr, not 100.
    expect(e!.total_amount).toBe(1150)
    expect(e!.unconverted_fx_count).toBe(0)
  })

  it('excludes a foreign booking with no establishable SEK value and counts it', async () => {
    const deep = await callRpc(companyId, null)
    const e = deep.counterparty_entities.find((x) => x.name === 'YENYARD')
    expect(e).toBeDefined()
    // 500 EUR with neither amount_sek nor exchange_rate. The old expression
    // returned the scalar 500 and called it kronor.
    expect(e!.total_amount).toBe(0)
    expect(e!.unconverted_fx_count).toBe(1)
    // Not silently dropped: the booking, its cadence basis and the account it
    // went to are currency-free facts and survive.
    expect(e!.occurrences).toBe(1)
    expect(e!.dominant_account_number).toBe('5413')
  })

  it('ranks single-booking counterparties by SEK magnitude, not raw amount', async () => {
    const deep = await callRpc(companyId, null)
    const order = deep.counterparty_entities
      .filter((e) => e.occurrences === 1)
      .map((e) => e.name)
    // SEK magnitudes 1250 > 1150 > 800 > 50 > 0. On the raw numbers the order
    // would have been 800 (KRONKIOSK), 500 (YENYARD), 100, 100, 50.
    expect(order).toEqual(['EUROSTORE', 'DOLLARDEPOT', 'KRONKIOSK', 'SL', 'YENYARD'])
  })

  it('applies the same rule to supplier invoices, where total_sek is usually NULL', async () => {
    const deep = await callRpc(companyId, null)
    const rated = deep.supplier_entities.find((e) => e.name === 'Rated Foreign AB')
    const unrated = deep.supplier_entities.find((e) => e.name === 'Unrated Foreign AB')

    // 100 EUR at 11.5 with total_sek NULL: converted, not read as 100 kr.
    expect(rated!.total_amount).toBe(1150)
    expect(rated!.unconverted_fx_count).toBe(0)

    // 500 EUR with no rate at all: withheld and counted, never 500 kr.
    expect(unrated!.total_amount).toBe(0)
    expect(unrated!.unconverted_fx_count).toBe(1)
    expect(unrated!.occurrences).toBe(1)
    expect(unrated!.dominant_account_number).toBe('6231')

    // The ranking flip: on the raw totals 500 outranked 100.
    const singles = deep.supplier_entities.filter((e) => e.occurrences === 1).map((e) => e.name)
    expect(singles).toEqual(['Rated Foreign AB', 'Unrated Foreign AB'])
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
