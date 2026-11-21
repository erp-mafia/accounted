/**
 * A förutbetald intäkt on a customer invoice (crm#1919) in the
 * momsdeklaration, against real Postgres and the real booking doors.
 *
 * A periodiserad invoice line credits 2970 instead of its revenue account on
 * the invoice date, with its whole moms on 2611 the same day; the schedule
 * then moves it to the revenue account month by month, Dr 2970 / Cr 3001,
 * with no moms. The beskattningsunderlag is the ersättning (ML 2023:200
 * 8 kap. 2 §) and ruta 05 is the underlag of the moms in rutor 10-12
 * (swedish-vat, section 7), so the declaration that carries the moms carries
 * the sale: the invoice's own period. Read as an account projection, the
 * declaration left the deferred sale out of the invoice's period and counted
 * it, without moms, in each release month.
 *
 * The judge here is the invoice's own arithmetic, outside the declaration:
 * every line is 25 %, so in every period ruta 10 is exactly a quarter of
 * ruta 05, and over the invoice's life ruta 05 adds up to the invoice's net.
 *
 * What is not real: the HTTP hop to PostgREST, replaced by
 * tests/pg/postgrest-over-pg.ts as in accrued-income-on-invoices.pg.test.ts.
 */
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { runWithActor } from '@/lib/bookkeeping/actor-context-node'
import { createCreditNoteJournalEntry, createInvoiceJournalEntry } from '@/lib/bookkeeping/invoice-entries'
import { createSchedulesForCustomerInvoice } from '@/lib/bookkeeping/accruals/from-invoices'
import { cancelSchedulesForSource } from '@/lib/bookkeeping/accruals/service'
import {
  ACCOUNT_RUTA,
  loadVatDeclarationLedger,
  VAT_ACCOUNTS,
  VAT_SETTLEMENT_NET_ACCOUNTS,
} from '@/lib/reports/vat-declaration'
import type { Invoice, InvoiceItem } from '@/types'
import { insertAuthUser, insertCompany, insertCompanyMember, insertFiscalPeriod } from './fixtures'
import { markReversed, nextSeq, postStorno, stornoEntry } from './kontantmetod-carry-fixtures'
import { getPool } from './setup'
import type { PgRest } from './postgrest-over-pg'

const shim = vi.hoisted(() => ({ rest: null as PgRest | null }))

/** supabase-js resolves a WebSocket constructor eagerly; nothing here subscribes. */
class UnusedRealtimeTransport {
  constructor() {
    throw new Error('pg-real: realtime is not used')
  }
}

vi.mock('@/lib/supabase/service-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/supabase/service-client')>()
  const { createPgRest } = await import('./postgrest-over-pg')
  shim.rest ??= createPgRest({ role: 'service_role' })
  return {
    ...actual,
    createServiceRoleClient: (_url: string, _key: string, options?: Parameters<typeof actual.createServiceRoleClient>[2]) =>
      actual.createServiceRoleClient('http://pg-real.invalid', 'pg-real-service-role', {
        ...options,
        global: { ...options?.global, fetch: shim.rest!.fetch },
        realtime: { transport: UnusedRealtimeTransport as never },
      }),
  }
})
vi.mock('@/lib/supabase/server', async (importOriginal) => {
  const serviceClient = await import('@/lib/supabase/service-client')
  return {
    ...(await importOriginal<typeof import('@/lib/supabase/server')>()),
    createServiceClient: () => serviceClient.createServiceRoleClient('', ''),
    createClient: async () => {
      throw new Error('pg-real: no request scope (cookie session) in this test')
    },
  }
})

afterEach(() => {
  vi.unstubAllEnvs()
  const unsupported = shim.rest?.unsupported.splice(0) ?? []
  expect(unsupported).toEqual([])
})

const Q1 = { start: '2026-01-01', end: '2026-03-31' }
const Q2 = { start: '2026-04-01', end: '2026-06-30' }
const Q3 = { start: '2026-07-01', end: '2026-09-30' }

/** The accounts the ruta 05 drill-down reads (its route inverts ACCOUNT_RUTA the same way). */
const RUTA_05_ACCOUNTS = Object.entries(ACCOUNT_RUTA)
  .filter(([, mapping]) => mapping.box === 'ruta05')
  .map(([account]) => account)

interface Seed {
  userId: string
  companyId: string
  customerId: string
  fiscalPeriodId: string
}

async function seedCompany(): Promise<Seed> {
  const userId = await insertAuthUser()
  const companyId = await insertCompany({ createdBy: userId, name: 'Test AB', entityType: 'aktiebolag' })
  await insertCompanyMember({ companyId, userId, role: 'owner' })
  await getPool().query(
    `INSERT INTO public.company_settings (user_id, company_id, entity_type, accounting_method, vat_registered, moms_period)
     VALUES ($1, $2, 'aktiebolag', 'accrual', true, 'quarterly')`,
    [userId, companyId],
  )
  const fiscalPeriodId = await insertFiscalPeriod({ userId, companyId, name: '2026', periodStart: '2026-01-01', periodEnd: '2026-12-31' })
  const customerId = randomUUID()
  await getPool().query(
    `INSERT INTO public.customers (id, user_id, company_id, name, customer_type) VALUES ($1, $2, $3, 'Kund AB', 'swedish_business')`,
    [customerId, userId, companyId],
  )
  return { userId, companyId, customerId, fiscalPeriodId }
}

async function readInvoice(invoiceId: string): Promise<Invoice & { items: InvoiceItem[] }> {
  const { data, error } = await createServiceClientNoCookies()
    .from('invoices')
    .select('*, items:invoice_items(*)')
    .eq('id', invoiceId)
    .single()
  if (error || !data) throw new Error(`invoice read failed: ${error?.message}`)
  return data as Invoice & { items: InvoiceItem[] }
}

/**
 * A sent invoice of 2026-03-15, all 25 %: a 12 000 kr support agreement for
 * March to August periodiserad on 2970, and 4 000 kr of setup that is not.
 * `sign` -1 makes it the kreditfaktura of `creditedInvoiceId`, dated
 * `invoiceDate`, its rows copied with the sign turned as buildCreditNoteItem
 * copies them (the periodisering fields ride along).
 */
async function insertInvoice(
  seed: Seed,
  options: { sign?: 1 | -1; invoiceDate?: string; creditedInvoiceId?: string } = {},
): Promise<Invoice & { items: InvoiceItem[] }> {
  const sign = options.sign ?? 1
  const invoiceId = randomUUID()
  const invoiceDate = options.invoiceDate ?? '2026-03-15'
  await getPool().query(
    `INSERT INTO public.invoices (id, user_id, company_id, customer_id, invoice_number, invoice_date, due_date, status, currency,
                                  subtotal, vat_amount, total, vat_treatment, vat_rate, document_type, credited_invoice_id,
                                  paid_amount, remaining_amount)
     VALUES ($1, $2, $3, $4, $5, $6, $6, 'sent', 'SEK',
             $7, $8, $9, 'standard_25', 25, 'invoice', $10, 0, $9)`,
    [
      invoiceId, seed.userId, seed.companyId, seed.customerId, `F-${invoiceId.slice(0, 8)}`, invoiceDate,
      sign * 16000, sign * 4000, sign * 20000, options.creditedInvoiceId ?? null,
    ],
  )
  await getPool().query(
    `INSERT INTO public.invoice_items (id, invoice_id, sort_order, description, quantity, unit, unit_price, line_total,
                                       vat_rate, vat_amount, accrual_period_start, accrual_period_end, accrual_balance_account)
     VALUES ($1, $2, 0, 'Supportavtal mars-augusti', $3, 'st', 12000, $4, 25, $5, '2026-03-01', '2026-08-31', '2970'),
            ($6, $2, 1, 'Uppsättning', $3, 'st', 4000, $7, 25, $8, NULL, NULL, NULL)`,
    [randomUUID(), invoiceId, sign, sign * 12000, sign * 3000, randomUUID(), sign * 4000, sign * 1000],
  )
  return readInvoice(invoiceId)
}

/** The invoice booked and periodiserad, as the issue and Bokför doors run it. */
async function bookDeferredInvoice(seed: Seed) {
  const invoice = await insertInvoice(seed)
  const supabase = createServiceClientNoCookies()
  const entryId = await runWithActor({ type: 'user' }, async () => {
    const entry = await createInvoiceJournalEntry(supabase, seed.companyId, seed.userId, invoice, 'aktiebolag', 'Kund AB')
    expect(entry).not.toBeNull()
    // Every month from March to August has begun, so the catch-up posts them all.
    const schedules = await createSchedulesForCustomerInvoice(
      supabase, seed.companyId, seed.userId, invoice, invoice.items, entry!.id, 'aktiebolag',
    )
    expect(schedules).toEqual({ created: 1, failed: 0, releasesFailed: 0 })
    return entry!.id
  })
  return { invoice, entryId }
}

/** The kreditfaktura of 2026-09-10 and the credit flow's cancel of the schedule. */
async function creditInvoice(seed: Seed, original: Invoice) {
  const creditNote = await insertInvoice(seed, { sign: -1, invoiceDate: '2026-09-10', creditedInvoiceId: original.id })
  const supabase = createServiceClientNoCookies()
  await runWithActor({ type: 'user' }, async () => {
    const entry = await createCreditNoteJournalEntry(supabase, seed.companyId, seed.userId, creditNote, 'aktiebolag', 'Kund AB')
    expect(entry).not.toBeNull()
    const cancelled = await cancelSchedulesForSource(
      supabase, seed.companyId, seed.userId, { invoiceId: original.id }, { reversalDate: creditNote.invoice_date },
    )
    expect(cancelled).toEqual({ cancelledSchedules: 1, reversedEntries: 6, failedReversals: 0 })
  })
}

async function rutorOf(companyId: string, period: { start: string; end: string }) {
  const { rutor } = await loadVatDeclarationLedger(createServiceClientNoCookies(), companyId, period.start, period.end)
  return { ruta05: rutor.ruta05, ruta10: rutor.ruta10 }
}

/** What the ruta 05 drill-down lists for the period, summed as the ruta reads it. */
async function drillDownRuta05(companyId: string, period: { start: string; end: string }): Promise<number> {
  const { rows } = await getPool().query<{ debit_amount: string; credit_amount: string }>(
    `SELECT * FROM public.get_vat_ruta_source_lines($1, $2, $3, $4, $5, $6, NULL, NULL, NULL, NULL, 501)`,
    [companyId, period.start, period.end, RUTA_05_ACCOUNTS, VAT_ACCOUNTS, VAT_SETTLEMENT_NET_ACCOUNTS],
  )
  const ore = rows.reduce((sum, row) => sum + Math.round(Number(row.credit_amount) * 100) - Math.round(Number(row.debit_amount) * 100), 0)
  return ore / 100
}

// The first booking loads the posting doors' module graph cold; the limit is
// there to end a hang, not to time a test.
describe('a periodiserad invoice line in the momsdeklaration (crm#1919)', { timeout: 60_000 }, () => {
  it('books the way the report assumes: 2970 on the invoice, the moms whole, a release a month with none', async () => {
    const seed = await seedCompany()
    const { entryId } = await bookDeferredInvoice(seed)

    const { rows: invoiceLines } = await getPool().query(
      `SELECT account_number, debit_amount::float8 AS debit, credit_amount::float8 AS credit
         FROM public.journal_entry_lines WHERE journal_entry_id = $1 ORDER BY account_number`,
      [entryId],
    )
    expect(invoiceLines).toEqual([
      { account_number: '1510', debit: 20000, credit: 0 },
      { account_number: '2611', debit: 0, credit: 4000 },
      { account_number: '2970', debit: 0, credit: 12000 },
      { account_number: '3001', debit: 0, credit: 4000 },
    ])

    const { rows: releases } = await getPool().query(
      `SELECT je.entry_date::text AS entry_date,
              string_agg(l.account_number || ':' || l.debit_amount::float8 || '/' || l.credit_amount::float8, ' ' ORDER BY l.account_number) AS lines
         FROM public.journal_entries je JOIN public.journal_entry_lines l ON l.journal_entry_id = je.id
        WHERE je.company_id = $1 AND je.source_type = 'accrual'
        GROUP BY je.id, je.entry_date ORDER BY je.entry_date`,
      [seed.companyId],
    )
    expect(releases).toEqual(
      ['2026-03-15', '2026-04-01', '2026-05-01', '2026-06-01', '2026-07-01', '2026-08-01'].map((entry_date) => ({
        entry_date,
        lines: '2970:2000/0 3001:0/2000',
      })),
    )
  })

  it('reports the whole sale with its moms in the invoice period, and nothing for the releases', async () => {
    const seed = await seedCompany()
    await bookDeferredInvoice(seed)

    // The invoice: 12 000 periodiserad + 4 000 not, 25 % moms on all of it.
    expect(await rutorOf(seed.companyId, Q1)).toEqual({ ruta05: 16000, ruta10: 4000 })
    // April to August hold only releases: no sale, no moms.
    expect(await rutorOf(seed.companyId, Q2)).toEqual({ ruta05: 0, ruta10: 0 })
    expect(await rutorOf(seed.companyId, Q3)).toEqual({ ruta05: 0, ruta10: 0 })

    // The drill-down lists what the figure sums.
    expect(await drillDownRuta05(seed.companyId, Q1)).toBe(16000)
    expect(await drillDownRuta05(seed.companyId, Q2)).toBe(0)
    expect(await drillDownRuta05(seed.companyId, Q3)).toBe(0)
  })

  it('takes the whole sale back in the kreditfaktura period, and leaves the stornoed releases out', async () => {
    const seed = await seedCompany()
    const { invoice } = await bookDeferredInvoice(seed)
    await creditInvoice(seed, invoice)

    expect(await rutorOf(seed.companyId, Q1)).toEqual({ ruta05: 16000, ruta10: 4000 })
    expect(await rutorOf(seed.companyId, Q2)).toEqual({ ruta05: 0, ruta10: 0 })
    // The kreditfaktura: the whole sale and its moms back, the six release stornos read as nothing.
    expect(await rutorOf(seed.companyId, Q3)).toEqual({ ruta05: -16000, ruta10: -4000 })
    expect(await drillDownRuta05(seed.companyId, Q3)).toBe(-16000)
  })

  it('leaves a corrected release out too: its storno, its rättelse and the storno of that', async () => {
    const seed = await seedCompany()
    await bookDeferredInvoice(seed)
    const company = { userId: seed.userId, companyId: seed.companyId, fiscalPeriodId: seed.fiscalPeriodId, nextPeriodId: seed.fiscalPeriodId }
    const { rows: [april] } = await getPool().query<{ id: string }>(
      `SELECT id FROM public.journal_entries WHERE company_id = $1 AND source_type = 'accrual' AND entry_date = '2026-04-01'`,
      [seed.companyId],
    )

    // correctEntry's writes: the storno, then the rättelse (source_type
    // correction, correction_of_id), then the original marked reversed.
    const stornoId = await postStorno(company, april.id, { date: '2026-05-10' })
    const correctionId = randomUUID()
    await getPool().query(
      `INSERT INTO public.journal_entries
         (id, user_id, company_id, fiscal_period_id, voucher_number, voucher_series,
          entry_date, description, source_type, correction_of_id, status)
       VALUES ($1, $2, $3, $4, $5, 'A', '2026-05-10', 'Rättelse: Periodisering 2026-04', 'correction', $6, 'draft')`,
      [correctionId, seed.userId, seed.companyId, seed.fiscalPeriodId, nextSeq() % 1_000_000_000, april.id],
    )
    await getPool().query(
      `INSERT INTO public.journal_entry_lines (journal_entry_id, account_number, debit_amount, credit_amount, currency, sort_order)
       VALUES ($1, '2970', 2000, 0, 'SEK', 0), ($1, '3001', 0, 2000, 'SEK', 1)`,
      [correctionId],
    )
    await getPool().query(`UPDATE public.journal_entries SET status = 'posted' WHERE id = $1`, [correctionId])
    await markReversed(april.id, stornoId)
    expect(await rutorOf(seed.companyId, Q2)).toEqual({ ruta05: 0, ruta10: 0 })
    expect(await drillDownRuta05(seed.companyId, Q2)).toBe(0)

    // The rättelse annulled in the next quarter: that quarter reads nothing either.
    await stornoEntry(company, correctionId, { date: '2026-07-10' })
    expect(await rutorOf(seed.companyId, Q1)).toEqual({ ruta05: 16000, ruta10: 4000 })
    expect(await rutorOf(seed.companyId, Q2)).toEqual({ ruta05: 0, ruta10: 0 })
    expect(await rutorOf(seed.companyId, Q3)).toEqual({ ruta05: 0, ruta10: 0 })
  })

  it('keeps ruta 10 a quarter of ruta 05 in every period, and the year whole', async () => {
    const seed = await seedCompany()
    await bookDeferredInvoice(seed)

    for (const period of [Q1, Q2, Q3]) {
      const { ruta05, ruta10 } = await rutorOf(seed.companyId, period)
      expect({ period: period.start, ruta10 }).toEqual({ period: period.start, ruta10: ruta05 * 0.25 })
    }
    expect(await rutorOf(seed.companyId, { start: '2026-01-01', end: '2026-12-31' })).toEqual({ ruta05: 16000, ruta10: 4000 })
  })

  it('reads the production case: the company\'s own 25 % accounts, one month periodiserad', async () => {
    // The shape of the verifikat behind crm#1919, anonymised and moved to May
    // so the release month has begun whenever this runs: 2 995 kr of setup on
    // 3040 and a 995 kr licence for June periodiserad on 2970 towards 3020,
    // both accounts the company's own with 25 % moms, 997,50 kr moms in all.
    const seed = await seedCompany()
    for (const [account, name] of [['3040', 'Engångsintäkter'], ['3020', 'Återkommande intäkter']]) {
      await getPool().query(
        `INSERT INTO public.chart_of_accounts (user_id, company_id, account_number, account_name, account_class, account_type,
                                               normal_balance, default_vat_rate, default_vat_treatment)
         VALUES ($1, $2, $3, $4, 3, 'revenue', 'credit', 0.25, 'standard_25')`,
        [seed.userId, seed.companyId, account, name],
      )
    }
    const invoiceId = randomUUID()
    await getPool().query(
      `INSERT INTO public.invoices (id, user_id, company_id, customer_id, invoice_number, invoice_date, due_date, status, currency,
                                    subtotal, vat_amount, total, vat_treatment, vat_rate, document_type, paid_amount, remaining_amount)
       VALUES ($1, $2, $3, $4, 'F-1', '2026-05-04', '2026-06-03', 'sent', 'SEK',
               3990, 997.50, 4987.50, 'standard_25', 25, 'invoice', 0, 4987.50)`,
      [invoiceId, seed.userId, seed.companyId, seed.customerId],
    )
    await getPool().query(
      `INSERT INTO public.invoice_items (id, invoice_id, sort_order, description, quantity, unit, unit_price, line_total,
                                         vat_rate, vat_amount, revenue_account, accrual_period_start, accrual_period_end,
                                         accrual_balance_account)
       VALUES ($1, $2, 0, 'Implementation', 1, 'st', 2995, 2995, 25, 748.75, '3040', NULL, NULL, NULL),
              ($3, $2, 1, 'Licens juni', 1, 'st', 995, 995, 25, 248.75, '3020', '2026-06-01', '2026-06-30', '2970')`,
      [randomUUID(), invoiceId, randomUUID()],
    )
    const invoice = await readInvoice(invoiceId)
    const supabase = createServiceClientNoCookies()
    await runWithActor({ type: 'user' }, async () => {
      const entry = await createInvoiceJournalEntry(supabase, seed.companyId, seed.userId, invoice, 'aktiebolag', 'Kund AB')
      await createSchedulesForCustomerInvoice(supabase, seed.companyId, seed.userId, invoice, invoice.items, entry!.id, 'aktiebolag')
    })

    const may = { start: '2026-05-01', end: '2026-05-31' }
    const june = { start: '2026-06-01', end: '2026-06-30' }
    expect(await rutorOf(seed.companyId, may)).toEqual({ ruta05: 3990, ruta10: 997.5 })
    expect(await rutorOf(seed.companyId, june)).toEqual({ ruta05: 0, ruta10: 0 })
    // The ruta 05 drill-down reads the company's ruta 05 accounts too.
    const { rows } = await getPool().query<{ debit_amount: string; credit_amount: string }>(
      `SELECT * FROM public.get_vat_ruta_source_lines($1, $2, $3, $4, $5, $6, NULL, NULL, NULL, NULL, 501)`,
      [seed.companyId, may.start, may.end, [...RUTA_05_ACCOUNTS, '3020', '3040'], VAT_ACCOUNTS, VAT_SETTLEMENT_NET_ACCOUNTS],
    )
    expect(rows.reduce((sum, row) => sum + Number(row.credit_amount) - Number(row.debit_amount), 0)).toBe(3990)
  })
})
