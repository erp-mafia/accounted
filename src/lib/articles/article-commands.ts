/**
 * Article (artikelregister) create and update: the one write path behind the
 * dashboard's POST /api/articles and PATCH /api/articles/:id and the approval
 * of an agent's staged gnubok_create_article / gnubok_update_article.
 *
 * The doors used to carry their own insert and their own rules. The approval
 * re-parsed staged params with a parallel schema
 * (pending-operations/schemas/article.ts), checked the posting account
 * against active chart rows only, answered a duplicate article number with a
 * raw database error and stored '' where the dashboard stores null; the MCP
 * staging validated nothing, so a bad account or a duplicate number staged
 * and failed at approval. CreateArticleSchema and UpdateArticleSchema
 * (lib/api/schemas.ts) are the one rule set now, and the writes live here.
 */
import type { z } from 'zod'
import type { CreateArticleSchema, UpdateArticleSchema } from '@/lib/api/schemas'
import { ensureArticleNumber } from '@/lib/articles/ensure-article-number'
import { checkRevenueAccount } from '@/lib/articles/validate-revenue-account'
import { eventBus } from '@/lib/events'
import type { OperationContext, OperationOutcome } from '@/lib/operations/types'
import type { Article } from '@/types'

export type ArticleCreateInput = z.output<typeof CreateArticleSchema>
export type ArticleUpdateInput = z.output<typeof UpdateArticleSchema>

/** An empty optional text field means "not set": stored as null, never as ''. */
function setOrNull(value: string | null | undefined): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
}

/**
 * The optional posting-account override against the company's chart. A class
 * 1-3 account that is merely not activated answers ACCOUNTS_NOT_IN_CHART, so
 * the dashboard offers activate-and-retry; anything else outside classes 1-3
 * is ARTICLE_REVENUE_ACCOUNT_INVALID. Null when the account may be pinned.
 */
async function revenueAccountRefusal(
  ctx: OperationContext,
  account: string | null | undefined,
): Promise<Extract<OperationOutcome<never>, { ok: false }> | null> {
  if (!account) return null
  const status = await checkRevenueAccount(ctx.supabase, ctx.companyId, account)
  if (status === 'activatable') {
    return { ok: false, code: 'ACCOUNTS_NOT_IN_CHART', details: { account_numbers: [account] } }
  }
  if (status === 'invalid') return { ok: false, code: 'ARTICLE_REVENUE_ACCOUNT_INVALID' }
  return null
}

/** The row a validated create inserts, with the register's defaults. */
function articleRow(input: ArticleCreateInput) {
  return {
    name: input.name,
    name_en: setOrNull(input.name_en),
    type: input.type ?? 'tjanst',
    unit: input.unit ?? 'st',
    price_excl_vat: input.price_excl_vat,
    vat_rate: input.vat_rate ?? 25,
    currency: input.currency ?? 'SEK',
    revenue_account: input.revenue_account ?? null,
    cost_price: input.cost_price ?? null,
    ean: setOrNull(input.ean),
    housework_type: input.housework_type ?? null,
    notes: setOrNull(input.notes),
    article_number: setOrNull(input.article_number),
  }
}

const UPDATE_FIELDS = [
  'name', 'name_en', 'type', 'unit', 'price_excl_vat', 'vat_rate', 'currency', 'revenue_account',
  'cost_price', 'ean', 'housework_type', 'notes', 'article_number', 'active',
] as const

/** Optional texts a clear stores as null. */
const NULLABLE_TEXT = new Set<string>(['name_en', 'ean', 'notes', 'article_number'])

/** The columns a validated update sets: only the fields sent. */
function articleUpdateRow(input: ArticleUpdateInput): Record<string, unknown> {
  const row: Record<string, unknown> = {}
  for (const key of UPDATE_FIELDS) {
    const value = input[key]
    if (value === undefined) continue
    row[key] = NULLABLE_TEXT.has(key) ? setOrNull(value as string | null) : value
  }
  return row
}

function duplicateNumber(articleNumber: string | null | undefined): Extract<OperationOutcome<never>, { ok: false }> {
  return { ok: false, code: 'ARTICLE_DUPLICATE_NUMBER', details: { articleNumber: articleNumber ?? null } }
}

/**
 * Create one article. The dry run answers the row the create would insert
 * (the article number is assigned on the real insert when none is given).
 */
export async function createArticle(
  ctx: OperationContext,
  input: ArticleCreateInput,
  options: { dryRun?: boolean } = {},
): Promise<OperationOutcome<Article>> {
  const { supabase, companyId, userId, log } = ctx
  const refusal = await revenueAccountRefusal(ctx, input.revenue_account)
  if (refusal) return refusal

  const row = articleRow(input)
  if (options.dryRun) return { ok: true, dryRun: true, preview: row }

  const { data, error } = await supabase
    .from('articles')
    .insert({ ...row, user_id: userId, company_id: companyId })
    .select()
    .single()
  if (error || !data) {
    if ((error as { code?: string } | null)?.code === '23505') return duplicateNumber(row.article_number)
    log.error('article insert failed', error)
    return { ok: false, code: 'ARTICLE_CREATE_FAILED', error }
  }

  // Auto-number when the caller didn't supply one. Non-fatal: an unnumbered
  // article is still usable and can be numbered later.
  if (!data.article_number) {
    try {
      data.article_number = await ensureArticleNumber(supabase, companyId, data.id)
    } catch (err) {
      log.warn('article number assignment failed', err as Error, { articleId: data.id })
    }
  }

  await eventBus.emit({ type: 'article.created', payload: { article: data as Article, companyId, userId } })
  return { ok: true, data: data as Article, created: true }
}

/**
 * Update one article with the fields sent. The dry run answers the columns
 * the update would set, after the same checks, beside the article as it is
 * (current), so the approval card can show what each field held before.
 */
export async function updateArticle(
  ctx: OperationContext,
  articleId: string,
  input: ArticleUpdateInput,
  options: { dryRun?: boolean } = {},
): Promise<OperationOutcome<Article>> {
  const { supabase, companyId, userId, log } = ctx
  const refusal = await revenueAccountRefusal(ctx, input.revenue_account)
  if (refusal) return refusal

  const row = articleUpdateRow(input)
  if (options.dryRun) {
    const { data: existing, error: readError } = await supabase
      .from('articles')
      .select('id, name, name_en, type, unit, price_excl_vat, vat_rate, currency, revenue_account, cost_price, ean, housework_type, notes, article_number, active')
      .eq('id', articleId)
      .eq('company_id', companyId)
      .maybeSingle()
    if (readError) {
      log.error('article read failed', readError)
      return { ok: false, code: 'ARTICLE_UPDATE_FAILED', error: readError }
    }
    if (!existing) return { ok: false, code: 'ARTICLE_NOT_FOUND' }
    const stored = existing as Record<string, unknown>
    const current = Object.fromEntries(UPDATE_FIELDS.map((key) => [key, stored[key] ?? null]))
    return {
      ok: true,
      dryRun: true,
      preview: { article_id: articleId, id: existing.id, name: existing.name, article_number: existing.article_number, current, changes: row },
    }
  }

  const { data, error } = await supabase
    .from('articles')
    .update(row)
    .eq('id', articleId)
    .eq('company_id', companyId)
    .select()
    .single()
  if (error || !data) {
    const code = (error as { code?: string } | null)?.code
    if (code === 'PGRST116' || !error) return { ok: false, code: 'ARTICLE_NOT_FOUND' }
    if (code === '23505') return duplicateNumber(input.article_number)
    log.error('article update failed', error)
    return { ok: false, code: 'ARTICLE_UPDATE_FAILED', error }
  }

  await eventBus.emit({ type: 'article.updated', payload: { article: data as Article, companyId, userId } })
  return { ok: true, data: data as Article }
}
