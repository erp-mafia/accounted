import { NextResponse } from 'next/server'
import { ensureInitialized } from '@/lib/init'
import { validateBody } from '@/lib/api/validate'
import { OpeningBalanceExecuteSchema } from '@/lib/api/schemas'
import { createJournalEntry, reverseEntry } from '@/lib/bookkeeping/engine'
import { isBookkeepingError } from '@/lib/bookkeeping/errors'
import {
  validateOpeningBalanceLines,
  activateMissingAccounts,
  buildOpeningBalanceEntryLines,
} from '@/lib/import/opening-balance/execute-helpers'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponse, errorResponseFromCode } from '@/lib/errors/get-structured-error'

ensureInitialized()

/**
 * POST /api/import/opening-balance/correct
 *
 * Correct a period's existing opening balances the BFL-compliant way: the
 * current IB verifikat (immutable, posted) is stornoed and a corrected IB is
 * booked, then fiscal_periods.opening_balance_entry_id is relinked to the new
 * entry via the replace_period_opening_balance_link RPC.
 *
 * Because getOpeningBalances reads the linked entry directly and the
 * trial-balance / general-ledger movement queries include both `posted` and
 * `reversed` lines (excluding only the linked OB entry), the stornoed old IB
 * and its storno mirror cancel out in period movement, so the Balansrapport
 * IB column shows the corrected figures and UB stays correct.
 *
 * Gated to the safe case only: the period must be open, unlocked, already have
 * opening balances, and have no year-end close on top. Locked/closed periods or
 * periods with a bokslut must be unwound first (assisted): we refuse here.
 */
export const POST = withRouteContext(
  'opening_balance.correct',
  async (request, ctx) => {
    const { user, supabase, companyId, log, requestId } = ctx

    const result = await validateBody(request, OpeningBalanceExecuteSchema, {
      log,
      operation: 'opening_balance.correct',
    })
    if (!result.success) return result.response

    const { fiscal_period_id, lines } = result.data
    const opLog = log.child({ fiscalPeriodId: fiscal_period_id })

    try {
      // 1. Verify the fiscal period belongs to the company and is correctable.
      //    Write-role (non-viewer) + company membership are already enforced by
      //    withRouteContext({ requireWrite: true }) before this handler runs
      //    (requireWritePermission + getActiveCompanyId), and this fetch is scoped
      //    by that verified companyId: no redundant authz here (ASVS V8.2.1).
      //    The embedded opening_balance_entry pulls the original IB verifikat's
      //    voucher label so the corrected entry can reference it (BFL 5 kap 5§).
      const { data: period, error: periodError } = await supabase
        .from('fiscal_periods')
        .select(
          '*, opening_balance_entry:journal_entries!opening_balance_entry_id(voucher_series, voucher_number)',
        )
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

      if (!period.opening_balances_set || !period.opening_balance_entry_id) {
        return errorResponseFromCode('OB_CORRECT_NO_EXISTING', opLog, { requestId })
      }

      // Refuse if a year-end close was built on top: correcting the IB without
      // unwinding the bokslut would leave the period (and the next period's
      // carried-forward IB) internally inconsistent.
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

      const oldEntryId = period.opening_balance_entry_id

      // 2. Validate the corrected lines (drop zeros, ≥2 rows, no P&L, must balance).
      const validation = validateOpeningBalanceLines(lines)
      if (!validation.ok) {
        return errorResponseFromCode(validation.code, opLog, {
          requestId,
          details:
            validation.code === 'OB_PNL_ACCOUNT'
              ? { accounts: validation.accounts }
              : validation.code === 'OB_UNBALANCED'
                ? { totalDebit: validation.totalDebit, totalCredit: validation.totalCredit, diff: validation.diff }
                : undefined,
        })
      }
      const { validLines, totalDebit, totalCredit } = validation

      // 3. Auto-activate BAS accounts the corrected file references but the chart lacks.
      const accountNumbers = [...new Set(validLines.map((l) => l.account_number))]
      const activation = await activateMissingAccounts(supabase, companyId!, user.id, accountNumbers)
      if (!activation.ok) {
        opLog.error('opening balance account activation failed', new Error(activation.reason))
        return errorResponseFromCode('OB_ACCOUNT_ACTIVATION_FAILED', opLog, {
          requestId,
          details: { reason: activation.reason },
        })
      }

      // BFL 5 kap 5§: reference the original verifikat so the correction is
      // traceable to the entry it rättar. The embed above gave us the old IB's
      // voucher label (e.g. "A123"). CreateJournalEntryInput exposes no dedicated
      // correction-linkage field (corrects_entry_id / correction_of / metadata),
      // so the description reference IS the linkage; we deliberately leave the
      // generic source_id unset rather than overload it for an opening_balance.
      const originalRef = (
        period as {
          opening_balance_entry?: {
            voucher_series?: string | null
            voucher_number?: number | null
          } | null
        }
      ).opening_balance_entry
      const originalVoucherLabel =
        originalRef?.voucher_series && originalRef?.voucher_number
          ? `${originalRef.voucher_series}${originalRef.voucher_number}`
          : null
      const correctedDescription = originalVoucherLabel
        ? `Ingående balanser (korrigerade, rättelse av ${originalVoucherLabel})`
        : 'Ingående balanser (korrigerade)'

      // 4. Book the corrected IB, storno the old one, then relink the period.
      //    Order matters: create the replacement BEFORE reversing the original so a
      //    mid-failure never leaves the period without an opening balance.
      const newEntry = await createJournalEntry(supabase, companyId!, user.id, {
        fiscal_period_id,
        entry_date: period.period_start,
        description: correctedDescription,
        source_type: 'opening_balance',
        voucher_series: 'A',
        lines: buildOpeningBalanceEntryLines(validLines),
      })

      // ASVS V16: durable audit sink for a failed correction. The core event bus
      // has no opening_balance.* correction event type and lib/events/types.ts is
      // outside the scope of this change, so the failure is recorded via the
      // structured logger: it lands in the JSON log sink (Vercel/Sentry), tagged
      // `audit: true` + both entry ids so an operator can reconcile the period by
      // hand. (Follow-up: promote to a typed event persisted to event_log.)
      const auditCorrectionFailure = (fields: Record<string, unknown>) => {
        opLog.error('audit: opening balance correction failed', {
          audit: true,
          event: 'opening_balance.correction_failed',
          companyId,
          userId: user.id,
          fiscalPeriodId: fiscal_period_id,
          newEntryId: newEntry.id,
          oldEntryId,
          ...fields,
        })
      }

      // FIX (ASVS V2.3: atomicity via compensation): steps B (storno old) and
      // C (relink) are NOT atomic with A (create new). A already produced a second
      // posted opening_balance entry for the period; if B or C fails, that entry is
      // orphaned and the Balansrapport would show two OB entries. Wrap B+C so that
      // on ANY failure below we compensate by stornoing the NEW entry, restoring the
      // period to its original consistent state (original OB still linked, new entry
      // cancelled by its own storno).
      try {
        // B: storno the original IB.
        await reverseEntry(supabase, companyId!, user.id, oldEntryId)

        // C: point the period at the corrected IB (single atomic RPC).
        const { error: relinkError } = await supabase.rpc('replace_period_opening_balance_link', {
          p_company_id: companyId,
          p_period_id: fiscal_period_id,
          p_new_entry_id: newEntry.id,
        })
        if (relinkError) {
          // Funnel the RPC error into the single compensation path below.
          throw new Error(`replace_period_opening_balance_link failed: ${relinkError.message}`)
        }
      } catch (seqErr) {
        const reason = seqErr instanceof Error ? seqErr.message : 'unknown'

        // Durable audit BEFORE compensation so the ids survive even if the
        // compensating storno also throws.
        //
        // Residual edge (documented): if B succeeded but C failed, the old entry is
        // now reversed yet still linked to the period. We still compensate the new
        // entry; the audit payload carries newEntryId + oldEntryId so an operator can
        // finish recovery (re-link or re-book) manually.
        auditCorrectionFailure({ phase: 'sequence_failed', reason })

        // Compensating rollback. This may itself throw (e.g. the period was locked
        // between A and here): catch + audit and never let it propagate past the
        // handler, so the caller always gets the OB_CORRECT_FAILED envelope.
        try {
          await reverseEntry(supabase, companyId!, user.id, newEntry.id)
          auditCorrectionFailure({ phase: 'compensated', reason })
        } catch (compErr) {
          auditCorrectionFailure({
            phase: 'compensation_failed',
            reason,
            compensationError: compErr instanceof Error ? compErr.message : 'unknown',
          })
        }

        return errorResponseFromCode('OB_CORRECT_FAILED', opLog, {
          requestId,
          details: { reason, newEntryId: newEntry.id, oldEntryId },
        })
      }

      return NextResponse.json({
        data: {
          success: true,
          journal_entry_id: newEntry.id,
          reversed_entry_id: oldEntryId,
          fiscal_period_id,
          lines_created: validLines.length,
          total_debit: totalDebit,
          total_credit: totalCredit,
        },
      })
    } catch (err) {
      if (isBookkeepingError(err)) {
        return errorResponse(err, opLog, { requestId })
      }
      opLog.error('opening balance correct failed', err as Error)
      return errorResponseFromCode('OB_CORRECT_FAILED', opLog, {
        requestId,
        details: { reason: err instanceof Error ? err.message : 'unknown' },
      })
    }
  },
  { requireWrite: true },
)
