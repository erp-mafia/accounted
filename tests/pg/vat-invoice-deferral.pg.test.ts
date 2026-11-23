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
 * The mirror case is an upplupen intäkt (the last describe): a line for
 * months before the invoice month credits 1790 on the invoice with its whole
 * moms, and each of its months is booked Dr 1790 / Cr revenue on its last
 * day, with no moms. Read the same way: the sale in the invoice's period,
 * every month nothing.
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
import { cancelSchedulesForSource, dissolveScheduleNow } from '@/lib/bookkeeping/accruals/service'
import { createManualAccrualSchedule } from '@/lib/bookkeeping/accruals/manual'
import { createLogger } from '@/lib/logger'
import {
  ACCOUNT_RUTA,
  fetchInvoiceDeferralShares,
  loadVatDeclarationLedger,
  readDeferredSaleLines,
  rutorFromTotals,
  VAT_ACCOUNTS,
  VAT_SETTLEMENT_NET_ACCOUNTS,
} from '@/lib/reports/vat-declaration'
import { fetchDynamicVatAccounts } from '@/lib/reports/vat-revenue-accounts'
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

/**
 * What the ruta 05 drill-down lists for the period, summed as the ruta reads
 * it. `ownAccounts`: the company's own ruta 05 accounts, which its route adds.
 */
async function drillDownRuta05(companyId: string, period: { start: string; end: string }, ownAccounts: string[] = []): Promise<number> {
  const { rows } = await getPool().query<{ debit_amount: string; credit_amount: string }>(
    `SELECT * FROM public.get_vat_ruta_source_lines($1, $2, $3, $4, $5, $6, NULL, NULL, NULL, NULL, 501)`,
    [companyId, period.start, period.end, [...RUTA_05_ACCOUNTS, ...ownAccounts], VAT_ACCOUNTS, VAT_SETTLEMENT_NET_ACCOUNTS],
  )
  const ore = rows.reduce((sum, row) => sum + Math.round(Number(row.credit_amount) * 100) - Math.round(Number(row.debit_amount) * 100), 0)
  return ore / 100
}

/** The release verifikat the schedule posted on `date`. */
async function releaseOf(seed: Seed, date: string): Promise<string> {
  const { rows: [release] } = await getPool().query<{ id: string }>(
    `SELECT id FROM public.journal_entries WHERE company_id = $1 AND source_type = 'accrual' AND entry_date = $2`,
    [seed.companyId, date],
  )
  return release.id
}

/** correctEntry's rättelse after its storno: source_type correction, correction_of_id, the corrected lines. */
async function postCorrection(seed: Seed, originalId: string, date: string, lines: Array<[string, number, number]>): Promise<string> {
  const correctionId = randomUUID()
  await getPool().query(
    `INSERT INTO public.journal_entries
       (id, user_id, company_id, fiscal_period_id, voucher_number, voucher_series,
        entry_date, description, source_type, correction_of_id, status)
     VALUES ($1, $2, $3, $4, $5, 'A', $6, 'Rättelse', 'correction', $7, 'draft')`,
    [correctionId, seed.userId, seed.companyId, seed.fiscalPeriodId, nextSeq() % 1_000_000_000, date, originalId],
  )
  for (const [index, [account, debit, credit]] of lines.entries()) {
    await getPool().query(
      `INSERT INTO public.journal_entry_lines (journal_entry_id, account_number, debit_amount, credit_amount, currency, sort_order)
       VALUES ($1, $2, $3, $4, 'SEK', $5)`,
      [correctionId, account, debit, credit, index],
    )
  }
  await getPool().query(`UPDATE public.journal_entries SET status = 'posted' WHERE id = $1`, [correctionId])
  return correctionId
}

async function ensureAccount(
  seed: Seed,
  account: string,
  name: string,
  kind: { accountClass: number; accountType: string; normalBalance: string } = { accountClass: 2, accountType: 'liability', normalBalance: 'credit' },
): Promise<void> {
  await getPool().query(
    `INSERT INTO public.chart_of_accounts (user_id, company_id, account_number, account_name, account_class, account_type, normal_balance)
     SELECT $1, $2, $3, $4, $5, $6, $7
     WHERE NOT EXISTS (SELECT 1 FROM public.chart_of_accounts WHERE company_id = $2 AND account_number = $3)`,
    [seed.userId, seed.companyId, account, name, kind.accountClass, kind.accountType, kind.normalBalance],
  )
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

  it('takes the whole sale back in the kreditfaktura period, and reads the stornoed releases as nothing', async () => {
    const seed = await seedCompany()
    const { invoice } = await bookDeferredInvoice(seed)
    await creditInvoice(seed, invoice)

    expect(await rutorOf(seed.companyId, Q1)).toEqual({ ruta05: 16000, ruta10: 4000 })
    expect(await rutorOf(seed.companyId, Q2)).toEqual({ ruta05: 0, ruta10: 0 })
    // The kreditfaktura: the whole sale and its moms back, the six release stornos read as nothing.
    expect(await rutorOf(seed.companyId, Q3)).toEqual({ ruta05: -16000, ruta10: -4000 })
    expect(await drillDownRuta05(seed.companyId, Q3)).toBe(-16000)
  })

  it('reads a corrected release as nothing too: its storno, its rättelse and the storno of that', async () => {
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

  it('reads the same once the company\'s ledger days are built, as production companies are', async () => {
    const seed = await seedCompany()
    const { invoice } = await bookDeferredInvoice(seed)
    await getPool().query('SELECT public.build_ledger_account_days($1)', [seed.companyId])
    const { rows: [built] } = await getPool().query<{ ready: boolean }>('SELECT public.ledger_account_days_ready($1) AS ready', [seed.companyId])
    expect(built.ready).toBe(true)

    expect(await rutorOf(seed.companyId, Q1)).toEqual({ ruta05: 16000, ruta10: 4000 })
    expect(await rutorOf(seed.companyId, Q2)).toEqual({ ruta05: 0, ruta10: 0 })
    expect(await drillDownRuta05(seed.companyId, Q1)).toBe(16000)
    expect(await drillDownRuta05(seed.companyId, Q2)).toBe(0)

    await creditInvoice(seed, invoice)
    expect(await rutorOf(seed.companyId, Q3)).toEqual({ ruta05: -16000, ruta10: -4000 })
    expect(await drillDownRuta05(seed.companyId, Q3)).toBe(-16000)
  })

  it('keeps the new sale of a rättelse of a release, and its moms, while the release itself still reads as nothing', async () => {
    const seed = await seedCompany()
    await bookDeferredInvoice(seed)
    const company = { userId: seed.userId, companyId: seed.companyId, fiscalPeriodId: seed.fiscalPeriodId, nextPeriodId: seed.fiscalPeriodId }
    const april = await releaseOf(seed, '2026-04-01')

    // The April release stornoed and booked again by a rättelse that releases
    // 1 500 kr instead of 2 000 and also books a sale of 1 000 kr + 25 % moms
    // the release verifikat never had. Read through the release's chain, the
    // storno and the new release each net to nothing; read off the accounts
    // alone, the quarter would hold the 500 kr the release changed by.
    const stornoId = await postStorno(company, april, { date: '2026-05-10' })
    await postCorrection(seed, april, '2026-05-10', [
      ['2970', 1500, 0], ['3001', 0, 1500],
      ['1510', 1250, 0], ['3001', 0, 1000], ['2611', 0, 250],
    ])
    await markReversed(april, stornoId)

    expect(await rutorOf(seed.companyId, Q2)).toEqual({ ruta05: 1000, ruta10: 250 })
    expect(await drillDownRuta05(seed.companyId, Q2)).toBe(1000)
    expect(await rutorOf(seed.companyId, Q1)).toEqual({ ruta05: 16000, ruta10: 4000 })
  })

  it('keeps the new sale an inline rättelse adds to a release verifikat, and its moms', async () => {
    const seed = await seedCompany()
    await bookDeferredInvoice(seed)
    const april = await releaseOf(seed, '2026-04-01')

    // The other rättelse path: the release verifikat itself gains a sale of
    // 1 000 kr + 25 % moms, its release lines untouched.
    await getPool().query('SELECT public.correct_entry_lines_inline($1, $2, $3, $4, $5)', [
      seed.companyId, april, [], JSON.stringify([
        { account_number: '1510', debit_amount: 1250 },
        { account_number: '3001', credit_amount: 1000 },
        { account_number: '2611', credit_amount: 250 },
      ]), seed.userId,
    ])

    expect(await rutorOf(seed.companyId, Q2)).toEqual({ ruta05: 1000, ruta10: 250 })
    expect(await drillDownRuta05(seed.companyId, Q2)).toBe(1000)
    expect(await rutorOf(seed.companyId, Q1)).toEqual({ ruta05: 16000, ruta10: 4000 })
  })

  it('reads a "Lös upp nu" verifikat that releases several months at once as nothing, once', async () => {
    // 6 000 kr + 25 % moms periodiserad over six months far ahead, so no
    // month has begun whenever this runs, then the rest released in one
    // verifikat that every month links to (commit_accrual_dissolution).
    const seed = await seedCompany()
    const invoiceId = randomUUID()
    await getPool().query(
      `INSERT INTO public.invoices (id, user_id, company_id, customer_id, invoice_number, invoice_date, due_date, status, currency,
                                    subtotal, vat_amount, total, vat_treatment, vat_rate, document_type, paid_amount, remaining_amount)
       VALUES ($1, $2, $3, $4, 'F-3', '2026-11-15', '2026-12-15', 'sent', 'SEK',
               6000, 1500, 7500, 'standard_25', 25, 'invoice', 0, 7500)`,
      [invoiceId, seed.userId, seed.companyId, seed.customerId],
    )
    await getPool().query(
      `INSERT INTO public.invoice_items (id, invoice_id, sort_order, description, quantity, unit, unit_price, line_total,
                                         vat_rate, vat_amount, accrual_period_start, accrual_period_end, accrual_balance_account)
       VALUES ($1, $2, 0, 'Förskott på abonnemang', 1, 'st', 6000, 6000, 25, 1500, '2031-01-01', '2031-06-30', '2970')`,
      [randomUUID(), invoiceId],
    )
    const invoice = await readInvoice(invoiceId)
    const supabase = createServiceClientNoCookies()
    const dissolution = await runWithActor({ type: 'user' }, async () => {
      const entry = await createInvoiceJournalEntry(supabase, seed.companyId, seed.userId, invoice, 'aktiebolag', 'Kund AB')
      await createSchedulesForCustomerInvoice(supabase, seed.companyId, seed.userId, invoice, invoice.items, entry!.id, 'aktiebolag')
      const { rows: [schedule] } = await getPool().query<{ id: string }>(
        'SELECT id FROM public.accrual_schedules WHERE invoice_id = $1', [invoiceId],
      )
      return dissolveScheduleNow(supabase, seed.companyId, seed.userId, schedule.id, { today: '2026-12-10' })
    })
    const { rows: [linked] } = await getPool().query<{ months: number }>(
      'SELECT count(*)::int AS months FROM public.accrual_schedule_installments WHERE journal_entry_id = $1',
      [dissolution.journalEntryId],
    )
    expect(linked.months).toBe(6)

    const Q4 = { start: '2026-10-01', end: '2026-12-31' }
    expect(await rutorOf(seed.companyId, Q4)).toEqual({ ruta05: 6000, ruta10: 1500 })
    expect(await drillDownRuta05(seed.companyId, Q4)).toBe(6000)
  })

  it('reads the deferral of a rättelse of the invoice on the 29xx account the rättelse moved it to', async () => {
    const seed = await seedCompany()
    const { entryId } = await bookDeferredInvoice(seed)
    await ensureAccount(seed, '2971', 'Förutbetalda hyresintäkter')
    const company = { userId: seed.userId, companyId: seed.companyId, fiscalPeriodId: seed.fiscalPeriodId, nextPeriodId: seed.fiscalPeriodId }

    // The invoice verifikat stornoed and booked again with the deferral on
    // 2971 instead of 2970, and 10 000 kr of it instead of 12 000 (its moms
    // 2 500): a lawful rättelse, the schedule unchanged. The storno takes the
    // whole sale back and the rättelse books the new one, on 2971.
    const stornoId = await postStorno(company, entryId, { date: '2026-03-20' })
    await postCorrection(seed, entryId, '2026-03-20', [
      ['1510', 17500, 0], ['2971', 0, 10000], ['3001', 0, 4000], ['2611', 0, 3500],
    ])
    await markReversed(entryId, stornoId)

    expect(await rutorOf(seed.companyId, Q1)).toEqual({ ruta05: 14000, ruta10: 3500 })
    expect(await drillDownRuta05(seed.companyId, Q1)).toBe(14000)
    expect(await rutorOf(seed.companyId, Q2)).toEqual({ ruta05: 0, ruta10: 0 })
  })

  it('reads the deferral an inline rättelse moved to another 29xx account on the invoice verifikat itself', async () => {
    const seed = await seedCompany()
    const { entryId } = await bookDeferredInvoice(seed)
    await ensureAccount(seed, '2971', 'Förutbetalda hyresintäkter')
    const { rows: [deferralLine] } = await getPool().query<{ id: string }>(
      `SELECT id FROM public.journal_entry_lines WHERE journal_entry_id = $1 AND account_number = '2970'`,
      [entryId],
    )
    await getPool().query('SELECT public.correct_entry_lines_inline($1, $2, $3, $4, $5)', [
      seed.companyId, entryId, [deferralLine.id], JSON.stringify([{ account_number: '2971', credit_amount: 12000 }]), seed.userId,
    ])

    expect(await rutorOf(seed.companyId, Q1)).toEqual({ ruta05: 16000, ruta10: 4000 })
    expect(await drillDownRuta05(seed.companyId, Q1)).toBe(16000)
  })

  it('reads the deferral an inline rättelse lowered at what the verifikat holds now, its part taken of what it booked', async () => {
    // The sale corrected inside the invoice verifikat: 10 000 kr periodiserad
    // instead of 12 000, its moms 2 500 instead of 3 000. The part stays the
    // schedule's 12 000 over the 12 000 the verifikat booked (the rättelse
    // log gives the booked amount back), so the lowered line reads whole.
    const seed = await seedCompany()
    const { entryId } = await bookDeferredInvoice(seed)
    const { rows: struck } = await getPool().query<{ id: string }>(
      `SELECT id FROM public.journal_entry_lines WHERE journal_entry_id = $1 AND account_number IN ('1510', '2970', '2611')`,
      [entryId],
    )
    await getPool().query('SELECT public.correct_entry_lines_inline($1, $2, $3, $4, $5)', [
      seed.companyId, entryId, struck.map((line) => line.id), JSON.stringify([
        { account_number: '1510', debit_amount: 17500 },
        { account_number: '2970', credit_amount: 10000 },
        { account_number: '2611', credit_amount: 3500 },
      ]), seed.userId,
    ])

    expect(await rutorOf(seed.companyId, Q1)).toEqual({ ruta05: 14000, ruta10: 3500 })
    expect(await drillDownRuta05(seed.companyId, Q1)).toBe(14000)
    expect(await rutorOf(seed.companyId, Q2)).toEqual({ ruta05: 0, ruta10: 0 })
  })

  it('counts a sale once when a rättelse moves it onto 2970 and a manual periodisering spreads it from the invoice verifikat', async () => {
    // The 4 000 kr of setup moved by a rättelse from 3001 onto 2970, then
    // periodiserad by hand over April to July from the invoice verifikat. The
    // invoice's period reads all of 2970 as the sale, so the manual months
    // net to nothing like the invoice's own; read the old way, they would
    // count the 4 000 kr a second time.
    const seed = await seedCompany()
    const { entryId } = await bookDeferredInvoice(seed)
    const { rows: [setup] } = await getPool().query<{ id: string }>(
      `SELECT id FROM public.journal_entry_lines WHERE journal_entry_id = $1 AND account_number = '3001'`,
      [entryId],
    )
    await getPool().query('SELECT public.correct_entry_lines_inline($1, $2, $3, $4, $5)', [
      seed.companyId, entryId, [setup.id], JSON.stringify([{ account_number: '2970', credit_amount: 4000 }]), seed.userId,
    ])
    const outcome = await runWithActor({ type: 'user' }, () =>
      createManualAccrualSchedule(
        { supabase: createServiceClientNoCookies(), companyId: seed.companyId, userId: seed.userId, log: createLogger('pg-test') },
        {
          direction: 'revenue',
          amount_sek: 4000,
          balance_account: '2970',
          target_account: '3001',
          period_start: '2026-04-01',
          period_end: '2026-07-31',
          description: 'Uppsättning',
          origin_journal_entry_id: entryId,
        },
        { dryRun: false },
      ),
    )
    expect(outcome.ok).toBe(true)
    const { rows: [manual] } = await getPool().query<{ months: number }>(
      `SELECT count(*)::int AS months FROM public.accrual_schedule_installments i
         JOIN public.accrual_schedules s ON s.id = i.schedule_id
        WHERE s.company_id = $1 AND s.source_kind = 'manual' AND i.journal_entry_id IS NOT NULL`,
      [seed.companyId],
    )
    expect(manual.months).toBe(4)

    expect(await rutorOf(seed.companyId, Q1)).toEqual({ ruta05: 16000, ruta10: 4000 })
    expect(await rutorOf(seed.companyId, Q2)).toEqual({ ruta05: 0, ruta10: 0 })
    expect(await rutorOf(seed.companyId, Q3)).toEqual({ ruta05: 0, ruta10: 0 })
    expect(await drillDownRuta05(seed.companyId, Q2)).toBe(0)
  })

  it('reads only the part with moms when a row of the deferral could not be scheduled', async () => {
    // 1 000 kr at 25 % and 2 000 kr momsfri, both periodiserad on 2970 for
    // April to June; the schedule door goes on past a row it cannot
    // schedule, and here the momsfri row's schedule is missing.
    const seed = await seedCompany()
    const invoiceId = randomUUID()
    await getPool().query(
      `INSERT INTO public.invoices (id, user_id, company_id, customer_id, invoice_number, invoice_date, due_date, status, currency,
                                    subtotal, vat_amount, total, vat_treatment, vat_rate, document_type, paid_amount, remaining_amount)
       VALUES ($1, $2, $3, $4, 'F-2', '2026-03-15', '2026-04-14', 'sent', 'SEK',
               3000, 250, 3250, 'standard_25', 25, 'invoice', 0, 3250)`,
      [invoiceId, seed.userId, seed.companyId, seed.customerId],
    )
    await getPool().query(
      `INSERT INTO public.invoice_items (id, invoice_id, sort_order, description, quantity, unit, unit_price, line_total,
                                         vat_rate, vat_amount, accrual_period_start, accrual_period_end, accrual_balance_account)
       VALUES ($1, $2, 0, 'Abonnemang', 1, 'st', 1000, 1000, 25, 250, '2026-04-01', '2026-06-30', '2970'),
              ($3, $2, 1, 'Momsfri avgift', 1, 'st', 2000, 2000, 0, 0, '2026-04-01', '2026-06-30', '2970')`,
      [randomUUID(), invoiceId, randomUUID()],
    )
    const invoice = await readInvoice(invoiceId)
    const supabase = createServiceClientNoCookies()
    const entryId = await runWithActor({ type: 'user' }, async () => {
      const entry = await createInvoiceJournalEntry(supabase, seed.companyId, seed.userId, invoice, 'aktiebolag', 'Kund AB')
      const withMoms = invoice.items.filter((item) => Number(item.vat_rate) > 0)
      await createSchedulesForCustomerInvoice(supabase, seed.companyId, seed.userId, invoice, withMoms, entry!.id, 'aktiebolag')
      return entry!.id
    })
    const { rows: deferred } = await getPool().query<{ credit: number }>(
      `SELECT sum(credit_amount)::float8 AS credit FROM public.journal_entry_lines WHERE journal_entry_id = $1 AND account_number = '2970'`,
      [entryId],
    )
    expect(deferred[0].credit).toBe(3000)

    expect(await rutorOf(seed.companyId, Q1)).toEqual({ ruta05: 1000, ruta10: 250 })
    expect(await drillDownRuta05(seed.companyId, Q1)).toBe(1000)
    expect(await rutorOf(seed.companyId, Q2)).toEqual({ ruta05: 0, ruta10: 0 })
  })

  it('reads no row as a sale with moms that no schedule says carries it, also when the row has moms', async () => {
    // Two 25 % rows on 2970, and the 2 000 kr row's schedule missing: only
    // the 1 000 kr a schedule names is read. The missing row is not read in
    // any period, as on main, until a schedule for it exists.
    const seed = await seedCompany()
    const invoiceId = randomUUID()
    await getPool().query(
      `INSERT INTO public.invoices (id, user_id, company_id, customer_id, invoice_number, invoice_date, due_date, status, currency,
                                    subtotal, vat_amount, total, vat_treatment, vat_rate, document_type, paid_amount, remaining_amount)
       VALUES ($1, $2, $3, $4, 'F-4', '2026-03-15', '2026-04-14', 'sent', 'SEK',
               3000, 750, 3750, 'standard_25', 25, 'invoice', 0, 3750)`,
      [invoiceId, seed.userId, seed.companyId, seed.customerId],
    )
    const [scheduled, missing] = [randomUUID(), randomUUID()]
    await getPool().query(
      `INSERT INTO public.invoice_items (id, invoice_id, sort_order, description, quantity, unit, unit_price, line_total,
                                         vat_rate, vat_amount, accrual_period_start, accrual_period_end, accrual_balance_account)
       VALUES ($1, $2, 0, 'Abonnemang', 1, 'st', 1000, 1000, 25, 250, '2026-04-01', '2026-06-30', '2970'),
              ($3, $2, 1, 'Support', 1, 'st', 2000, 2000, 25, 500, '2026-04-01', '2026-06-30', '2970')`,
      [scheduled, invoiceId, missing],
    )
    const invoice = await readInvoice(invoiceId)
    const supabase = createServiceClientNoCookies()
    await runWithActor({ type: 'user' }, async () => {
      const entry = await createInvoiceJournalEntry(supabase, seed.companyId, seed.userId, invoice, 'aktiebolag', 'Kund AB')
      const first = invoice.items.filter((item) => item.id === scheduled)
      await createSchedulesForCustomerInvoice(supabase, seed.companyId, seed.userId, invoice, first, entry!.id, 'aktiebolag')
    })

    expect(await rutorOf(seed.companyId, Q1)).toEqual({ ruta05: 1000, ruta10: 750 })
    expect(await rutorOf(seed.companyId, Q2)).toEqual({ ruta05: 0, ruta10: 0 })
  })

  it('reads a verifikat in TS (the changes to a filed period) to the öre as the figure reads it, at a part that is no round number', async () => {
    // 1 500,15 kr at 25 % and 300,03 kr momsfri, both periodiserade on 2970
    // for April to June: the 25 % part is 5/6, and 1 500,15 x 5/6 is
    // 1 250,125 exactly. Both readers round each line at the same 12-decimal
    // part, so the fold over the verifikat's lines gives the figure's ruta 05.
    const seed = await seedCompany()
    const invoiceId = randomUUID()
    await getPool().query(
      `INSERT INTO public.invoices (id, user_id, company_id, customer_id, invoice_number, invoice_date, due_date, status, currency,
                                    subtotal, vat_amount, total, vat_treatment, vat_rate, document_type, paid_amount, remaining_amount)
       VALUES ($1, $2, $3, $4, 'F-5', '2026-03-15', '2026-04-14', 'sent', 'SEK',
               1800.18, 375.04, 2175.22, 'standard_25', 25, 'invoice', 0, 2175.22)`,
      [invoiceId, seed.userId, seed.companyId, seed.customerId],
    )
    await getPool().query(
      `INSERT INTO public.invoice_items (id, invoice_id, sort_order, description, quantity, unit, unit_price, line_total,
                                         vat_rate, vat_amount, accrual_period_start, accrual_period_end, accrual_balance_account)
       VALUES ($1, $2, 0, 'Abonnemang', 1, 'st', 1500.15, 1500.15, 25, 375.04, '2026-04-01', '2026-06-30', '2970'),
              ($3, $2, 1, 'Momsfri avgift', 1, 'st', 300.03, 300.03, 0, 0, '2026-04-01', '2026-06-30', '2970')`,
      [randomUUID(), invoiceId, randomUUID()],
    )
    const invoice = await readInvoice(invoiceId)
    const supabase = createServiceClientNoCookies()
    const entryId = await runWithActor({ type: 'user' }, async () => {
      const entry = await createInvoiceJournalEntry(supabase, seed.companyId, seed.userId, invoice, 'aktiebolag', 'Kund AB')
      await createSchedulesForCustomerInvoice(supabase, seed.companyId, seed.userId, invoice, invoice.items, entry!.id, 'aktiebolag')
      return entry!.id
    })

    const { rows: shareRows } = await getPool().query<{ journal_entry_id: string; target_account: string; share: string }>(
      'SELECT * FROM public.vat_invoice_deferral_shares($1)',
      [seed.companyId],
    )
    const shares = new Map<string, Array<{ target_account: string; share: number }>>()
    for (const row of shareRows) {
      shares.set(row.journal_entry_id, [...(shares.get(row.journal_entry_id) ?? []), { target_account: row.target_account, share: Number(row.share) }])
    }
    const { rows: lines } = await getPool().query<{ account_number: string; debit: number; credit: number }>(
      `SELECT account_number, debit_amount::float8 AS debit, credit_amount::float8 AS credit
         FROM public.journal_entry_lines WHERE journal_entry_id = $1`,
      [entryId],
    )
    const totals = new Map<string, { debit: number; credit: number }>()
    for (const line of readDeferredSaleLines(
      entryId,
      lines.map((l) => ({ account_number: l.account_number, debit_amount: l.debit, credit_amount: l.credit })),
      shares,
    )) {
      const t = totals.get(line.account_number) ?? { debit: 0, credit: 0 }
      totals.set(line.account_number, { debit: t.debit + line.debit_amount, credit: t.credit + line.credit_amount })
    }

    const { ruta05 } = await rutorOf(seed.companyId, Q1)
    expect(ruta05).toBe(1500.14)
    expect(rutorFromTotals(totals).ruta05).toBe(ruta05)
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

// ---------------------------------------------------------------------------
// The mirror case: an upplupen intäkt on 17xx.
// ---------------------------------------------------------------------------

/** A calendar month as a period. */
function month(yearMonth: string): { start: string; end: string } {
  const [year, monthNumber] = yearMonth.split('-').map(Number)
  const lastDay = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate()
  return { start: `${yearMonth}-01`, end: `${yearMonth}-${String(lastDay).padStart(2, '0')}` }
}

interface InvoiceRow {
  description: string
  amount: number
  vatRate: 0 | 25
  revenueAccount?: string
  /** The row's periodisering: its months and its interim account. */
  periodisering?: { start: string; end: string; account: string }
}

/**
 * A sent invoice of `rows`, dated `invoiceDate`, as the issue doors fetch it.
 * `sign` -1 makes it the kreditfaktura of `creditedInvoiceId`, its rows turned
 * as buildCreditNoteItem turns them (the periodisering fields ride along).
 */
async function insertInvoiceRows(
  seed: Seed,
  invoiceDate: string,
  rows: InvoiceRow[],
  options: { sign?: 1 | -1; creditedInvoiceId?: string } = {},
): Promise<Invoice & { items: InvoiceItem[] }> {
  const sign = options.sign ?? 1
  const net = rows.reduce((sum, row) => sum + row.amount, 0)
  const vat = rows.reduce((sum, row) => sum + (row.amount * row.vatRate) / 100, 0)
  const invoiceId = randomUUID()
  await getPool().query(
    `INSERT INTO public.invoices (id, user_id, company_id, customer_id, invoice_number, invoice_date, due_date, status, currency,
                                  subtotal, vat_amount, total, vat_treatment, vat_rate, document_type, credited_invoice_id,
                                  paid_amount, remaining_amount)
     VALUES ($1, $2, $3, $4, $5, $6, $6, 'sent', 'SEK',
             $7, $8, $9, 'standard_25', 25, 'invoice', $10, 0, $9)`,
    [
      invoiceId, seed.userId, seed.companyId, seed.customerId, `F-${invoiceId.slice(0, 8)}`, invoiceDate,
      sign * net, sign * vat, sign * (net + vat), options.creditedInvoiceId ?? null,
    ],
  )
  for (const [index, row] of rows.entries()) {
    await getPool().query(
      `INSERT INTO public.invoice_items (id, invoice_id, sort_order, description, quantity, unit, unit_price, line_total,
                                         vat_rate, vat_amount, revenue_account, accrual_period_start, accrual_period_end,
                                         accrual_balance_account)
       VALUES ($1, $2, $3, $4, $5, 'st', $6, $7, $8, $9, $10, $11, $12, $13)`,
      [
        randomUUID(), invoiceId, index, row.description, sign, row.amount, sign * row.amount, row.vatRate,
        (sign * row.amount * row.vatRate) / 100, row.revenueAccount ?? null,
        row.periodisering?.start ?? null, row.periodisering?.end ?? null, row.periodisering?.account ?? null,
      ],
    )
  }
  return readInvoice(invoiceId)
}

/** The invoice booked and its periodiseringar scheduled, as the issue and Bokför doors run them. */
async function bookInvoiceRows(seed: Seed, invoice: Invoice & { items: InvoiceItem[] }): Promise<string> {
  const supabase = createServiceClientNoCookies()
  return runWithActor({ type: 'user' }, async () => {
    const entry = await createInvoiceJournalEntry(supabase, seed.companyId, seed.userId, invoice, 'aktiebolag', 'Kund AB')
    expect(entry).not.toBeNull()
    const scheduled = await createSchedulesForCustomerInvoice(
      supabase, seed.companyId, seed.userId, invoice, invoice.items, entry!.id, 'aktiebolag',
    )
    expect({ failed: scheduled.failed, releasesFailed: scheduled.releasesFailed }).toEqual({ failed: 0, releasesFailed: 0 })
    return entry!.id
  })
}

/** The company's own revenue account with a 25 % moms-sats: it joins ruta 05 by that (#1261). */
async function insertOwnRevenueAccount(seed: Seed, account: string, name: string): Promise<void> {
  await getPool().query(
    `INSERT INTO public.chart_of_accounts (user_id, company_id, account_number, account_name, account_class, account_type,
                                           normal_balance, default_vat_rate, default_vat_treatment)
     VALUES ($1, $2, $3, $4, 3, 'revenue', 'credit', 0.25, 'standard_25')`,
    [seed.userId, seed.companyId, account, name],
  )
}

/** Each verifikat's lines, per account, as posted. */
async function entryLines(companyId: string): Promise<Array<{ id: string; entry_date: string; source_type: string; lines: string }>> {
  const { rows } = await getPool().query<{ id: string; entry_date: string; source_type: string; lines: string }>(
    `SELECT je.id, je.entry_date::text AS entry_date, je.source_type,
            string_agg(l.account_number || ':' || l.debit_amount::float8 || '/' || l.credit_amount::float8, ' ' ORDER BY l.account_number, l.debit_amount) AS lines
       FROM public.journal_entries je JOIN public.journal_entry_lines l ON l.journal_entry_id = je.id
      WHERE je.company_id = $1 AND je.status IN ('posted', 'reversed')
      GROUP BY je.id, je.entry_date, je.source_type, je.voucher_number
      ORDER BY je.entry_date, je.voucher_number`,
    [companyId],
  )
  return rows
}

/**
 * Each verifikat's ruta 05 as the changes to a filed period fold it: its own
 * lines read through the shares the TS reader fetches (readDeferredSaleLines),
 * with the company's own ruta 05 accounts.
 */
async function foldedRuta05ByEntry(companyId: string): Promise<Array<{ entry_date: string; source_type: string; ruta05: number }>> {
  const supabase = createServiceClientNoCookies()
  const shares = await fetchInvoiceDeferralShares(supabase, companyId)
  const dynamicVatAccounts = await fetchDynamicVatAccounts(supabase, companyId)
  const { rows } = await getPool().query<{
    id: string
    entry_date: string
    source_type: string
    account_number: string
    debit: number
    credit: number
  }>(
    `SELECT je.id, je.entry_date::text AS entry_date, je.source_type, l.account_number,
            l.debit_amount::float8 AS debit, l.credit_amount::float8 AS credit
       FROM public.journal_entries je JOIN public.journal_entry_lines l ON l.journal_entry_id = je.id
      WHERE je.company_id = $1 AND je.status IN ('posted', 'reversed')
      ORDER BY je.entry_date, je.voucher_number, l.id`,
    [companyId],
  )
  const entries = new Map<string, { entry_date: string; source_type: string; lines: Array<{ account_number: string; debit_amount: number; credit_amount: number }> }>()
  for (const row of rows) {
    const entry = entries.get(row.id) ?? { entry_date: row.entry_date, source_type: row.source_type, lines: [] }
    entry.lines.push({ account_number: row.account_number, debit_amount: row.debit, credit_amount: row.credit })
    entries.set(row.id, entry)
  }
  return [...entries].map(([id, entry]) => {
    const totals = new Map<string, { debit: number; credit: number }>()
    for (const line of readDeferredSaleLines(id, entry.lines, shares)) {
      const t = totals.get(line.account_number) ?? { debit: 0, credit: 0 }
      totals.set(line.account_number, { debit: t.debit + line.debit_amount, credit: t.credit + line.credit_amount })
    }
    return { entry_date: entry.entry_date, source_type: entry.source_type, ruta05: rutorFromTotals(totals, dynamicVatAccounts).ruta05 }
  })
}

/**
 * An invoice of 2026-03-16 that accrues, defers and sells outright, all 25 %:
 * 10 000 kr of January-February consulting on 1790 towards the company's own
 * 3041, 6 000 kr of April-June support on 2970 towards 3001, and 2 000 kr of
 * setup on 3001. 18 000 kr net, 4 500 kr moms.
 */
async function bookMixedInvoice(seed: Seed): Promise<string> {
  await insertOwnRevenueAccount(seed, '3041', 'Försäljning tjänster 25 %')
  const invoice = await insertInvoiceRows(seed, '2026-03-16', [
    { description: 'Konsultation januari-februari', amount: 10000, vatRate: 25, revenueAccount: '3041', periodisering: { start: '2026-01-01', end: '2026-02-28', account: '1790' } },
    { description: 'Support april-juni', amount: 6000, vatRate: 25, periodisering: { start: '2026-04-01', end: '2026-06-30', account: '2970' } },
    { description: 'Uppsättning', amount: 2000, vatRate: 25 },
  ])
  return bookInvoiceRows(seed, invoice)
}

/** Rutor 05, 08 and 10 of a period: ruta 08 is the 3913 sale of frivillig beskattning. */
async function rutor0508Of(companyId: string, period: { start: string; end: string }) {
  const { rutor } = await loadVatDeclarationLedger(createServiceClientNoCookies(), companyId, period.start, period.end)
  return { ruta05: rutor.ruta05, ruta08: rutor.ruta08, ruta10: rutor.ruta10 }
}

// The first booking loads the posting doors' module graph cold; the limit is
// there to end a hang, not to time a test.
describe('an upplupen intäkt on an invoice line in the momsdeklaration (crm#1919, the mirror case)', { timeout: 60_000 }, () => {
  it('reports the sale with its moms in the invoice month and nothing in the month it accrues: the production shape', async () => {
    // The shape of the production verifikat, its amounts and date changed:
    // an invoice of early November for October work, 200 000 kr at 25 % on
    // the company's own 3041, accrued on 1790.
    const seed = await seedCompany()
    await insertOwnRevenueAccount(seed, '3041', 'Försäljning tjänster 25 %')
    const invoice = await insertInvoiceRows(seed, '2026-11-03', [
      { description: 'Konsultation oktober', amount: 200000, vatRate: 25, revenueAccount: '3041', periodisering: { start: '2026-10-01', end: '2026-10-31', account: '1790' } },
    ])
    await bookInvoiceRows(seed, invoice)

    // Booked the way the reading assumes: 1790 and the whole moms on the
    // invoice, the month Dr 1790 / Cr 3041 on its last day with none.
    expect((await entryLines(seed.companyId)).map(({ entry_date, source_type, lines }) => ({ entry_date, source_type, lines }))).toEqual([
      { entry_date: '2026-10-31', source_type: 'accrual', lines: '1790:200000/0 3041:0/200000' },
      { entry_date: '2026-11-03', source_type: 'invoice_created', lines: '1510:250000/0 1790:0/200000 2611:0/50000' },
    ])

    expect(await rutorOf(seed.companyId, month('2026-10'))).toEqual({ ruta05: 0, ruta10: 0 })
    expect(await rutorOf(seed.companyId, month('2026-11'))).toEqual({ ruta05: 200000, ruta10: 50000 })
    expect(await drillDownRuta05(seed.companyId, month('2026-10'), ['3041'])).toBe(0)
    expect(await drillDownRuta05(seed.companyId, month('2026-11'), ['3041'])).toBe(200000)

    // The same once the company's ledger days are built, as production companies are.
    await getPool().query('SELECT public.build_ledger_account_days($1)', [seed.companyId])
    const { rows: [built] } = await getPool().query<{ ready: boolean }>('SELECT public.ledger_account_days_ready($1) AS ready', [seed.companyId])
    expect(built.ready).toBe(true)
    expect(await rutorOf(seed.companyId, month('2026-10'))).toEqual({ ruta05: 0, ruta10: 0 })
    expect(await rutorOf(seed.companyId, month('2026-11'))).toEqual({ ruta05: 200000, ruta10: 50000 })
    expect(await drillDownRuta05(seed.companyId, month('2026-10'), ['3041'])).toBe(0)
    expect(await drillDownRuta05(seed.companyId, month('2026-11'), ['3041'])).toBe(200000)
  })

  it('keeps the sale out of the old year when the invoice comes after the year-end', async () => {
    // November-December 2025 work, invoiced on 2026-01-15: its months book
    // on 2025-11-30 and 2025-12-31, in the old räkenskapsår. Under
    // faktureringsmetoden the moms is the invoice's (ML 2023:200 7 kap.
    // 14 §; no year-end rule), and its underlag goes with it.
    const seed = await seedCompany()
    await insertFiscalPeriod({ userId: seed.userId, companyId: seed.companyId, name: '2025', periodStart: '2025-01-01', periodEnd: '2025-12-31' })
    const invoice = await insertInvoiceRows(seed, '2026-01-15', [
      { description: 'Konsultation november-december', amount: 20000, vatRate: 25, periodisering: { start: '2025-11-01', end: '2025-12-31', account: '1790' } },
    ])
    await bookInvoiceRows(seed, invoice)
    expect((await entryLines(seed.companyId)).map(({ entry_date, lines }) => ({ entry_date, lines }))).toEqual([
      { entry_date: '2025-11-30', lines: '1790:10000/0 3001:0/10000' },
      { entry_date: '2025-12-31', lines: '1790:10000/0 3001:0/10000' },
      { entry_date: '2026-01-15', lines: '1510:25000/0 1790:0/20000 2611:0/5000' },
    ])

    expect(await rutorOf(seed.companyId, month('2025-11'))).toEqual({ ruta05: 0, ruta10: 0 })
    expect(await rutorOf(seed.companyId, month('2025-12'))).toEqual({ ruta05: 0, ruta10: 0 })
    expect(await rutorOf(seed.companyId, { start: '2025-01-01', end: '2025-12-31' })).toEqual({ ruta05: 0, ruta10: 0 })
    expect(await rutorOf(seed.companyId, month('2026-01'))).toEqual({ ruta05: 20000, ruta10: 5000 })
    expect(await drillDownRuta05(seed.companyId, month('2025-12'))).toBe(0)
    expect(await drillDownRuta05(seed.companyId, month('2026-01'))).toBe(20000)
  })

  it('takes the sale back in the kreditfaktura month, and reads the month stornoed in the old year as nothing', async () => {
    // December 2025 work invoiced on 2026-01-15 and credited on 2026-02-10.
    // The credit flow stornoes the December month on its own date, since the
    // credit date lies outside its räkenskapsår, so February holds only the
    // kreditfaktura: Dr 1790 and Dr 2611.
    const seed = await seedCompany()
    await insertFiscalPeriod({ userId: seed.userId, companyId: seed.companyId, name: '2025', periodStart: '2025-01-01', periodEnd: '2025-12-31' })
    const rows: InvoiceRow[] = [
      { description: 'Konsultation december', amount: 12000, vatRate: 25, periodisering: { start: '2025-12-01', end: '2025-12-31', account: '1790' } },
    ]
    const invoice = await insertInvoiceRows(seed, '2026-01-15', rows)
    await bookInvoiceRows(seed, invoice)
    const creditNote = await insertInvoiceRows(seed, '2026-02-10', rows, { sign: -1, creditedInvoiceId: invoice.id })
    const supabase = createServiceClientNoCookies()
    await runWithActor({ type: 'user' }, async () => {
      const entry = await createCreditNoteJournalEntry(supabase, seed.companyId, seed.userId, creditNote, 'aktiebolag', 'Kund AB')
      expect(entry).not.toBeNull()
      const cancelled = await cancelSchedulesForSource(
        supabase, seed.companyId, seed.userId, { invoiceId: invoice.id }, { reversalDate: creditNote.invoice_date },
      )
      expect(cancelled).toEqual({ cancelledSchedules: 1, reversedEntries: 1, failedReversals: 0 })
    })
    const booked = (await entryLines(seed.companyId)).map(({ entry_date, lines }) => ({ entry_date, lines }))
    expect(booked).toHaveLength(4)
    expect(booked).toEqual(expect.arrayContaining([
      { entry_date: '2025-12-31', lines: '1790:12000/0 3001:0/12000' },
      { entry_date: '2025-12-31', lines: '1790:0/12000 3001:12000/0' },
      { entry_date: '2026-01-15', lines: '1510:15000/0 1790:0/12000 2611:0/3000' },
      { entry_date: '2026-02-10', lines: '1510:0/15000 1790:12000/0 2611:3000/0' },
    ]))

    expect(await rutorOf(seed.companyId, month('2025-12'))).toEqual({ ruta05: 0, ruta10: 0 })
    expect(await rutorOf(seed.companyId, month('2026-01'))).toEqual({ ruta05: 12000, ruta10: 3000 })
    expect(await rutorOf(seed.companyId, month('2026-02'))).toEqual({ ruta05: -12000, ruta10: -3000 })
    expect(await drillDownRuta05(seed.companyId, month('2026-02'))).toBe(-12000)
  })

  it('reads an invoice that accrues and defers: every row in the invoice month, every month of either schedule as nothing', async () => {
    const seed = await seedCompany()
    await bookMixedInvoice(seed)

    const expected: Record<string, { ruta05: number; ruta10: number }> = {
      '2026-01': { ruta05: 0, ruta10: 0 },
      '2026-02': { ruta05: 0, ruta10: 0 },
      '2026-03': { ruta05: 18000, ruta10: 4500 },
      '2026-04': { ruta05: 0, ruta10: 0 },
      '2026-05': { ruta05: 0, ruta10: 0 },
      '2026-06': { ruta05: 0, ruta10: 0 },
    }
    for (const [yearMonth, rutor] of Object.entries(expected)) {
      const read = await rutorOf(seed.companyId, month(yearMonth))
      expect({ yearMonth, ...read }).toEqual({ yearMonth, ...rutor })
      // The invoice's own arithmetic: every row is 25 %.
      expect({ yearMonth, ruta10: read.ruta10 }).toEqual({ yearMonth, ruta10: read.ruta05 * 0.25 })
      expect({ yearMonth, drillDown: await drillDownRuta05(seed.companyId, month(yearMonth), ['3041']) }).toEqual({ yearMonth, drillDown: read.ruta05 })
    }
    expect(await rutorOf(seed.companyId, { start: '2026-01-01', end: '2026-12-31' })).toEqual({ ruta05: 18000, ruta10: 4500 })
  })

  it('moves only the row an inline rättelse changes on an invoice that accrues and defers, each part of its own class', async () => {
    // 10 000 kr of January-February rent accrued on 1790 towards 3913 (ruta
    // 08), 6 000 kr of April-June support deferred on 2970 towards 3001 and
    // 2 000 kr of setup on 3001, all 25 %. A rättelse then lowers the
    // deferral to 5 000 kr and its moms with it. Parts taken of all interim
    // kronor together would read 0,375 and 0,625 of the 15 000 left: ruta 05
    // 7 625 and ruta 08 9 375.
    const seed = await seedCompany()
    const invoice = await insertInvoiceRows(seed, '2026-03-16', [
      { description: 'Hyra januari-februari', amount: 10000, vatRate: 25, revenueAccount: '3913', periodisering: { start: '2026-01-01', end: '2026-02-28', account: '1790' } },
      { description: 'Support april-juni', amount: 6000, vatRate: 25, periodisering: { start: '2026-04-01', end: '2026-06-30', account: '2970' } },
      { description: 'Uppsättning', amount: 2000, vatRate: 25 },
    ])
    const entryId = await bookInvoiceRows(seed, invoice)
    expect(await rutor0508Of(seed.companyId, month('2026-03'))).toEqual({ ruta05: 8000, ruta08: 10000, ruta10: 4500 })

    const { rows: struck } = await getPool().query<{ id: string }>(
      `SELECT id FROM public.journal_entry_lines WHERE journal_entry_id = $1 AND account_number IN ('1510', '2970', '2611')`,
      [entryId],
    )
    await getPool().query('SELECT public.correct_entry_lines_inline($1, $2, $3, $4, $5)', [
      seed.companyId, entryId, struck.map((line) => line.id), JSON.stringify([
        { account_number: '1510', debit_amount: 21250 },
        { account_number: '2970', credit_amount: 5000 },
        { account_number: '2611', credit_amount: 4250 },
      ]), seed.userId,
    ])

    expect(await rutor0508Of(seed.companyId, month('2026-01'))).toEqual({ ruta05: 0, ruta08: 0, ruta10: 0 })
    expect(await rutor0508Of(seed.companyId, month('2026-02'))).toEqual({ ruta05: 0, ruta08: 0, ruta10: 0 })
    expect(await rutor0508Of(seed.companyId, month('2026-03'))).toEqual({ ruta05: 7000, ruta08: 10000, ruta10: 4250 })
    expect(await rutor0508Of(seed.companyId, month('2026-04'))).toEqual({ ruta05: 0, ruta08: 0, ruta10: 0 })
    expect(await drillDownRuta05(seed.companyId, month('2026-03'))).toBe(7000)
  })

  it('folds each verifikat in TS (the changes to a filed period) as the figure reads it: the invoice holds the sale, every month nothing', async () => {
    const seed = await seedCompany()
    await bookMixedInvoice(seed)

    expect(await foldedRuta05ByEntry(seed.companyId)).toEqual([
      { entry_date: '2026-01-31', source_type: 'accrual', ruta05: 0 },
      { entry_date: '2026-02-28', source_type: 'accrual', ruta05: 0 },
      { entry_date: '2026-03-16', source_type: 'invoice_created', ruta05: 18000 },
      { entry_date: '2026-04-01', source_type: 'accrual', ruta05: 0 },
      { entry_date: '2026-05-01', source_type: 'accrual', ruta05: 0 },
      { entry_date: '2026-06-01', source_type: 'accrual', ruta05: 0 },
    ])
  })

  it('reads the accrual an inline rättelse moved to another 17xx account on the invoice verifikat', async () => {
    const seed = await seedCompany()
    const invoice = await insertInvoiceRows(seed, '2026-11-03', [
      { description: 'Konsultation oktober', amount: 8000, vatRate: 25, periodisering: { start: '2026-10-01', end: '2026-10-31', account: '1790' } },
    ])
    const entryId = await bookInvoiceRows(seed, invoice)
    await ensureAccount(seed, '1780', 'Upplupna avtalsintäkter', { accountClass: 1, accountType: 'asset', normalBalance: 'debit' })
    const { rows: [accrualLine] } = await getPool().query<{ id: string }>(
      `SELECT id FROM public.journal_entry_lines WHERE journal_entry_id = $1 AND account_number = '1790'`,
      [entryId],
    )
    await getPool().query('SELECT public.correct_entry_lines_inline($1, $2, $3, $4, $5)', [
      seed.companyId, entryId, [accrualLine.id], JSON.stringify([{ account_number: '1780', credit_amount: 8000 }]), seed.userId,
    ])

    expect(await rutorOf(seed.companyId, month('2026-10'))).toEqual({ ruta05: 0, ruta10: 0 })
    expect(await rutorOf(seed.companyId, month('2026-11'))).toEqual({ ruta05: 8000, ruta10: 2000 })
    expect(await drillDownRuta05(seed.companyId, month('2026-11'))).toBe(8000)
  })

  it('nets a month an inline rättelse moved to the other interim class: a month is its periodisering whole', async () => {
    // The October month corrected from Dr 1790 to Dr 2970. Its part reads
    // every interim line of it, so it still nets to nothing; read off 17xx
    // only, the month would count the 8 000 kr a second time.
    const seed = await seedCompany()
    const invoice = await insertInvoiceRows(seed, '2026-11-03', [
      { description: 'Konsultation oktober', amount: 8000, vatRate: 25, periodisering: { start: '2026-10-01', end: '2026-10-31', account: '1790' } },
    ])
    await bookInvoiceRows(seed, invoice)
    await ensureAccount(seed, '2970', 'Förutbetalda intäkter')
    const { rows: [monthLine] } = await getPool().query<{ id: string; journal_entry_id: string }>(
      `SELECT l.id, l.journal_entry_id FROM public.journal_entry_lines l
         JOIN public.journal_entries je ON je.id = l.journal_entry_id
        WHERE je.company_id = $1 AND je.source_type = 'accrual' AND l.account_number = '1790'`,
      [seed.companyId],
    )
    await getPool().query('SELECT public.correct_entry_lines_inline($1, $2, $3, $4, $5)', [
      seed.companyId, monthLine.journal_entry_id, [monthLine.id], JSON.stringify([{ account_number: '2970', debit_amount: 8000 }]), seed.userId,
    ])

    expect(await rutorOf(seed.companyId, month('2026-10'))).toEqual({ ruta05: 0, ruta10: 0 })
    expect(await rutorOf(seed.companyId, month('2026-11'))).toEqual({ ruta05: 8000, ruta10: 2000 })
    expect(await drillDownRuta05(seed.companyId, month('2026-10'))).toBe(0)
  })

  it('reads a storno and rättelse of the invoice that move the accrual to another 17xx account and change it', async () => {
    // The invoice verifikat stornoed and booked again with 6 000 kr on 1780
    // instead of 8 000 on 1790 (its moms 1 500): the storno takes the whole
    // sale back and the rättelse books the new one.
    const seed = await seedCompany()
    const invoice = await insertInvoiceRows(seed, '2026-11-03', [
      { description: 'Konsultation oktober', amount: 8000, vatRate: 25, periodisering: { start: '2026-10-01', end: '2026-10-31', account: '1790' } },
    ])
    const entryId = await bookInvoiceRows(seed, invoice)
    await ensureAccount(seed, '1780', 'Upplupna avtalsintäkter', { accountClass: 1, accountType: 'asset', normalBalance: 'debit' })
    const company = { userId: seed.userId, companyId: seed.companyId, fiscalPeriodId: seed.fiscalPeriodId, nextPeriodId: seed.fiscalPeriodId }
    const stornoId = await postStorno(company, entryId, { date: '2026-11-10' })
    await postCorrection(seed, entryId, '2026-11-10', [['1510', 7500, 0], ['1780', 0, 6000], ['2611', 0, 1500]])
    await markReversed(entryId, stornoId)

    expect(await rutorOf(seed.companyId, month('2026-10'))).toEqual({ ruta05: 0, ruta10: 0 })
    expect(await rutorOf(seed.companyId, month('2026-11'))).toEqual({ ruta05: 6000, ruta10: 1500 })
    expect(await drillDownRuta05(seed.companyId, month('2026-11'))).toBe(6000)
  })

  it('counts a sale once when a rättelse moves it onto 1790 and a manual upplupen intäkt spreads it from the invoice verifikat', async () => {
    // 4 000 kr of setup moved by a rättelse from 3001 onto 1790, then
    // accrued by hand over September from the invoice verifikat. The
    // invoice's period reads all of 1790 as the sale, so the manual month
    // nets to nothing; read the old way, it would count the 4 000 kr again.
    const seed = await seedCompany()
    const invoice = await insertInvoiceRows(seed, '2026-11-03', [
      { description: 'Konsultation oktober', amount: 8000, vatRate: 25, periodisering: { start: '2026-10-01', end: '2026-10-31', account: '1790' } },
      { description: 'Uppsättning', amount: 4000, vatRate: 25 },
    ])
    const entryId = await bookInvoiceRows(seed, invoice)
    const { rows: [setup] } = await getPool().query<{ id: string }>(
      `SELECT id FROM public.journal_entry_lines WHERE journal_entry_id = $1 AND account_number = '3001'`,
      [entryId],
    )
    await getPool().query('SELECT public.correct_entry_lines_inline($1, $2, $3, $4, $5)', [
      seed.companyId, entryId, [setup.id], JSON.stringify([{ account_number: '1790', credit_amount: 4000 }]), seed.userId,
    ])
    const outcome = await runWithActor({ type: 'user' }, () =>
      createManualAccrualSchedule(
        { supabase: createServiceClientNoCookies(), companyId: seed.companyId, userId: seed.userId, log: createLogger('pg-test') },
        {
          direction: 'revenue',
          amount_sek: 4000,
          balance_account: '1790',
          target_account: '3001',
          period_start: '2026-09-01',
          period_end: '2026-09-30',
          description: 'Uppsättning',
          origin_journal_entry_id: entryId,
        },
        { dryRun: false },
      ),
    )
    expect(outcome.ok).toBe(true)
    expect((await entryLines(seed.companyId)).filter((entry) => entry.entry_date === '2026-09-30').map(({ lines }) => lines)).toEqual([
      '1790:4000/0 3001:0/4000',
    ])

    expect(await rutorOf(seed.companyId, month('2026-09'))).toEqual({ ruta05: 0, ruta10: 0 })
    expect(await rutorOf(seed.companyId, month('2026-10'))).toEqual({ ruta05: 0, ruta10: 0 })
    expect(await rutorOf(seed.companyId, month('2026-11'))).toEqual({ ruta05: 12000, ruta10: 3000 })
  })

  it('reads only the row with moms when a momsfri row is accrued beside it, and leaves the momsfri row where it was', async () => {
    // 8 000 kr at 25 % and 2 000 kr momsfri (3004, ruta 42), both October
    // work accrued on 1790 and invoiced on 2026-11-03. The momsfri row keeps
    // the reading it had: its month, in ruta 42.
    const seed = await seedCompany()
    const invoice = await insertInvoiceRows(seed, '2026-11-03', [
      { description: 'Konsultation oktober', amount: 8000, vatRate: 25, periodisering: { start: '2026-10-01', end: '2026-10-31', account: '1790' } },
      { description: 'Momsfri avgift oktober', amount: 2000, vatRate: 0, periodisering: { start: '2026-10-01', end: '2026-10-31', account: '1790' } },
    ])
    await bookInvoiceRows(seed, invoice)

    const rutorWith42 = async (period: { start: string; end: string }) => {
      const { rutor } = await loadVatDeclarationLedger(createServiceClientNoCookies(), seed.companyId, period.start, period.end)
      return { ruta05: rutor.ruta05, ruta10: rutor.ruta10, ruta42: rutor.ruta42 }
    }
    expect(await rutorWith42(month('2026-10'))).toEqual({ ruta05: 0, ruta10: 0, ruta42: 2000 })
    expect(await rutorWith42(month('2026-11'))).toEqual({ ruta05: 8000, ruta10: 2000, ruta42: 0 })
  })
})
