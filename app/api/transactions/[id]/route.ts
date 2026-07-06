import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { requireCompanyId } from '@/lib/company/context'
import { requireWritePermission } from '@/lib/auth/require-write'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponse, errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { validateBody } from '@/lib/api/validate'
import { UpdateTransactionTitleSchema } from '@/lib/api/schemas'
import { guardSandbox } from '@/lib/sandbox/guard'
import { isImportedTransaction } from '@/lib/transactions/origin'
import type { Transaction } from '@/types'

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const supabase = await createClient()
  const { id } = await params

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const writeCheck = await requireWritePermission(supabase, user.id)
  if (!writeCheck.ok) return writeCheck.response

  const companyId = await requireCompanyId(supabase, user.id)

  // Fetch the transaction with ownership check. `bank_connection_id` +
  // `import_source` tell us where the row came from (see the imported guard below).
  const { data: transaction, error: fetchError } = await supabase
    .from('transactions')
    .select('id, journal_entry_id, bank_connection_id, import_source')
    .eq('id', id)
    .eq('company_id', companyId)
    .single()

  if (fetchError || !transaction) {
    return NextResponse.json(
      {
        error: {
          code: 'TRANSACTION_NOT_FOUND',
          message: 'Transaktionen hittades inte.',
          message_en: 'Transaction not found.',
        },
      },
      { status: 404 }
    )
  }

  // Guard: only unbooked transactions can be deleted. A booked/matched row is
  // räkenskapsinformation: the fix is to unlink (reconciliation) or storno, not
  // delete. Return a structured bilingual envelope so the UI shows this clear,
  // actionable message instead of the generic "Ladda om sidan" 409 fallback.
  if (transaction.journal_entry_id) {
    return NextResponse.json(
      {
        error: {
          code: 'TRANSACTION_DELETE_BOOKED',
          message:
            'Transaktionen är redan bokförd eller kopplad till en verifikation och kan inte raderas. Koppla bort den under Rapporter → Bankavstämning om kopplingen är fel, eller storna verifikationen.',
          message_en:
            'The transaction is already booked or linked to a journal entry and cannot be deleted. Unlink it under Reports → Bank reconciliation if the link is wrong, or reverse (storno) the voucher.',
        },
      },
      { status: 409 }
    )
  }

  // Guard: only transactions the user created in the app can be deleted. Rows
  // fetched via bank sync or uploaded via a bank-file import are an external
  // record of money that moved: deleting one would silently drop a real bank
  // line (and a re-sync would just bring it back). The user can *ignore* such a
  // row (POST /api/transactions/[id]/ignore) to take it off the to-book list,
  // but never delete it. See lib/transactions/origin.ts for the origin rule.
  if (isImportedTransaction(transaction)) {
    return NextResponse.json(
      {
        error: {
          code: 'TRANSACTION_DELETE_IMPORTED',
          message:
            'Transaktionen har hämtats från banken eller importerats via fil och kan inte raderas. Du kan ignorera den så att den döljs från listan över transaktioner att bokföra.',
          message_en:
            'This transaction was fetched from your bank or imported from a file and cannot be deleted. You can ignore it to hide it from the list of transactions to book.',
        },
      },
      { status: 409 }
    )
  }

  const { error: deleteError } = await supabase
    .from('transactions')
    .delete()
    .eq('id', id)
    .eq('company_id', companyId)

  if (deleteError) {
    // An unbooked row can still carry payment_match_log rows (written at ingest
    // for every auto-suggested match). Their FK cascades on delete, but the
    // audit-immutability trigger raises P0001: surface that as an actionable
    // message (match or ignore instead) rather than a bare 500.
    const code = (deleteError as { code?: string }).code
    const message = (deleteError as { message?: string }).message ?? ''
    if (code === 'P0001' || /Audit log entries cannot be modified or deleted/i.test(message)) {
      return NextResponse.json(
        {
          error: {
            code: 'TRANSACTION_DELETE_HAS_AUDIT_TRAIL',
            message:
              'Transaktionen kan inte raderas eftersom den har en kopplad matchningshistorik (räkenskapsinformation, BFL 7 kap.). Matcha den mot en befintlig verifikation, eller ignorera den under Rapporter → Bankavstämning om du inte vill bokföra den.',
            message_en:
              'The transaction cannot be deleted because it has linked match-history records (accounting information, BFL ch. 7). Match it to an existing voucher, or ignore it under Reports → Bank reconciliation if you do not want to book it.',
          },
        },
        { status: 409 }
      )
    }
    return NextResponse.json(
      {
        error: {
          code: 'TRANSACTION_DELETE_FAILED',
          message: 'Kunde inte ta bort transaktionen. Försök igen.',
          message_en: 'Could not delete the transaction. Please try again.',
        },
      },
      { status: 500 }
    )
  }

  return NextResponse.json({ success: true })
}

/**
 * Edit a bank transaction's title (description).
 *
 * Legal under BFL only while the row is a mutable staging label: i.e. NOT yet
 * booked into a verifikat and NOT confirmed-matched to an invoice. Once booked
 * the description is räkenskapsinformation and corrections go through storno
 * (reverseEntry/correctEntry), so this route hard-blocks those rows. The bank's
 * original title is preserved immutably in original_description (set at ingest)
 * and is never written here; passing it back restores the "not edited" tag.
 */
export const PATCH = withRouteContext(
  'transaction.updateTitle',
  async (request, ctx, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params
    const { supabase, companyId, log, requestId, user } = ctx

    const blocked = await guardSandbox(supabase, companyId)
    if (blocked) return blocked

    const validation = await validateBody(request, UpdateTransactionTitleSchema, {
      log,
      operation: 'transaction.updateTitle',
    })
    if (!validation.success) return validation.response
    const { description } = validation.data

    const { data: transaction, error: fetchError } = await supabase
      .from('transactions')
      .select('id, description, original_description, journal_entry_id, invoice_id, supplier_invoice_id')
      .eq('id', id)
      .eq('company_id', companyId)
      .single()

    if (fetchError || !transaction) {
      return errorResponseFromCode('TX_CATEGORIZE_TX_NOT_FOUND', log, { requestId })
    }

    // Gate: editable only when neither booked nor confirmed-matched. (A
    // confirmed invoice/supplier-invoice match also sets journal_entry_id, but
    // we check all three for defense-in-depth.) An unbooked row has no fiscal
    // period, so the period-lock requirement is satisfied implicitly.
    if (transaction.journal_entry_id || transaction.invoice_id || transaction.supplier_invoice_id) {
      return errorResponseFromCode('TRANSACTION_TITLE_LOCKED', log, { requestId })
    }

    // Restoring to the bank original clears the "edited" tag; any other value
    // marks the title as user-edited. Compare against the TRIMMED original (the
    // incoming description is already trimmed by the schema) so a legacy
    // original carrying surrounding whitespace still restores cleanly.
    const isRestore =
      transaction.original_description != null &&
      description === transaction.original_description.trim()
    const titleEditedAt = isRestore ? null : new Date().toISOString()

    const { data: updated, error: updateError } = await supabase
      .from('transactions')
      .update({ description, title_edited_at: titleEditedAt })
      .eq('id', id)
      .eq('company_id', companyId)
      // Re-assert the FULL editable gate atomically against a concurrent book
      // or auto-match. Ingest's supplier auto-match can set supplier_invoice_id
      // WITHOUT journal_entry_id, so guarding journal_entry_id alone leaves a
      // narrow TOCTOU window: mirror the read-time gate here.
      .is('journal_entry_id', null)
      .is('invoice_id', null)
      .is('supplier_invoice_id', null)
      // Return only what the client renders (data minimisation: the row also
      // carries company_id and other internal fields the caller doesn't need).
      .select('id, description, title_edited_at')
      .maybeSingle<Pick<Transaction, 'id' | 'description' | 'title_edited_at'>>()

    if (updateError) {
      return errorResponse(updateError, log, { requestId })
    }
    if (!updated) {
      // 0 rows updated → the row was booked/matched between read and write.
      return errorResponseFromCode('TRANSACTION_TITLE_LOCKED', log, { requestId })
    }

    // Behandlingshistorik (BFNAR 2013:2 kap 8): light-touch for a pre-verifikat
    // working label; updated_at (trigger) captures "when". We deliberately do
    // NOT log the description text: a bank label can carry PII (payee names,
    // reference numbers). The before-value stays recoverable in
    // original_description and the after-value is the row's current
    // description, so the log only needs to record that/which way it changed.
    log.info('transaction title edited', {
      transactionId: id,
      actor: user.id,
      restored: isRestore,
      previousLength: transaction.description?.length ?? 0,
      newLength: description.length,
    })

    return NextResponse.json({ data: updated })
  },
  { requireWrite: true },
)
