/**
 * The duplicate-payment sweep against a REAL PostgREST.
 *
 * What only this file can prove: that the ONE logic expression a currency
 * sweep sends, `or=(and(or(<currency>),or(merchant_name.ilike.*x*,
 * description.ilike.*x*)))`, is parsed by PostgREST as "currency AND name",
 * so a row of the wrong currency is excluded by the SQL, not merely by the
 * per-row re-check in JS. A recording stub answers whatever it is queued
 * with; the grammar and the semantics live in PostgREST.
 *
 * Seeds, for one company, three outbound rows and three inbound rows of the
 * same shape:
 *   right currency + name hit   -> the only row a sweep may return
 *   wrong currency + name hit   -> must be excluded by the currency clause.
 *                                  Its amount_sek equals the payment, so if
 *                                  the SQL leaked it every JS check would pass
 *                                  and the detector would offer it.
 *   right currency + no name hit -> must be excluded by the name clause
 *
 * Both detectors run twice: a SEK invoice (one kronor sweep) and a EUR invoice
 * with a stored rate (a EUR sweep and a kronor sweep), and the ids PostgREST
 * actually returned are read at the transport as well.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { randomUUID } from 'node:crypto'
import { seedCompany } from '@/tests/pg/fixtures'
import { getPool } from '@/tests/pg/setup'
import { createToolPgClient, TOOL_PG_REST_URL } from '@/tests/tool-pg/client'
import {
  findDuplicatePaymentCandidatesForInvoice,
  findDuplicatePaymentCandidatesForSupplierInvoice,
} from '@/lib/invoices/duplicate-payment-candidates'

const REST_HOST = TOOL_PG_REST_URL.replace(/^https?:\/\//, '')

interface CapturedSweep {
  url: URL
  ids: string[]
}

const captured: CapturedSweep[] = []
const originalFetch = globalThis.fetch

beforeAll(() => {
  globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
    const response = await originalFetch(...args)
    const url = String(args[0])
    if (url.includes(REST_HOST) && url.includes('/transactions?')) {
      let ids: string[] = []
      try {
        const body = (await response.clone().json()) as Array<{ id?: string }>
        ids = Array.isArray(body) ? body.map((r) => String(r.id)) : []
      } catch {
        ids = []
      }
      captured.push({ url: new URL(url), ids })
    }
    return response
  }) as typeof fetch
})

afterAll(() => {
  globalThis.fetch = originalFetch
})

let companyId: string
let userId: string
let client: ReturnType<typeof createToolPgClient>

/** Ids of the seeded rows, keyed by what they are meant to prove. */
const rows: Record<string, string> = {}

async function insertRow(params: {
  amount: number
  currency: 'SEK' | 'EUR'
  amountSek: number | null
  description: string
  merchantName: string | null
}): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.transactions
       (id, company_id, user_id, currency, amount, amount_sek, date, description,
        merchant_name, is_business, category)
     VALUES ($1, $2, $3, $4, $5, $6, '2026-09-01', $7, $8, true, 'uncategorized')`,
    [
      id,
      companyId,
      userId,
      params.currency,
      params.amount,
      params.amountSek,
      params.description,
      params.merchantName,
    ],
  )
  return id
}

beforeAll(async () => {
  client = createToolPgClient()
  const seeded = await seedCompany()
  companyId = seeded.companyId
  userId = seeded.userId

  // Outbound (supplier side). The SEK invoice pays 12 500 kr; the EUR invoice
  // pays 1 000 EUR at 11,50 (11 500 kr).
  rows.outSekHit = await insertRow({ amount: -12500, currency: 'SEK', amountSek: null, description: 'HI3G', merchantName: null })
  rows.outEurHitWrongCurrency = await insertRow({ amount: -12500, currency: 'EUR', amountSek: -12500, description: 'HI3G', merchantName: null })
  rows.outSekMiss = await insertRow({ amount: -12500, currency: 'SEK', amountSek: null, description: 'Telia', merchantName: 'TELIA' })
  rows.outEurHit = await insertRow({ amount: -1000, currency: 'EUR', amountSek: -11500, description: 'HI3G', merchantName: null })
  rows.outSekHitWrongCurrencyForEur = await insertRow({ amount: -1000, currency: 'SEK', amountSek: null, description: 'HI3G', merchantName: null })
  rows.outEurMiss = await insertRow({ amount: -1000, currency: 'EUR', amountSek: -11500, description: 'Telia', merchantName: null })

  // Inbound (customer side), same shapes with the sign flipped.
  rows.inSekHit = await insertRow({ amount: 12500, currency: 'SEK', amountSek: null, description: 'HI3G', merchantName: null })
  rows.inEurHitWrongCurrency = await insertRow({ amount: 12500, currency: 'EUR', amountSek: 12500, description: 'HI3G', merchantName: null })
  rows.inSekMiss = await insertRow({ amount: 12500, currency: 'SEK', amountSek: null, description: 'Telia', merchantName: 'TELIA' })
  rows.inEurHit = await insertRow({ amount: 1000, currency: 'EUR', amountSek: 11500, description: 'HI3G', merchantName: null })
  rows.inSekHitWrongCurrencyForEur = await insertRow({ amount: 1000, currency: 'SEK', amountSek: null, description: 'HI3G', merchantName: null })
  rows.inEurMiss = await insertRow({ amount: 1000, currency: 'EUR', amountSek: 11500, description: 'Telia', merchantName: null })
}, 30_000)

afterAll(async () => {
  // Best-effort cleanup: the harness database is shared across files.
  try {
    await getPool().query('DELETE FROM public.transactions WHERE company_id = $1', [companyId])
    await getPool().query('DELETE FROM public.company_members WHERE company_id = $1', [companyId])
    await getPool().query('DELETE FROM public.fiscal_periods WHERE company_id = $1', [companyId])
    await getPool().query('DELETE FROM public.companies WHERE id = $1', [companyId])
  } catch {
    // Leftover seed rows are harmless: every query here filters by company_id.
  }
})

/** The sweeps PostgREST answered since `from`, with the ids it returned. */
function sweepsSince(from: number): CapturedSweep[] {
  return captured.slice(from)
}

describe('duplicate-payment sweep against real PostgREST', () => {
  it('parses the nested single-or expression at all (self-test: a malformed one is a 400)', async () => {
    const good = await client
      .from('transactions')
      .select('id')
      .eq('company_id', companyId)
      .or('and(or(currency.is.null,currency.eq.SEK),or(merchant_name.ilike.*hi3g*,description.ilike.*hi3g*))')
    expect(good.error).toBeNull()

    const bad = await client
      .from('transactions')
      .select('id')
      .eq('company_id', companyId)
      .or('and(or(currency.is.null,currency.eq.SEK),or(merchant_name.ilike.*hi3g*,description.ilike.*hi3g*)')
    expect(bad.error).not.toBeNull()
    expect(bad.error?.code).toBe('PGRST100')
  })

  it('supplier side, SEK invoice: only the kronor row with the name hit', async () => {
    const from = captured.length
    const candidates = await findDuplicatePaymentCandidatesForSupplierInvoice(client, {
      companyId,
      invoice: {
        supplier_invoice_number: '4471023987',
        supplier_name: 'Hi3G Access AB',
        currency: 'SEK',
        total: 12500,
        total_sek: 12500,
        exchange_rate: null,
      },
      paymentAmount: 12500,
      paymentDate: '2026-09-01',
    })

    expect(candidates.map((c) => c.id)).toEqual([rows.outSekHit])
    expect(candidates[0].match_reason).toBe('name_amount_fuzzy')

    // What PostgREST itself returned for the one kronor sweep: the wrong-currency
    // row is absent HERE, so the currency clause did its work in SQL.
    const sweeps = sweepsSince(from)
    expect(sweeps).toHaveLength(1)
    expect(sweeps[0].url.searchParams.getAll('or')).toHaveLength(1)
    expect(sweeps[0].ids).toEqual([rows.outSekHit])
  })

  it('supplier side, EUR invoice with a rate: the EUR sweep returns only the EUR name hit', async () => {
    const from = captured.length
    const candidates = await findDuplicatePaymentCandidatesForSupplierInvoice(client, {
      companyId,
      invoice: {
        supplier_invoice_number: '4471023987',
        supplier_name: 'Hi3G Access AB',
        currency: 'EUR',
        total: 1000,
        total_sek: 11500,
        exchange_rate: 11.5,
      },
      paymentAmount: 1000,
      paymentDate: '2026-09-01',
    })

    expect(candidates.map((c) => c.id)).toEqual([rows.outEurHit])

    const sweeps = sweepsSince(from)
    expect(sweeps).toHaveLength(2)
    const eurSweep = sweeps.find((s) => s.url.searchParams.getAll('or')[0]?.includes('currency.eq.EUR'))
    const sekSweep = sweeps.find((s) => s.url.searchParams.getAll('or')[0]?.includes('currency.eq.SEK'))
    expect(eurSweep).toBeDefined()
    expect(sekSweep).toBeDefined()
    // The kronor row of the same raw magnitude with the name hit sits inside the
    // EUR band; only the currency clause keeps it out of the EUR sweep.
    expect(eurSweep!.ids).toEqual([rows.outEurHit])
    // Nothing in kronor is within 2 % of 11 500 kr.
    expect(sekSweep!.ids).toEqual([])
  })

  it('customer side, SEK invoice: only the kronor row with the name hit', async () => {
    const from = captured.length
    const candidates = await findDuplicatePaymentCandidatesForInvoice(client, {
      companyId,
      invoice: {
        invoice_number: '2026-0042',
        customer_name: 'Hi3G Access AB',
        currency: 'SEK',
        total: 12500,
        total_sek: 12500,
        exchange_rate: null,
      },
      paymentAmount: 12500,
      paymentDate: '2026-09-01',
    })

    expect(candidates.map((c) => c.id)).toEqual([rows.inSekHit])

    const sweeps = sweepsSince(from)
    // One name sweep; a hit means the aggregate sweep never runs.
    expect(sweeps).toHaveLength(1)
    expect(sweeps[0].url.searchParams.getAll('or')).toHaveLength(1)
    expect(sweeps[0].ids).toEqual([rows.inSekHit])
  })

  it('customer side, EUR invoice with a rate: the EUR sweep returns only the EUR name hit', async () => {
    const from = captured.length
    const candidates = await findDuplicatePaymentCandidatesForInvoice(client, {
      companyId,
      invoice: {
        invoice_number: '2026-0043',
        customer_name: 'Hi3G Access AB',
        currency: 'EUR',
        total: 1000,
        total_sek: 11500,
        exchange_rate: 11.5,
      },
      paymentAmount: 1000,
      paymentDate: '2026-09-01',
    })

    expect(candidates.map((c) => c.id)).toEqual([rows.inEurHit])

    const sweeps = sweepsSince(from)
    expect(sweeps).toHaveLength(2)
    const eurSweep = sweeps.find((s) => s.url.searchParams.getAll('or')[0]?.includes('currency.eq.EUR'))
    const sekSweep = sweeps.find((s) => s.url.searchParams.getAll('or')[0]?.includes('currency.eq.SEK'))
    expect(eurSweep!.ids).toEqual([rows.inEurHit])
    expect(sekSweep!.ids).toEqual([])
  })
})
