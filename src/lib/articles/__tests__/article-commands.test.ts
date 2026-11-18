/**
 * The article register's one rule set (CreateArticleSchema / UpdateArticleSchema)
 * and its write path (lib/articles/article-commands.ts), shared by the
 * dashboard and the approval of an agent's staged article.
 *
 * The rule-set assertions moved here from the deleted parallel schema
 * (pending-operations/schemas/article.ts): what the agent path accepted, the
 * one schema accepts the same way.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createTableMockSupabase } from '@/tests/helpers'
import { CreateArticleSchema, UpdateArticleSchema } from '@/lib/api/schemas'
import { createArticle, updateArticle } from '../article-commands'

vi.mock('@/lib/events', () => ({ eventBus: { emit: vi.fn() } }))

const base = { name: 'EU-konsulting', price_excl_vat: 950 }
const ARTICLE_ID = '0d1d0000-0000-4000-8000-000000000002'
const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: vi.fn() } as never

describe('CreateArticleSchema: the agent path\'s inputs', () => {
  it('normalizes a currency code to upper case', () => {
    expect(CreateArticleSchema.parse({ ...base, currency: 'eur' }).currency).toBe('EUR')
  })

  it('treats an empty, null or omitted currency as unset (the insert defaults to SEK)', () => {
    expect(CreateArticleSchema.parse({ ...base, currency: '' }).currency).toBeUndefined()
    expect(CreateArticleSchema.parse({ ...base, currency: null }).currency).toBeUndefined()
    expect(CreateArticleSchema.parse(base).currency).toBeUndefined()
  })

  it('rejects a currency outside the supported set', () => {
    expect(CreateArticleSchema.safeParse({ ...base, currency: 'EURO' }).success).toBe(false)
    expect(CreateArticleSchema.safeParse({ ...base, currency: 'E1' }).success).toBe(false)
  })

  it('trims the name and refuses a blank one', () => {
    expect(CreateArticleSchema.parse({ ...base, name: '  Takarbete ' }).name).toBe('Takarbete')
    expect(CreateArticleSchema.safeParse({ ...base, name: '   ' }).success).toBe(false)
  })

  it('treats an empty unit as unset (the insert defaults to st)', () => {
    expect(CreateArticleSchema.parse({ ...base, unit: '' }).unit).toBeUndefined()
  })

  it('normalizes a work-type code or bare kind to upper case', () => {
    expect(CreateArticleSchema.parse({ ...base, housework_type: 'stad' }).housework_type).toBe('STAD')
    expect(CreateArticleSchema.parse({ ...base, housework_type: 'rut' }).housework_type).toBe('RUT')
    expect(
      CreateArticleSchema.parse({ ...base, type: 'vara', housework_type: 'installation_solceller' }).housework_type,
    ).toBe('INSTALLATION_SOLCELLER')
  })

  it('treats an empty, whitespace or null housework_type as no flag', () => {
    expect(CreateArticleSchema.parse({ ...base, housework_type: '' }).housework_type ?? null).toBeNull()
    expect(CreateArticleSchema.parse({ ...base, housework_type: '  ' }).housework_type ?? null).toBeNull()
    expect(CreateArticleSchema.parse({ ...base, housework_type: null }).housework_type ?? null).toBeNull()
  })

  it('rejects free text and a bare grön teknik kind: the flag would be dead on invoice lines', () => {
    expect(CreateArticleSchema.safeParse({ ...base, housework_type: 'Snickeri' }).success).toBe(false)
    expect(CreateArticleSchema.safeParse({ ...base, housework_type: '1' }).success).toBe(false)
    const greenKind = CreateArticleSchema.safeParse({ ...base, housework_type: 'GRON_TEKNIK' })
    expect(greenKind.success).toBe(false)
    if (!greenKind.success) expect(greenKind.error.issues[0].message).toContain('INSTALLATION_LADDPUNKT')
  })
})

describe('UpdateArticleSchema: sparse updates', () => {
  it('accepts a currency-only update and leaves an omitted currency untouched', () => {
    expect(UpdateArticleSchema.parse({ currency: 'usd' }).currency).toBe('USD')
    expect(UpdateArticleSchema.parse({ name: 'Nytt namn' }).currency).toBeUndefined()
  })

  it('normalizes a housework_type, leaves an omitted one untouched, and clears on null, empty or whitespace', () => {
    expect(UpdateArticleSchema.parse({ housework_type: 'malning' }).housework_type).toBe('MALNING')
    expect(UpdateArticleSchema.parse({ housework_type: 'INSTALLATION_LAGRING' }).housework_type).toBe('INSTALLATION_LAGRING')
    expect(UpdateArticleSchema.parse({ name: 'Nytt namn' }).housework_type).toBeUndefined()
    expect(UpdateArticleSchema.parse({ housework_type: null }).housework_type).toBeNull()
    expect(UpdateArticleSchema.parse({ housework_type: '' }).housework_type).toBeNull()
    expect(UpdateArticleSchema.parse({ housework_type: '  ' }).housework_type).toBeNull()
    expect(UpdateArticleSchema.safeParse({ housework_type: 'Snickeri' }).success).toBe(false)
  })
})

describe('createArticle', () => {
  beforeEach(() => vi.clearAllMocks())

  const ctx = (supabase: unknown) => ({ supabase: supabase as never, companyId: 'company-1', userId: 'user-1', log })

  it('dry run: answers the row with the register\'s defaults and writes nothing', async () => {
    const { supabase, findCalls } = createTableMockSupabase()
    const outcome = await createArticle(ctx(supabase), CreateArticleSchema.parse({ ...base, notes: '', ean: '' }), {
      dryRun: true,
    })
    expect(outcome).toEqual({
      ok: true,
      dryRun: true,
      preview: expect.objectContaining({ name: 'EU-konsulting', type: 'tjanst', unit: 'st', vat_rate: 25, currency: 'SEK', notes: null, ean: null }),
    })
    expect(findCalls('articles', 'insert')).toEqual([])
  })

  it('refuses an inactive class 1-3 posting account as ACCOUNTS_NOT_IN_CHART (activate and retry)', async () => {
    const { supabase, findCalls } = createTableMockSupabase({
      chart_of_accounts: { data: { account_class: 3, is_active: false } },
    })
    const outcome = await createArticle(ctx(supabase), CreateArticleSchema.parse({ ...base, revenue_account: '3011' }))
    expect(outcome).toEqual({ ok: false, code: 'ACCOUNTS_NOT_IN_CHART', details: { account_numbers: ['3011'] } })
    expect(findCalls('articles', 'insert')).toEqual([])
  })

  it('refuses an account outside classes 1-3 as ARTICLE_REVENUE_ACCOUNT_INVALID', async () => {
    const { supabase } = createTableMockSupabase({ chart_of_accounts: { data: { account_class: 5, is_active: true } } })
    const outcome = await createArticle(ctx(supabase), CreateArticleSchema.parse({ ...base, revenue_account: '3011' }))
    expect(outcome).toMatchObject({ ok: false, code: 'ARTICLE_REVENUE_ACCOUNT_INVALID' })
  })

  it('answers a duplicate article number with its code', async () => {
    const { supabase } = createTableMockSupabase({ articles: { data: null, error: { code: '23505', message: 'dup' } } })
    const outcome = await createArticle(ctx(supabase), CreateArticleSchema.parse({ ...base, article_number: 'A-1' }))
    expect(outcome).toEqual({ ok: false, code: 'ARTICLE_DUPLICATE_NUMBER', details: { articleNumber: 'A-1' } })
  })

  it('inserts the row with null for empty optional texts', async () => {
    const created = { id: ARTICLE_ID, article_number: 'A-0001', name: 'EU-konsulting' }
    const { supabase, findCalls } = createTableMockSupabase({ articles: { data: created } })
    const outcome = await createArticle(ctx(supabase), CreateArticleSchema.parse({ ...base, name_en: '', notes: ' ' }))
    expect(outcome).toMatchObject({ ok: true, data: created })
    const [row] = findCalls('articles', 'insert')[0] as [Record<string, unknown>]
    expect(row).toMatchObject({ name: 'EU-konsulting', name_en: null, notes: null, user_id: 'user-1', company_id: 'company-1' })
  })
})

describe('updateArticle', () => {
  beforeEach(() => vi.clearAllMocks())

  const ctx = (supabase: unknown) => ({ supabase: supabase as never, companyId: 'company-1', userId: 'user-1', log })

  it('sets only the fields sent, and a cleared optional text as null', async () => {
    const { supabase, findCalls } = createTableMockSupabase({ articles: { data: { id: ARTICLE_ID } } })
    const outcome = await updateArticle(ctx(supabase), ARTICLE_ID, UpdateArticleSchema.parse({ price_excl_vat: 1000, notes: '' }))
    expect(outcome.ok).toBe(true)
    expect(findCalls('articles', 'update')).toEqual([[{ price_excl_vat: 1000, notes: null }]])
  })

  it('answers ARTICLE_NOT_FOUND for an article outside the company', async () => {
    const { supabase } = createTableMockSupabase({ articles: { data: null, error: { code: 'PGRST116', message: 'no rows' } } })
    const outcome = await updateArticle(ctx(supabase), ARTICLE_ID, UpdateArticleSchema.parse({ name: 'X' }))
    expect(outcome).toMatchObject({ ok: false, code: 'ARTICLE_NOT_FOUND' })
  })

  it('dry run: names the article and the changes, and writes nothing', async () => {
    const { supabase, findCalls } = createTableMockSupabase({
      articles: { data: { id: ARTICLE_ID, name: 'Takarbete', article_number: 'A-0001' } },
    })
    const outcome = await updateArticle(ctx(supabase), ARTICLE_ID, UpdateArticleSchema.parse({ active: false }), { dryRun: true })
    expect(outcome).toMatchObject({
      ok: true,
      dryRun: true,
      preview: { article_id: ARTICLE_ID, id: ARTICLE_ID, name: 'Takarbete', article_number: 'A-0001', changes: { active: false } },
    })
    expect(findCalls('articles', 'update')).toEqual([])
  })

  // crm#1300: the approval card shows what each field held, so the approver
  // need not open the article to judge a price change.
  it('dry run: answers the article as it is beside the changes, every field an update can set', async () => {
    const stored = {
      id: ARTICLE_ID, name: 'Takarbete', name_en: null, type: 'tjanst', unit: 'tim', price_excl_vat: 1180, vat_rate: 25,
      currency: 'EUR', revenue_account: '3041', cost_price: null, ean: null, housework_type: 'BYGG', notes: null,
      article_number: '920', active: true,
    }
    const { supabase } = createTableMockSupabase({ articles: { data: stored } })
    const outcome = await updateArticle(ctx(supabase), ARTICLE_ID, UpdateArticleSchema.parse({ price_excl_vat: 1220 }), { dryRun: true })
    if (!outcome.ok || !outcome.dryRun) throw new Error('expected a dry run')
    const { id: _id, ...current } = stored
    expect(outcome.preview.current).toEqual(current)
    expect(outcome.preview.changes).toEqual({ price_excl_vat: 1220 })
  })
})
