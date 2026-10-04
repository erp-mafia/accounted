import { createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { checkPeriodLock } from '@/lib/api/v1/check-period-lock'
import { commitEntry, createDraftEntry, findFiscalPeriod } from '@/lib/bookkeeping/engine'
import { toEntryPreview } from '@/lib/bookkeeping/entry-preview'
import { BookkeepingDatabaseError, isBookkeepingError } from '@/lib/bookkeeping/errors'
import { uploadDocument } from '@/lib/core/documents/document-service'
import type { OperationContext, OperationOutcome } from '@/lib/operations/types'
import type { CreateJournalEntryInput, JournalEntry } from '@/types'
import { posDayReportFilename, renderPosDayReport } from './day-report-pdf'
import { buildPosDayEntry, evaluatePosDay, posDayDescription } from './evaluate'
import { resolvePosSalesSettings } from './settings'
import { normalizeDaySummary, type PosConnectionRow, type PosSalesDayRow } from './types'

/**
 * Book one point-of-sale day as its daily takings voucher (source_type
 * pos_daily_sales), with the day report archived on it as underlag.
 *
 * Race-free the same way as webshop orders (lib/webshop-orders/book-order.ts):
 * draft -> conditional claim of the day row -> commit. The claim also pins
 * the archived answer's hash, so a fetch that replaced the day between the
 * read and the claim makes the booking lose instead of posting what the
 * person did not see; the loser's draft is cancelled before it gets a voucher
 * number. A DB index allows one live voucher per day on top of that.
 */

export interface BookPosDayInput {
  day_id: string
  /** Book although the provider reported issues; the person read the report. Never overrides a missing account. */
  acknowledge_issues?: boolean
  /** raw_sha256 of the day the person reviewed; the booking is refused if the day changed since. */
  expected_raw_sha256?: string
}

export interface BookPosDayResult {
  journal_entry_id: string
  voucher_series: string | null
  voucher_number: number | null
  entry_date: string
  business_date: string
  gross: number
  underlag_document_id: string | null
}

async function loadDayAndConnection(
  ctx: OperationContext,
  dayId: string,
): Promise<{ day: PosSalesDayRow; connection: PosConnectionRow } | null> {
  const { data: day } = await ctx.supabase
    .from('pos_sales_days')
    .select(
      'id, company_id, connection_id, business_date, currency, status, review_reasons, gross, net, vat, tips, receipt_count, tenders, vat_groups, raw_sha256, fetched_at, fetch_count, changed_after_booking, latest_raw_sha256, latest_fetched_at, journal_entry_id, booked_at, booked_by, created_at, updated_at, day',
    )
    .eq('id', dayId)
    .eq('company_id', ctx.companyId)
    .maybeSingle()
  if (!day) return null
  const { data: connection } = await ctx.supabase
    .from('pos_connections')
    .select('id, company_id, provider, provider_name, venue_ref, venue_name, settings, status')
    .eq('id', (day as { connection_id: string }).connection_id)
    .eq('company_id', ctx.companyId)
    .maybeSingle()
  if (!connection) return null
  return {
    day: normalizeDaySummary(day as unknown as PosSalesDayRow),
    connection: connection as unknown as PosConnectionRow,
  }
}

/** Archive the day report on the committed verifikat. Never throws: a missing underlag surfaces on the worklist. */
async function archiveDayReport(
  ctx: OperationContext,
  args: { day: PosSalesDayRow; connection: PosConnectionRow; entry: JournalEntry | null; entryId: string; input: CreateJournalEntryInput },
): Promise<string | null> {
  try {
    const { data: settings } = await ctx.supabase
      .from('company_settings')
      .select('company_name, org_number')
      .eq('company_id', ctx.companyId)
      .maybeSingle()
    const company = (settings ?? {}) as { company_name?: string | null; org_number?: string | null }
    const voucherLabel = args.entry?.voucher_series && args.entry.voucher_number
      ? `${args.entry.voucher_series}${args.entry.voucher_number}`
      : null
    const pdf = await renderPosDayReport({
      day: args.day.day,
      venueName: args.connection.venue_name,
      providerName: args.connection.provider_name,
      companyName: company.company_name ?? null,
      orgNumber: company.org_number ?? null,
      fetchedAt: args.day.fetched_at,
      rawSha256: args.day.raw_sha256,
      lines: args.input.lines,
      voucherLabel,
      generatedAt: new Date().toISOString().slice(0, 10),
    })
    const document = await uploadDocument(
      ctx.supabase,
      ctx.userId,
      ctx.companyId,
      {
        name: posDayReportFilename(args.day.day, args.connection.venue_name),
        buffer: new Uint8Array(pdf).buffer as ArrayBuffer,
        type: 'application/pdf',
      },
      { upload_source: 'system', journal_entry_id: args.entryId, extractionOwner: 'none' },
    )
    return document.id
  } catch (err) {
    ctx.log.error('failed to archive the pos day report', err as Error, { dayId: args.day.id, journalEntryId: args.entryId })
    return null
  }
}

export async function bookPosSalesDay(
  ctx: OperationContext,
  input: BookPosDayInput,
  options: { dryRun?: boolean } = {},
): Promise<OperationOutcome<BookPosDayResult>> {
  const { supabase, companyId, userId, log } = ctx
  const loaded = await loadDayAndConnection(ctx, input.day_id)
  if (!loaded) return { ok: false, code: 'POS_DAY_NOT_FOUND', details: { day_id: input.day_id } }
  const { day, connection } = loaded

  if (day.journal_entry_id) {
    return { ok: false, code: 'POS_DAY_ALREADY_BOOKED', details: { journal_entry_id: day.journal_entry_id } }
  }
  if (input.expected_raw_sha256 && input.expected_raw_sha256 !== day.raw_sha256) {
    return { ok: false, code: 'POS_DAY_CHANGED', details: { raw_sha256: day.raw_sha256 } }
  }

  const settings = resolvePosSalesSettings(connection.settings)
  const evaluation = evaluatePosDay(day.day, settings)
  if (evaluation.status === 'empty') return { ok: false, code: 'POS_DAY_EMPTY', details: { business_date: day.business_date } }
  if (evaluation.status === 'needs_review' && !(evaluation.acknowledgeable && input.acknowledge_issues)) {
    return {
      ok: false,
      code: 'POS_DAY_NEEDS_REVIEW',
      details: { reasons: evaluation.reasons, acknowledgeable: evaluation.acknowledgeable },
    }
  }
  const entry = buildPosDayEntry(day.day, settings)
  if (entry.problems.length > 0) {
    return { ok: false, code: 'POS_DAY_NEEDS_REVIEW', details: { reasons: entry.problems, acknowledgeable: false } }
  }

  const verdict = await checkPeriodLock(supabase, companyId, day.business_date)
  if (verdict.locked) {
    return { ok: false, code: 'PERIOD_LOCKED', details: { reason: verdict.reason, entry_date: day.business_date } }
  }
  const fiscalPeriodId = await findFiscalPeriod(supabase, companyId, day.business_date)
  if (!fiscalPeriodId) return { ok: false, code: 'POS_DAY_NO_FISCAL_PERIOD', details: { entry_date: day.business_date } }

  const entryInput: CreateJournalEntryInput = {
    fiscal_period_id: fiscalPeriodId,
    entry_date: day.business_date,
    description: posDayDescription(day.day, connection.venue_name, connection.provider_name),
    source_type: 'pos_daily_sales',
    source_id: day.id,
    notes: day.day.firstReceiptNumber
      ? `Kvitto ${day.day.firstReceiptNumber}-${day.day.lastReceiptNumber}, ${day.day.receiptCount} st. Underlag: dagsrapport kassa.`
      : 'Underlag: dagsrapport kassa.',
    lines: entry.lines,
  }

  if (options.dryRun) {
    return {
      ok: true,
      dryRun: true,
      preview: {
        day_id: day.id,
        business_date: day.business_date,
        venue_name: connection.venue_name,
        provider_name: connection.provider_name,
        raw_sha256: day.raw_sha256,
        acknowledged_issues: evaluation.status === 'needs_review' ? evaluation.reasons : [],
        journal_entry: toEntryPreview(entryInput),
      },
    }
  }

  let draft: JournalEntry
  try {
    draft = await createDraftEntry(supabase, companyId, userId, entryInput)
  } catch (err) {
    // The live-voucher index: another booking of this day holds a draft or a posted voucher.
    if (err instanceof BookkeepingDatabaseError && err.pgCode === '23505') {
      return { ok: false, code: 'POS_DAY_ALREADY_BOOKED', details: { day_id: day.id } }
    }
    if (isBookkeepingError(err)) return { ok: false, code: 'POS_DAY_BOOKING_FAILED', error: err }
    log.error('pos day draft failed', err as Error, { dayId: day.id })
    return { ok: false, code: 'POS_DAY_BOOKING_FAILED' }
  }

  const admin = createServiceClientNoCookies()
  const cancelDraft = async () => {
    const { error } = await supabase.from('journal_entries').update({ status: 'cancelled' }).eq('id', draft.id).eq('status', 'draft')
    if (error) log.error('pos day draft cleanup failed', error, { entryId: draft.id })
  }

  const { data: claimed, error: claimError } = await admin
    .from('pos_sales_days')
    .update({ journal_entry_id: draft.id })
    .eq('id', day.id)
    .eq('company_id', companyId)
    .is('journal_entry_id', null)
    .eq('raw_sha256', day.raw_sha256)
    .select('id')
  if (claimError || !claimed || claimed.length === 0) {
    await cancelDraft()
    if (claimError) {
      log.error('pos day claim failed', claimError, { dayId: day.id })
      return { ok: false, code: 'POS_DAY_BOOKING_FAILED' }
    }
    // Booked by someone else, or replaced by a newer fetch, since our read.
    const { data: now } = await admin.from('pos_sales_days').select('journal_entry_id, raw_sha256').eq('id', day.id).maybeSingle()
    const current = now as { journal_entry_id: string | null; raw_sha256: string } | null
    if (current?.journal_entry_id) {
      return { ok: false, code: 'POS_DAY_ALREADY_BOOKED', details: { journal_entry_id: current.journal_entry_id } }
    }
    return { ok: false, code: 'POS_DAY_CHANGED', details: { raw_sha256: current?.raw_sha256 ?? null } }
  }

  let committed: JournalEntry | null
  try {
    committed = await commitEntry(supabase, companyId, userId, draft.id)
  } catch (err) {
    // A commit whose answer was lost may still have posted: a posted voucher
    // keeps its link (the freeze trigger refuses the unlink anyway) and the
    // day is marked booked below.
    const { data: landed } = await admin
      .from('journal_entries')
      .select('id, status, voucher_series, voucher_number')
      .eq('id', draft.id)
      .maybeSingle()
    if ((landed as { status?: string } | null)?.status === 'posted') {
      log.warn('pos day commit answered an error but the voucher is posted', { dayId: day.id, entryId: draft.id })
      committed = landed as JournalEntry
    } else {
      await admin.from('pos_sales_days').update({ journal_entry_id: null }).eq('id', day.id).eq('journal_entry_id', draft.id)
      await cancelDraft()
      if (isBookkeepingError(err)) return { ok: false, code: 'POS_DAY_BOOKING_FAILED', error: err }
      log.error('pos day commit failed', err as Error, { dayId: day.id, entryId: draft.id })
      return { ok: false, code: 'POS_DAY_BOOKING_FAILED' }
    }
  }

  const entryId = committed?.id ?? draft.id
  const bookedAt = new Date().toISOString()
  const { error: markError } = await admin
    .from('pos_sales_days')
    .update({ status: 'booked', booked_at: bookedAt, booked_by: userId, review_reasons: [] })
    .eq('id', day.id)
    .eq('journal_entry_id', entryId)
  if (markError) log.error('pos day booked mark failed; the voucher link stands', markError, { dayId: day.id, entryId })

  const underlagId = await archiveDayReport(ctx, { day, connection, entry: committed, entryId, input: entryInput })

  return {
    ok: true,
    created: true,
    data: {
      journal_entry_id: entryId,
      voucher_series: committed?.voucher_series ?? null,
      voucher_number: committed?.voucher_number ?? null,
      entry_date: day.business_date,
      business_date: day.business_date,
      gross: day.gross,
      underlag_document_id: underlagId,
    },
    ...(underlagId
      ? {}
      : {
          warnings: [
            {
              code: 'POS_DAY_UNDERLAG_NOT_ARCHIVED',
              message_sv: 'Verifikatet bokfördes men dagsrapporten kunde inte arkiveras. Bifoga den från Kassarapporter.',
              message_en: 'The voucher was booked but the day report could not be archived. Attach it from the daily sales reports.',
            },
          ],
        }),
  }
}
