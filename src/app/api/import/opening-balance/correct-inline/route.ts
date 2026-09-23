import { NextResponse } from 'next/server'
import { ensureInitialized } from '@/lib/init'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { OpeningBalanceCorrectInlineSchema } from '@/lib/api/schemas'
import { backfillStandardBASAccounts } from '@/lib/bookkeeping/account-backfill'
import {
  cascadeOpeningBalanceCorrection,
  computeAccountDeltas,
  type CascadeResult,
} from '@/lib/import/opening-balance/cascade'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { getErrorMessage as getUserErrorMessage } from '@/lib/errors/get-error-message'

ensureInitialized()

/**
 * POST /api/import/opening-balance/correct-inline
 *
 * Fortnox-style IB correction: strike changed lines and add replacements
 * inside the SAME IB verifikat (BFL 5 kap 5 § track 2, rättelse in the same
 * bokföringspost), via the correct_entry_lines_inline RPC. No storno, no new
 * verifikat; the struck originals live on in journal_entry_rattelse_log and
 * fiscal_periods.opening_balance_entry_id never changes.
 *
 * Only for open, unlocked years without a bokslut: the pre-flights below
 * return the same OB_* codes as the storno-based /correct route (so the
 * dialog's blocked-year guidance applies), and the RPC re-enforces the whole
 * envelope transactionally.
 *
 * With `cascade: true` the per-account delta (added minus struck) is appended
 * as labelled adjustment lines inside each subsequent year's own IB verifikat
 * (cascade mode 'inline'): a multi-year correction with zero new verifikat.
 * Locked/closed/bokslut years are skipped and reported, never forced.
 */
export const POST = withRouteContext(
  'opening_balance.correct_inline',
  async (request, ctx) => {
    const { user, supabase, companyId, log, requestId } = ctx

    const result = await validateBody(request, OpeningBalanceCorrectInlineSchema, {
      log,
      operation: 'opening_balance.correct_inline',
    })
    if (!result.success) return result.response

    const { fiscal_period_id, strike_line_ids, new_lines, cascade } = result.data
    const opLog = log.child({ fiscalPeriodId: fiscal_period_id })

    // Pre-flights mirror the storno-based /correct route (same OB_* codes so
    // the client guidance is uniform). The RPC re-checks everything inside
    // its transaction: these exist to give structured, actionable errors.
    const { data: period, error: periodError } = await supabase
      .from('fiscal_periods')
      .select('id, period_start, is_closed, locked_at, opening_balances_set, opening_balance_entry_id')
      .eq('id', fiscal_period_id)
      .eq('company_id', companyId)
      .single()

    if (periodError || !period) {
      return errorResponseFromCode('OB_PERIOD_NOT_FOUND', opLog, { requestId })
    }
    if (period.is_closed) {
      return errorResponseFromCode('OB_PERIOD_CLOSED', opLog, { requestId })
    }
    if (period.locked_at) {
      return errorResponseFromCode('OB_PERIOD_LOCKED', opLog, { requestId })
    }

    const { data: settings } = await supabase
      .from('company_settings')
      .select('bookkeeping_locked_through')
      .eq('company_id', companyId)
      .maybeSingle()

    const lockDate = settings?.bookkeeping_locked_through as string | null
    if (lockDate && period.period_start <= lockDate) {
      return errorResponseFromCode('OB_COMPANY_LOCK_DATE', opLog, {
        requestId,
        details: { lockDate, entryDate: period.period_start },
      })
    }

    if (!period.opening_balances_set || !period.opening_balance_entry_id) {
      return errorResponseFromCode('OB_CORRECT_NO_EXISTING', opLog, { requestId })
    }

    const { count: yearEndCount } = await supabase
      .from('journal_entries')
      .select('id', { count: 'exact', head: true })
      .eq('company_id', companyId)
      .eq('fiscal_period_id', fiscal_period_id)
      .eq('source_type', 'year_end')
      .eq('status', 'posted')

    if ((yearEndCount ?? 0) > 0) {
      return errorResponseFromCode('OB_CORRECT_YEAR_END_EXISTS', opLog, { requestId })
    }

    const entryId = period.opening_balance_entry_id

    // Seed standard BAS accounts the replacement lines reference but the
    // chart lacks (same courtesy as the storno flow); unknown numbers fail
    // the RPC's chart check with a clear error.
    const accountNumbers = [...new Set(new_lines.map((l) => l.account_number))]
    if (accountNumbers.length > 0) {
      await backfillStandardBASAccounts(supabase, companyId!, user.id, accountNumbers)
    }

    const { data: rpcData, error: rpcError } = await supabase.rpc('correct_entry_lines_inline', {
      p_company_id: companyId,
      p_entry_id: entryId,
      p_strike_line_ids: strike_line_ids,
      p_new_lines: new_lines.map((l) => ({
        account_number: l.account_number,
        debit_amount: l.debit_amount,
        credit_amount: l.credit_amount,
        line_description: l.line_description ?? null,
        dimensions: l.dimensions ?? {},
      })),
      p_user_id: user.id,
    })

    if (rpcError) {
      // Rule violations are plain RAISE EXCEPTION (P0001) with user-facing
      // Swedish messages: surface verbatim (same approach as the generic
      // strike-lines route). Tenant guard raises 42501.
      if (rpcError.code === 'P0001') {
        return NextResponse.json(
          {
            error: {
              code: 'OB_INLINE_REFUSED',
              message: getUserErrorMessage(rpcError, { locale: 'sv' }),
              message_en: getUserErrorMessage(rpcError, { locale: 'en' }),
              requestId,
            },
          },
          { status: 409 },
        )
      }
      if (rpcError.code === '42501') {
        return NextResponse.json(
          { error: { code: 'FORBIDDEN', message: getUserErrorMessage(rpcError), requestId } },
          { status: 403 },
        )
      }
      opLog.error('correct_entry_lines_inline failed for IB', new Error(rpcError.message), { entryId })
      return errorResponseFromCode('OB_CORRECT_FAILED', opLog, {
        requestId,
        details: { reason: getUserErrorMessage(rpcError) },
      })
    }

    // Base rättelse committed. Cascade is best-effort on top, one inline
    // rättelse per later year; a failure there never errors this request.
    //
    // The delta comes from the RPC's OWN rättelse-log row (struck_lines /
    // added_lines snapshotted inside the RPC transaction), never from a
    // pre-RPC read: a concurrent edit between a route-side snapshot and the
    // RPC could otherwise cascade a delta that no longer matches what was
    // actually committed to the base year.
    let cascadeResult: CascadeResult | null = null
    if (cascade) {
      try {
        const logId = (rpcData as { log_id?: string } | null)?.log_id
        const { data: logRow, error: logError } = await supabase
          .from('journal_entry_rattelse_log')
          .select('struck_lines, added_lines')
          .eq('id', logId)
          .eq('company_id', companyId)
          .single()
        if (logError || !logRow) {
          throw new Error(`rättelse log fetch failed: ${logError?.message ?? 'not found'}`)
        }

        const toLines = (raw: unknown) =>
          ((raw ?? []) as Array<{ account_number: string; debit_amount: number | string; credit_amount: number | string }>).map(
            (l) => ({
              account_number: l.account_number,
              debit_amount: Number(l.debit_amount) || 0,
              credit_amount: Number(l.credit_amount) || 0,
            }),
          )

        const deltas = computeAccountDeltas(toLines(logRow.struck_lines), toLines(logRow.added_lines))
        cascadeResult = await cascadeOpeningBalanceCorrection(supabase, companyId!, user.id, {
          basePeriodStart: period.period_start,
          deltas,
          lockDate,
          mode: 'inline',
          log: opLog,
        })
      } catch (cascadeErr) {
        opLog.error('inline opening balance cascade failed', cascadeErr as Error)
        cascadeResult = { corrected: [], skipped: [], failed: true }
      }
    }

    return NextResponse.json({
      data: {
        success: true,
        journal_entry_id: entryId,
        rattelse: rpcData,
        ...(cascadeResult ? { cascade: cascadeResult } : {}),
      },
    })
  },
  { requireWrite: true },
)
