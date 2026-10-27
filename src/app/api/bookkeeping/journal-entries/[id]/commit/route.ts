import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { CommitJournalEntryDraftSchema, DASHBOARD_VOUCHER_SOURCE_TYPES } from '@/lib/api/schemas'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { postingPort } from '@/lib/posting/port'
import { recordVoucherWarningsAcknowledged, runVoucherWarningsGuard } from '@/lib/bookkeeping/voucher-warnings-guard'

export const POST = withRouteContext<{ params: Promise<{ id: string }> }>(
  'bookkeeping.journal-entry.commit',
  async (request, { supabase, companyId, user, log, requestId }, { params }) => {
    const { id } = await params
    // The body is optional (older callers POST none): its one field is the
    // warnings the person confirmed. Malformed JSON is a caller bug: 400.
    let acknowledged: string[] | undefined
    const rawText = await request.text()
    if (rawText.trim()) {
      let parsedJson: unknown
      try {
        parsedJson = JSON.parse(rawText)
      } catch {
        // Not swallowed: a body that is not JSON is the caller's bug, answered as 400.
        return errorResponseFromCode('VALIDATION_ERROR', log, { requestId, messageSv: 'Ogiltig JSON i förfrågan.', messageEn: 'Body is not valid JSON.' })
      }
      const parsed = CommitJournalEntryDraftSchema.safeParse(parsedJson)
      if (!parsed.success) {
        return errorResponseFromCode('VALIDATION_ERROR', log, { requestId, details: { issues: parsed.error.issues } })
      }
      acknowledged = parsed.data.acknowledged_warnings
    }

    // A typed draft (the voucher form's "spara som utkast", an agent's or an
    // API draft) meets the same booking-time warnings as a direct posting;
    // drafts other flows generate keep their own checks.
    const { data: draft } = await supabase
      .from('journal_entries')
      .select('entry_date, description, source_type, lines:journal_entry_lines(account_number, debit_amount, credit_amount)')
      .eq('id', id)
      .eq('company_id', companyId)
      .maybeSingle()
    const typed = draft && (DASHBOARD_VOUCHER_SOURCE_TYPES as readonly string[]).includes(draft.source_type)
    const guard = typed
      ? await runVoucherWarningsGuard(
          supabase,
          companyId,
          { entry_date: draft.entry_date, description: draft.description ?? '', lines: draft.lines ?? [] },
          log,
          { acknowledged, excludeJournalEntryId: id },
        )
      : null
    if (guard && !guard.ok) {
      return errorResponseFromCode(guard.code, log, { details: guard.details, requestId })
    }

    // Posting port (step 2i): a draft made through the port carries its
    // event link already, so the commit records nothing in any mode.
    const posted = await postingPort.commitJournalEntry({ supabase, companyId, userId: user.id, entryId: id, commitMethod: 'user_accept' })
    if (guard?.ok && guard.acknowledged.length > 0) {
      await recordVoucherWarningsAcknowledged({
        companyId,
        userId: user.id,
        journalEntryId: id,
        warnings: guard.acknowledged,
        door: 'dashboard_draft_commit',
        log,
      })
    }
    return NextResponse.json({ data: posted })
  },
  { requireWrite: true },
)
