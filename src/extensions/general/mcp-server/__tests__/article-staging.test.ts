/**
 * gnubok_create_article and gnubok_update_article stage with the register's
 * one rule set and the approval's own checks (lib/articles/article-commands.ts).
 * Before, both staged whatever arrived: a posting account that could not be
 * pinned, an unknown article id or a malformed field staged and failed only
 * at approval.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createTableMockSupabase } from '@/tests/helpers'
import { tools } from '../server'

vi.mock('@/lib/currency/riksbanken', () => ({ fetchExchangeRate: vi.fn(), convertToSEK: vi.fn() }))

const ARTICLE_ID = '3a9ac4d2-163a-4d43-8fa3-1b32827505fa'
const actor = { kind: 'api_key', apiKeyId: 'ak_1' } as never
const create = () => tools.find((t) => t.name === 'gnubok_create_article')!
const update = () => tools.find((t) => t.name === 'gnubok_update_article')!

beforeEach(() => vi.clearAllMocks())

describe('gnubok_create_article: staged with the one rule set', () => {
  it('stages the normalized article, and the approver sees the row the approval inserts', async () => {
    const { supabase, findCall } = createTableMockSupabase({ pending_operations: { data: { id: 'op-1' } } })
    await create().execute(
      { name: ' Takarbete ', price_excl_vat: 850, currency: 'sek', notes: '' },
      'company-1',
      'user-1',
      supabase as never,
      actor,
    )
    const staged = findCall('pending_operations', 'insert')?.[0] as Record<string, unknown>
    expect(staged).toMatchObject({ operation_type: 'create_article', title: 'Ny artikel: Takarbete' })
    expect(staged.params).toMatchObject({ name: 'Takarbete', currency: 'SEK' })
    expect(staged.preview_data).toMatchObject({ name: 'Takarbete', currency: 'SEK', unit: 'st', notes: null, vat_rate: 25 })
  })

  it('refuses a posting account outside classes 1-3 at staging', async () => {
    const { supabase, findCall } = createTableMockSupabase({
      chart_of_accounts: { data: { account_class: 5, is_active: true } },
    })
    await expect(
      create().execute({ name: 'Takarbete', price_excl_vat: 850, revenue_account: '3011' }, 'company-1', 'user-1', supabase as never, actor),
    ).rejects.toMatchObject({ code: 'ARTICLE_REVENUE_ACCOUNT_INVALID' })
    expect(findCall('pending_operations', 'insert')).toBeUndefined()
  })

  it('refuses a malformed field as VALIDATION_ERROR naming it', async () => {
    const { supabase } = createTableMockSupabase()
    await expect(
      create().execute({ name: 'Takarbete', price_excl_vat: 850, housework_type: 'Snickeri' }, 'company-1', 'user-1', supabase as never, actor),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
  })
})

describe('gnubok_update_article: staged with the one rule set', () => {
  it('refuses an article id outside the company at staging', async () => {
    const { supabase, findCall } = createTableMockSupabase({ articles: { data: null } })
    await expect(
      update().execute({ article_id: ARTICLE_ID, price_excl_vat: 900 }, 'company-1', 'user-1', supabase as never, actor),
    ).rejects.toMatchObject({ code: 'ARTICLE_NOT_FOUND' })
    expect(findCall('pending_operations', 'insert')).toBeUndefined()
  })

  it('stages the fields as sent, so a clear stays a clear, with the article named', async () => {
    const { supabase, findCall } = createTableMockSupabase({
      articles: { data: { id: ARTICLE_ID, name: 'Takarbete', article_number: 'A-0001' } },
      pending_operations: { data: { id: 'op-1' } },
    })
    await update().execute(
      { article_id: ARTICLE_ID, housework_type: '', active: false },
      'company-1',
      'user-1',
      supabase as never,
      actor,
    )
    const staged = findCall('pending_operations', 'insert')?.[0] as Record<string, unknown>
    expect(staged).toMatchObject({ operation_type: 'update_article', title: 'Uppdatera artikel Takarbete' })
    expect(staged.params).toEqual({ article_id: ARTICLE_ID, housework_type: '', active: false })
    expect(staged.preview_data).toMatchObject({ name: 'Takarbete', changes: { housework_type: null, active: false } })
  })
})
