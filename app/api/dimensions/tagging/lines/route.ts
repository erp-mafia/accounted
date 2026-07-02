/**
 * GET /api/dimensions/tagging/lines — posted journal-entry lines for the bulk
 * retro-tagging workbench (dimensions plan PR6 §3).
 *
 * Read-only line browser: filter by period, entry-date range, account range,
 * free text (ilike on the entry description) and "only untagged" (empty
 * dimensions map). Hard cap instead of pagination for v1 — the route fetches
 * limit+1 rows and reports `total_capped: true` so the UI can show a
 * "narrow your filter" notice.
 *
 * Response: 200 { data: { lines: [...], total_capped: boolean } } where each
 * line is flattened ({ id, account_number, debit_amount, credit_amount,
 * dimensions, journal_entry_id, entry_date, voucher_number, voucher_series,
 * description, reversed_by_id, reverses_id, fiscal_period_id }). The reversal
 * linkage rides along so the workbench can warn about storno pairs.
 */
import { NextResponse } from 'next/server'
import { ensureInitialized } from '@/lib/init'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateQuery } from '@/lib/api/validate'
import { DimensionTaggingLinesQuerySchema } from '@/lib/api/schemas'
import { errorResponse } from '@/lib/errors/get-structured-error'
import { escapeLikePattern } from '@/lib/invoices/duplicate-payment-guard'

ensureInitialized()

interface RawTaggingLine {
  id: string
  account_number: string
  debit_amount: number
  credit_amount: number
  dimensions: Record<string, string> | null
  journal_entry_id: string
  // Supabase types !inner joins as arrays; for many-to-one (line → entry) it
  // returns a single object at runtime (same caveat as lib/reports/general-ledger.ts).
  journal_entries: {
    entry_date: string
    voucher_number: number | null
    voucher_series: string | null
    description: string
    reversed_by_id: string | null
    reverses_id: string | null
    fiscal_period_id: string
  }
}

export const GET = withRouteContext(
  'dimensions.tagging.lines',
  async (request, ctx) => {
    const { supabase, companyId, log, requestId } = ctx

    const validation = validateQuery(request, DimensionTaggingLinesQuerySchema, {
      log,
      operation: 'dimensions.tagging.lines',
    })
    if (!validation.success) return validation.response
    const q = validation.data

    let query = supabase
      .from('journal_entry_lines')
      .select(
        'id, account_number, debit_amount, credit_amount, dimensions, journal_entry_id, journal_entries!inner(entry_date, voucher_number, voucher_series, description, reversed_by_id, reverses_id, fiscal_period_id, company_id, status)',
      )
      .eq('journal_entries.company_id', companyId)
      // Posted only — drafts are edited directly in the voucher editor and the
      // retag RPC rejects them anyway.
      .eq('journal_entries.status', 'posted')

    if (q.period_id) query = query.eq('journal_entries.fiscal_period_id', q.period_id)
    if (q.date_from) query = query.gte('journal_entries.entry_date', q.date_from)
    if (q.date_to) query = query.lte('journal_entries.entry_date', q.date_to)
    if (q.account_from) query = query.gte('account_number', q.account_from)
    if (q.account_to) query = query.lte('account_number', q.account_to)
    if (q.text) {
      // Escape LIKE wildcards (\ % _) so they match literally — same posture
      // as the journal-entries list route.
      query = query.ilike('journal_entries.description', `%${escapeLikePattern(q.text)}%`)
    }
    if (q.only_untagged === '1') {
      // dimensions is NOT NULL DEFAULT '{}' (substrate migration), so the
      // empty-map equality is the complete "untagged" predicate.
      query = query.eq('dimensions', '{}')
    }

    // Deterministic order on the line PK; fetch one row past the cap so the
    // response can say "there is more" without a count query.
    const { data, error } = await query
      .order('id', { ascending: true })
      .limit(q.limit + 1)

    if (error) {
      log.error('tagging line browse failed', error)
      return errorResponse(error, log, { requestId })
    }

    const raw = (data ?? []) as unknown as RawTaggingLine[]
    const totalCapped = raw.length > q.limit
    const page = totalCapped ? raw.slice(0, q.limit) : raw

    const lines = page
      .map((l) => ({
        id: l.id,
        account_number: l.account_number,
        debit_amount: l.debit_amount,
        credit_amount: l.credit_amount,
        dimensions: l.dimensions ?? {},
        journal_entry_id: l.journal_entry_id,
        entry_date: l.journal_entries.entry_date,
        voucher_number: l.journal_entries.voucher_number,
        voucher_series: l.journal_entries.voucher_series,
        description: l.journal_entries.description,
        reversed_by_id: l.journal_entries.reversed_by_id,
        reverses_id: l.journal_entries.reverses_id,
        fiscal_period_id: l.journal_entries.fiscal_period_id,
      }))
      // Presentation order: date, then voucher, then line id. Sorting happens
      // after the cap (the cap follows insertion-ordered PKs) — acceptable for
      // the v1 hard-cap contract; the UI shows a narrow-your-filter notice.
      .sort(
        (a, b) =>
          a.entry_date.localeCompare(b.entry_date) ||
          (a.voucher_series ?? '').localeCompare(b.voucher_series ?? '') ||
          (a.voucher_number ?? 0) - (b.voucher_number ?? 0) ||
          a.id.localeCompare(b.id),
      )

    return NextResponse.json({ data: { lines, total_capped: totalCapped } })
  },
)
