import { NextResponse } from 'next/server'
import { correctionBusinessEvents } from '@/lib/bookkeeping/ledger-business-events'
import { todayIsoStockholm } from '@/lib/dates/iso'
import { linkBasisColumns } from '@/lib/links/stamp'
import { postingPort } from '@/lib/posting/port'
import { voucherOwnerOrNull } from '@/lib/core/bookkeeping/voucher-owner'
import { validateBody } from '@/lib/api/validate'
import { CorrectJournalEntryAppSchema } from '@/lib/api/schemas'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { recordVoucherWarningsAcknowledged, runVoucherWarningsGuard } from '@/lib/bookkeeping/voucher-warnings-guard'

export const POST = withRouteContext<{ params: Promise<{ id: string }> }>(
  'bookkeeping.journal-entry.correct',
  async (request, { supabase, companyId, user, log, requestId }, { params }) => {
    const { id } = await params
    const validation = await validateBody(request, CorrectJournalEntryAppSchema)
    if (!validation.success) return validation.response

    // The verifikat being corrected, as posted: a block judges the rättelse
    // as the pair it posts (these lines out on this date, the new lines in),
    // so one that leaves the moms of a filed period as it was is not warned
    // about. A verifikat that is not there is correctEntry's refusal below.
    const { data: original } = await supabase
      .from('journal_entries')
      .select('entry_date, source_type, lines:journal_entry_lines(account_number, debit_amount, credit_amount)')
      .eq('id', id)
      .eq('company_id', companyId)
      .maybeSingle()

    // The corrected lines are typed: the booking-time VAT and revenue
    // warnings apply. A rättelse mirrors its original on purpose, so the
    // duplicate half stays out (lib/bookkeeping/voucher-warnings-guard.ts).
    const voucherGuard = await runVoucherWarningsGuard(
      supabase,
      companyId,
      {
        entry_date: validation.data.entry_date ?? '',
        description: validation.data.description ?? '',
        lines: validation.data.lines,
        replaces: original ? { entry_date: original.entry_date, lines: original.lines ?? [] } : null,
        opening_balance: original?.source_type === 'opening_balance',
      },
      log,
      { acknowledged: validation.data.acknowledged_warnings, checkDuplicates: false },
    )
    if (!voucherGuard.ok) {
      return errorResponseFromCode(voucherGuard.code, log, { requestId, details: voucherGuard.details })
    }
    // Posting port (step 2i): while POSTING_EVENTS is on, ledger.storno and
    // ledger.correction of the verifikat, which the person asked for
    // (user_created), each linked to its own new verifikat.
    const result = await postingPort.correctJournalEntry({
      supabase,
      companyId,
      userId: user.id,
      entryId: id,
      ...correctionBusinessEvents({ entryId: id, occurredOn: todayIsoStockholm, linkBasis: () => linkBasisColumns('user_created') }),
      correction: {
        lines: validation.data.lines,
        options: {
          description: validation.data.description,
          allowDeepChain: validation.data.allow_deep_chain,
          // The "Debet och kredit var omkastade" confirm (crm#1397).
          ...(validation.data.sides_swapped ? { sidesSwapped: true } : {}),
          // The rättelse's own date; the storno keeps the original's.
          // correctEntry finds its period and refuses a closed or locked one
          // (crm#1368).
          ...(validation.data.entry_date ? { newEntryDate: validation.data.entry_date } : {}),
        },
      },
    })
    const correctedId = (result as { corrected?: { id?: string } } | null)?.corrected?.id
    if (correctedId) {
      await recordVoucherWarningsAcknowledged({
        companyId,
        userId: user.id,
        journalEntryId: correctedId,
        warnings: voucherGuard.acknowledged,
        door: 'dashboard_correction',
        log,
      })
    }
    // The object the verifikat books, if any: the correction is a new
    // verifikat the object does not point at, so the answer names it.
    const ownedBy = await voucherOwnerOrNull(supabase, companyId, { id })
    return NextResponse.json({ data: result, owned_by: ownedBy })
  },
  { requireWrite: true },
)
