import { normalizeNameKey as nameKey } from '@/lib/import/shared/column-utils'
import { NextResponse } from 'next/server'
import { eventBus } from '@/lib/events'
import { validateBody } from '@/lib/api/validate'
import { ArticleImportExecuteSchema } from '@/lib/api/schemas'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { withRouteContext } from '@/lib/api/with-route-context'
import { recordRegisterImportRun, snapshotRowsForUndo } from '@/lib/import/register-runs'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { ensureArticleNumber } from '@/lib/articles/ensure-article-number'
import { checkRevenueAccount, type RevenueAccountStatus } from '@/lib/articles/validate-revenue-account'
import type { Article } from '@/types'
import type { ArticleImportExecuteResult } from '@/lib/import/articles/types'
import { makeNotice, type ImportNotice } from '@/lib/import/notices'
import { getErrorMessage as getUserErrorMessage } from '@/lib/errors/get-error-message'

interface ExistingArticle {
  id: string
  name: string
  article_number: string | null
}

/** A new article this batch inserts, with the file row it came from. */
interface PlannedInsert {
  row_index: number
  name: string
  payload: Record<string, unknown>
}

/** The merged fields for one existing article, and the file rows that named it. */
interface PlannedUpdate {
  id: string
  merged: Record<string, unknown>
  rows: { row_index: number; name: string }[]
}

/**
 * The client sends a large file in batches (lib/import/register-import-flow.ts
 * executeBatches); one batch of new articles plus the lookups fits well inside
 * this, as on the bank-file and SIE execute routes.
 */
export const maxDuration = 300

/** New articles per insert statement. */
const ARTICLE_INSERT_SLICE = 500

/** Updates in flight at once: enough to overlap round trips, few enough to spare the pool. */
const UPDATE_CONCURRENCY = 8

async function runWithConcurrency<T>(items: readonly T[], limit: number, work: (item: T) => Promise<void>) {
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const item = items[next++]
      await work(item)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
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
          .order('id')
          .range(from, to),
      )
      const existing = existingRaw as unknown as ExistingArticle[]

      const byNumber = new Map<string, ExistingArticle | { planned: PlannedInsert }>()
      const byName = new Map<string, ExistingArticle | { planned: PlannedInsert }>()
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
      const notices: ImportNotice[] = []

      // Currency codes are validated against the currencies reference table
      // (the same set the articles.currency FK enforces): unknown codes are
      // dropped with a warning instead of failing the row on a FK violation.
      // Loaded lazily: most files carry no Valuta column at all. If the
      // reference read fails, codes pass through and the FK stays the backstop.
      let validCurrencies: Set<string> | null | undefined
      const droppedCurrencies = new Set<string>()
      const resolveCurrency = async (code: string | null | undefined): Promise<string | null> => {
        if (!code) return null
        if (validCurrencies === undefined) {
          const { data: currencyRows } = await supabase.from('currencies').select('code')
          validCurrencies = currencyRows
            ? new Set((currencyRows as { code: string }[]).map((c) => c.code))
            : null
        }
        if (!validCurrencies || validCurrencies.has(code)) return code
        if (!droppedCurrencies.has(code)) {
          droppedCurrencies.add(code)
          warnings.push(`Valutan ${code} stöds inte, ignorerades: priset importerades som SEK.`)
          notices.push(makeNotice('articles_currency_unsupported', 'notice', { code }))
        }
        return null
      }
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
          notices.push(
            status === 'activatable'
              ? makeNotice('articles_account_inactive', 'action', { account: acc })
              : makeNotice('articles_account_invalid', 'notice', { account: acc })
          )
        }
        return null
      }

      // Plan the batch in memory first, then write it set-based: one insert
      // statement per ARTICLE_INSERT_SLICE new articles and a few updates in
      // flight at once. Row-at-a-time writes made a supplier price list
      // (crm#1383) take one database round trip per row.
      const inserts: PlannedInsert[] = []
      const updates = new Map<string, PlannedUpdate>()
      let skipped = 0
      let updatedCount = 0
      const errors: { row_index: number; name: string; reason: string }[] = []

      for (const row of rows) {
        const nk = nameKey(row.name)
        const match =
          (row.article_number ? byNumber.get(row.article_number) : undefined) ??
          (nk ? byName.get(nk) : undefined) ??
          null

        const revenueAccount = await resolveRevenueAccount(row.revenue_account)
        const currency = await resolveCurrency(row.currency)

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
          // Only when the file explicitly carries a valid currency: absence
          // must never reset an existing non-SEK article to SEK.
          if (currency) merged.currency = currency

          if (Object.keys(merged).length === 0) {
            skipped++
            continue
          }

          if ('planned' in match) {
            // A second row for an article this batch creates: the later row's
            // values go into the same insert, as the update after it did.
            Object.assign(match.planned.payload, merged)
            updatedCount++
            continue
          }

          // Rows naming the same existing article become one update (later
          // values win), so parallel updates never race on one row.
          const planned = updates.get(match.id)
          if (planned) {
            Object.assign(planned.merged, merged)
            planned.rows.push({ row_index: row.row_index, name: row.name })
          } else {
            updates.set(match.id, { id: match.id, merged, rows: [{ row_index: row.row_index, name: row.name }] })
          }
          continue
        }

        // No match, create.
        const planned: PlannedInsert = {
          row_index: row.row_index,
          name: row.name,
          payload: {
            user_id: user.id,
            company_id: companyId,
            name: row.name,
            name_en: row.name_en,
            type: row.type,
            unit: row.unit || 'st',
            price_excl_vat: row.price_excl_vat,
            currency: currency ?? 'SEK',
            vat_rate: row.vat_rate,
            revenue_account: revenueAccount,
            cost_price: row.cost_price,
            ean: row.ean,
            housework_type: row.housework_type,
            notes: row.notes,
            article_number: row.article_number,
          },
        }
        inserts.push(planned)
        // Later rows in the same batch dedup against the planned article too.
        if (row.article_number) byNumber.set(row.article_number, { planned })
        if (nk && !byName.has(nk)) byName.set(nk, { planned })
      }

      // The full rows this batch updates, read before it writes, so the undo
      // can put back what it changed.
      const beforeImport = await snapshotRowsForUndo(
        supabase,
        companyId,
        'articles',
        update_duplicates,
        [...updates.keys()],
      )

      const created: Article[] = []
      const insertOne = async (planned: PlannedInsert) => {
        const { data, error } = await supabase.from('articles').insert(planned.payload).select().single()
        if (error) {
          // Unique violation on (company_id, article_number): treat as a soft
          // skip (manual number collided with an existing or in-batch article).
          if (error.code === '23505') {
            skipped++
            return
          }
          errors.push({ row_index: planned.row_index, name: planned.name, reason: getUserErrorMessage(error) })
          return
        }
        if (data) created.push(data as Article)
      }
      for (let i = 0; i < inserts.length; i += ARTICLE_INSERT_SLICE) {
        const slice = inserts.slice(i, i + ARTICLE_INSERT_SLICE)
        const { data, error } = await supabase
          .from('articles')
          .insert(slice.map((p) => p.payload))
          .select()
        if (!error && Array.isArray(data)) {
          created.push(...(data as Article[]))
          continue
        }
        // One statement is all or nothing: a row that fails (a number taken
        // since the read, a bad value) is found by writing the slice row by row.
        for (const planned of slice) await insertOne(planned)
      }

      // Auto-number articles the file gave no number. Non-fatal: an unnumbered
      // article is still usable and can be numbered later.
      for (const article of created) {
        if (article.article_number) continue
        try {
          article.article_number = await ensureArticleNumber(supabase, companyId!, article.id)
        } catch (err) {
          opLog.warn('article number assignment failed', err as Error, { articleId: article.id })
        }
      }

      const updated: Article[] = []
      await runWithConcurrency([...updates.values()], UPDATE_CONCURRENCY, async (planned) => {
        const { data, error } = await supabase
          .from('articles')
          .update(planned.merged)
          .eq('id', planned.id)
          .eq('company_id', companyId)
          .select()
          .single()
        if (error) {
          const reason = getUserErrorMessage(error)
          for (const r of planned.rows) errors.push({ row_index: r.row_index, name: r.name, reason })
          return
        }
        if (data) {
          updated.push(data as Article)
          updatedCount += planned.rows.length
        }
      })
      errors.sort((a, b) => a.row_index - b.row_index)

      // Emit events for downstream listeners (non-blocking).
      for (const a of created) {
        await eventBus.emit({
          type: 'article.created',
          payload: { article: a, companyId: companyId!, userId: user.id },
        })
      }

      await recordRegisterImportRun(supabase, { companyId, userId: user.id, kind: 'articles', created, updated, before: beforeImport }, opLog)

      const response: ArticleImportExecuteResult = {
        success: errors.length === 0,
        created: created.length,
        updated: updatedCount,
        skipped,
        failed: errors.length,
        errors,
        warnings,
        notices,
      }

      opLog.info('article import complete', response)

      return NextResponse.json({ data: response })
    } catch (err) {
      opLog.error('article import execute failed', err as Error)
      return errorResponseFromCode('REG_IMPORT_EXECUTE_FAILED', opLog, {
        requestId,
        details: { reason: err instanceof Error ? getUserErrorMessage(err) : 'unknown' },
      })
    }
  },
  { requireWrite: true },
)
