import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { buildPosDayEntry } from '@/lib/pos-sales/evaluate'
import { posDayReportFilename, renderPosDayReport } from '@/lib/pos-sales/day-report-pdf'
import { resolvePosSalesSettings } from '@/lib/pos-sales/settings'
import { normalizeDaySummary, type PosSalesDayRow } from '@/lib/pos-sales/types'
import type { CreateJournalEntryLineInput } from '@/types'

/**
 * The day report (Dagsrapport kassa) as a PDF, rendered on demand: the
 * booked voucher's own lines once the day is booked, the proposal before.
 * The copy archived on the verifikat at booking is the underlag; this is the
 * view of it, and of an unbooked day, for review.
 */
export const GET = withRouteContext<{ params: Promise<{ id: string }> }>(
  'pos_sales.day.report',
  async (_request, ctx, { params }) => {
    const { supabase, companyId, log, requestId } = ctx
    const { id } = await params

    const { data } = await supabase
      .from('pos_sales_days')
      .select(
        'id, company_id, connection_id, business_date, currency, status, review_reasons, gross, net, vat, tips, receipt_count, tenders, vat_groups, raw_sha256, fetched_at, fetch_count, changed_after_booking, latest_raw_sha256, latest_fetched_at, journal_entry_id, booked_at, booked_by, created_at, updated_at, day',
      )
      .eq('id', id)
      .eq('company_id', companyId!)
      .maybeSingle()
    if (!data) return errorResponseFromCode('POS_DAY_NOT_FOUND', log, { requestId })
    const day = normalizeDaySummary(data as unknown as PosSalesDayRow)

    const { data: connection } = await supabase
      .from('pos_connections')
      .select('venue_name, provider_name, settings')
      .eq('id', day.connection_id)
      .eq('company_id', companyId!)
      .maybeSingle()
    if (!connection) return errorResponseFromCode('POS_DAY_NOT_FOUND', log, { requestId })
    const conn = connection as { venue_name: string; provider_name: string; settings: unknown }

    let lines: CreateJournalEntryLineInput[] | null = null
    let voucherLabel: string | null = null
    if (day.journal_entry_id) {
      const { data: entry } = await supabase
        .from('journal_entries')
        .select('voucher_series, voucher_number, journal_entry_lines(account_number, debit_amount, credit_amount, line_description, sort_order)')
        .eq('id', day.journal_entry_id)
        .eq('company_id', companyId!)
        .maybeSingle()
      const booked = entry as {
        voucher_series: string | null
        voucher_number: number | null
        journal_entry_lines: Array<{ account_number: string; debit_amount: number; credit_amount: number; line_description: string | null; sort_order: number | null }>
      } | null
      if (booked) {
        voucherLabel = booked.voucher_series && booked.voucher_number ? `${booked.voucher_series}${booked.voucher_number}` : null
        lines = [...(booked.journal_entry_lines ?? [])]
          .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))
          .map((l) => ({
            account_number: l.account_number,
            debit_amount: Number(l.debit_amount) || 0,
            credit_amount: Number(l.credit_amount) || 0,
            ...(l.line_description ? { line_description: l.line_description } : {}),
          }))
      }
    } else {
      const proposal = buildPosDayEntry(day.day, resolvePosSalesSettings(conn.settings))
      lines = proposal.problems.length === 0 ? proposal.lines : null
    }

    const { data: settings } = await supabase
      .from('company_settings')
      .select('company_name, org_number')
      .eq('company_id', companyId!)
      .maybeSingle()
    const company = (settings ?? {}) as { company_name?: string | null; org_number?: string | null }

    const pdf = await renderPosDayReport({
      day: day.day,
      venueName: conn.venue_name,
      providerName: conn.provider_name,
      companyName: company.company_name ?? null,
      orgNumber: company.org_number ?? null,
      fetchedAt: day.fetched_at,
      rawSha256: day.raw_sha256,
      lines,
      voucherLabel,
      generatedAt: new Date().toISOString().slice(0, 10),
    })
    const filename = posDayReportFilename(day.day, conn.venue_name)
    return new Response(new Uint8Array(pdf), {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `inline; filename="${filename.replace(/[^\x20-\x7e]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
        'Cache-Control': 'private, no-store',
      },
    })
  },
)
