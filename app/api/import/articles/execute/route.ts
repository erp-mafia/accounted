import { NextResponse } from 'next/server'
import { ensureInitialized } from '@/lib/init'
import { eventBus } from '@/lib/events'
import { validateBody } from '@/lib/api/validate'
import { ArticleImportExecuteSchema } from '@/lib/api/schemas'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { ensureArticleNumber } from '@/lib/articles/ensure-article-number'
import { checkRevenueAccount, type RevenueAccountStatus } from '@/lib/articles/validate-revenue-account'
import type { Article } from '@/types'
import type { ArticleImportExecuteResult } from '@/lib/import/articles/types'

ensureInitialized()

interface ExistingArticle {
  id: string
  name: string
  article_number: string | null
}

function nameKey(value: string | null): string | null {
  if (!value) return null
  return value.trim().toLowerCase() || null
}

/**
 * POST /api/import/articles/execute
 *
 * Imports validated article rows. Duplicates (matched by article number, then
 * by name) are either updated (merge: only non-empty fields overwrite) or
 * skipped based on `update_duplicates`. An optional BAS revenue-account override
 * is kept only when it is an active class-3 account; unknown/inactive accounts
 * are dropped (with a warning) rather than mutating the chart of accounts.
 */
export const POST = withRouteContext(
  'register_import.articles.execute',
  async (request, ctx) => {
    const { user, supabase, companyId, log, requestId } = ctx

    const result = await validateBody(request, ArticleImportExecuteSchema, {
      log,
      operation: 'register_import.articles.execute',
    })
    if (!result.success) return result.response

    const { rows, update_duplicates } = result.data
    const opLog = log.child({ rowCount: rows.length, updateDuplicates: update_duplicates })

    if (rows.length === 0) {
      return errorResponseFromCode('REG_IMPORT_NO_ROWS', opLog, { requestId })
    }

    try {
      const existingRaw = await fetchAllRows(({ from, to }) =>
        supabase
          .from('articles')
          .select('id, name, article_number')
          .eq('company_id', companyId)
          .range(from, to),
      )
      const existing = existingRaw as unknown as ExistingArticle[]

      const byNumber = new Map<string, ExistingArticle>()
      const byName = new Map<string, ExistingArticle>()
      for (const a of existing) {
        if (a.article_number) byNumber.set(a.article_number, a)
        const nk = nameKey(a.name)
        if (nk && !byName.has(nk)) byName.set(nk, a)
      }

      // Revenue-account validation is cached per distinct account so a large
      // import doesn't re-query the chart for every row.
      const accountStatusCache = new Map<string, RevenueAccountStatus>()
      const droppedAccounts = new Set<string>()
      const warnings: string[] = []
      const resolveRevenueAccount = async (acc: string | null): Promise<string | null> => {
        if (!acc) return null
        let status = accountStatusCache.get(acc)
        if (!status) {
          status = await checkRevenueAccount(supabase, companyId!, acc)
          accountStatusCache.set(acc, status)
        }
        if (status === 'ok') return acc
        if (!droppedAccounts.has(acc)) {
          droppedAccounts.add(acc)
          warnings.push(
            status === 'activatable'
              ? `Försäljningskonto ${acc} är inte aktiverat i kontoplanen. Artiklar importerades utan kontoöverstyrning.`
              : `Försäljningskonto ${acc} är ogiltigt, ignorerades.`,
          )
        }
        return null
      }

      const created: Article[] = []
      const updated: Article[] = []
      let skipped = 0
      const errors: { row_index: number; name: string; reason: string }[] = []

      for (const row of rows) {
        const nk = nameKey(row.name)
        const match =
          (row.article_number ? byNumber.get(row.article_number) : undefined) ??
          (nk ? byName.get(nk) : undefined) ??
          null

        const revenueAccount = await resolveRevenueAccount(row.revenue_account)

        if (match) {
          if (!update_duplicates) {
            skipped++
            continue
          }

          // Merge mode: overwrite only fields the file clearly carries a value
          // for. type/unit/vat_rate carry parser defaults that can't be told
          // apart from "absent", so they are left untouched to avoid clobbering.
          const merged: Record<string, unknown> = {}
          if (row.name) merged.name = row.name
          if (row.name_en) merged.name_en = row.name_en
          if (row.price_excl_vat > 0) merged.price_excl_vat = row.price_excl_vat
          if (row.cost_price !== null) merged.cost_price = row.cost_price
          if (row.ean) merged.ean = row.ean
          if (row.housework_type) merged.housework_type = row.housework_type
          if (row.notes) merged.notes = row.notes
          if (revenueAccount) merged.revenue_account = revenueAccount

          if (Object.keys(merged).length === 0) {
            skipped++
            continue
          }

          const { data, error } = await supabase
            .from('articles')
            .update(merged)
            .eq('id', match.id)
            .eq('company_id', companyId)
            .select()
            .single()

          if (error) {
            errors.push({ row_index: row.row_index, name: row.name, reason: error.message })
            continue
          }
          if (data) updated.push(data as Article)
          continue
        }

        // No match, create.
        const { data, error } = await supabase
          .from('articles')
          .insert({
            user_id: user.id,
            company_id: companyId,
            name: row.name,
            name_en: row.name_en,
            type: row.type,
            unit: row.unit || 'st',
            price_excl_vat: row.price_excl_vat,
            vat_rate: row.vat_rate,
            revenue_account: revenueAccount,
            cost_price: row.cost_price,
            ean: row.ean,
            housework_type: row.housework_type,
            notes: row.notes,
            article_number: row.article_number,
          })
          .select()
          .single()

        if (error) {
          // Unique violation on (company_id, article_number): treat as a soft
          // skip (manual number collided with an existing or in-batch article).
          if (error.code === '23505') {
            skipped++
            continue
          }
          errors.push({ row_index: row.row_index, name: row.name, reason: error.message })
          continue
        }

        if (data) {
          // Auto-number when the file didn't supply one. Non-fatal: an
          // unnumbered article is still usable and can be numbered later.
          if (!data.article_number) {
            try {
              data.article_number = await ensureArticleNumber(supabase, companyId!, data.id)
            } catch (err) {
              opLog.warn('article number assignment failed', err as Error, { articleId: data.id })
            }
          }
          created.push(data as Article)
          // Track newly inserted number + name so later rows in the same batch
          // dedup against them too.
          const newArticle = data as ExistingArticle
          if (newArticle.article_number) byNumber.set(newArticle.article_number, newArticle)
          const nk = nameKey(newArticle.name)
          if (nk && !byName.has(nk)) byName.set(nk, newArticle)
        }
      }

      // Emit events for downstream listeners (non-blocking).
      for (const a of created) {
        await eventBus.emit({
          type: 'article.created',
          payload: { article: a, companyId: companyId!, userId: user.id },
        })
      }

      const response: ArticleImportExecuteResult = {
        success: errors.length === 0,
        created: created.length,
        updated: updated.length,
        skipped,
        failed: errors.length,
        errors,
        warnings,
      }

      opLog.info('article import complete', response)

      return NextResponse.json({ data: response })
    } catch (err) {
      opLog.error('article import execute failed', err as Error)
      return errorResponseFromCode('REG_IMPORT_EXECUTE_FAILED', opLog, {
        requestId,
        details: { reason: err instanceof Error ? err.message : 'unknown' },
      })
    }
  },
  { requireWrite: true },
)
