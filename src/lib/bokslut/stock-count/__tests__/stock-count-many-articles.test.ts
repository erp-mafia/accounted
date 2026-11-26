/**
 * createStockCount for a count whose rows name many articles.
 *
 * Before the draft is written, every article a row names is checked to be the
 * company's, by id with `.in()`. supabase-js puts the ids in the GET query
 * string, about 39 characters a uuid, so a count of a few hundred linked rows
 * passed a self-hosted Kong's 8 KB and the save was refused; past 1000 ids
 * one read would also stop at PostgREST's max-rows and call the rest missing.
 * A count holds up to STOCK_COUNT_MAX_ROWS rows. The fake gateway
 * (tests/gateway-supabase.ts) refuses a URL past the 8 KB.
 */
import { describe, expect, it } from 'vitest'
import { createStockCount } from '../register'
import { StockCountError } from '../errors'
import { STOCK_COUNT_MAX_ROWS } from '../schemas'
import { ID_READ_CHUNK } from '@/lib/reconciliation/limits'
import { createGatewaySupabase, GATEWAY_URL_LIMIT, inListOf } from '@/tests/gateway-supabase'

const COMPANY = '5b0c3c1e-0000-4000-8000-000000000001'
const USER = '6c1d2e3f-0000-4000-8000-000000000001'
const PERIOD = {
  id: '3f6c2a1e-8b4d-4c2e-9a71-5d0e6b7c8a90',
  company_id: COMPANY,
  name: '2026',
  period_start: '2026-01-01',
  period_end: '2026-12-31',
}

const uuid = (n: number, prefix: string) => `${prefix}-0000-4000-8000-${String(n).padStart(12, '0')}`
const range = (count: number) => Array.from({ length: count }, (_, i) => i + 1)
const articleId = (n: number) => uuid(n, 'abcdef01')

const articles = (count: number) => range(count).map((n) => ({ id: articleId(n), company_id: COMPANY }))
const count = (rows: number) => ({
  fiscal_period_id: PERIOD.id,
  count_date: '2026-12-31',
  rows: range(rows).map((n) => ({ description: `Artikel ${n}`, quantity: 1, unit_cost: 10, article_id: articleId(n) })),
})

describe('createStockCount: rows on many articles', () => {
  it('saves a full count with every row on its own article, in requests the gateway takes', async () => {
    const { supabase, requests, requestsTo, unmodelled } = createGatewaySupabase({
      fiscal_periods: [PERIOD],
      articles: articles(STOCK_COUNT_MAX_ROWS),
    })

    await createStockCount(supabase, COMPANY, USER, count(STOCK_COUNT_MAX_ROWS))

    const inserted = requestsTo('inventory_count_rows').find((r) => r.method === 'POST')!.body as Array<{ article_id: string }>
    expect(inserted.map((r) => r.article_id)).toEqual(range(STOCK_COUNT_MAX_ROWS).map(articleId))
    expect(requests.every((r) => r.url.length <= GATEWAY_URL_LIMIT)).toBe(true)
    expect(requestsTo('articles').map((r) => inListOf(r, 'id').length)).toEqual(
      Array(STOCK_COUNT_MAX_ROWS / ID_READ_CHUNK).fill(ID_READ_CHUNK),
    )
    expect(unmodelled).toEqual([])
  })

  it('refuses a count of many articles that names one the company lacks, naming that one and writing nothing', async () => {
    const { supabase, requests, requestsTo, unmodelled } = createGatewaySupabase({
      fiscal_periods: [PERIOD],
      articles: articles(250).filter((a) => a.id !== articleId(201)),
    })

    const refusal = await createStockCount(supabase, COMPANY, USER, count(250)).catch((err: unknown) => err)

    expect(refusal).toBeInstanceOf(StockCountError)
    expect(refusal).toMatchObject({ code: 'STOCK_COUNT_ARTICLE_NOT_FOUND', details: { article_ids: [articleId(201)] } })
    expect(requestsTo('inventory_counts')).toEqual([])
    expect(requests.every((r) => r.url.length <= GATEWAY_URL_LIMIT)).toBe(true)
    expect(unmodelled).toEqual([])
  })
})
