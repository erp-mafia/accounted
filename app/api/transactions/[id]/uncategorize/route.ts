import { NextResponse } from 'next/server'
import { reverseEntry } from '@/lib/bookkeeping/engine'
import { bookkeepingErrorResponse } from '@/lib/bookkeeping/errors'
import { ensureInitialized } from '@/lib/init'
import { withRouteContext } from '@/lib/api/with-route-context'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import { logMatchEvent } from '@/lib/invoices/match-log'

ensureInitialized()

export const POST = withRouteContext<{ params: Promise<{ id: string }> }>(
  'transaction.uncategorize',
  async (_request, { supabase, user, companyId }, { params }) => {
    const { id } = await params

    // Fetch transaction
    const { data: transaction, error: txError } = await supabase
      .from('transactions')
      .select('id, journal_entry_id')
      .eq('id', id)
      .eq('company_id', companyId)
      .single()

    if (txError || !transaction) {
      return NextResponse.json({ error: 'Transaction not found' }, { status: 404 })
    }

    // A row coupled to several already-posted verifikat carries no scalar
    // pointer, so on the column alone this route reported "has no journal
    // entry" and the coupling could never be undone from the UI.
    const { data: voucherLinks, error: linksError } = await supabase
      .from('transaction_voucher_links')
      .select('journal_entry_id')
      .eq('transaction_id', id)
      .eq('company_id', companyId)

    if (linksError) {
      return NextResponse.json({ error: 'Failed to read voucher links' }, { status: 500 })
    }

    const links = (voucherLinks ?? []) as Array<{ journal_entry_id: string }>

    if (!transaction.journal_entry_id && links.length === 0) {
      return NextResponse.json({ error: 'Transaction has no journal entry' }, { status: 400 })
    }

    // Link-only undo. These entries were NOT created by this transaction: the
    // user booked them separately and only coupled the bank row to them, so
    // reversing them would storno bookkeeping that is entirely correct and
    // still owed by the underlying affärshändelse. Removing the coupling is
    // the whole undo (BFL 5 kap 5 § is not in play: no posted entry is edited
    // or deleted, and the verifikat keep their voucher numbers).
    //
    // The scalar branch below stays storno because there the entry exists only
    // because this transaction was categorized.
    //
    // NOTE for the book-new split flow (split_book_transaction), when it lands:
    // its parts DO create entries and must be storno-reversed here. Discriminate
    // on the entry itself (source_type = 'bank_transaction' with source_id = this
    // transaction), not on the presence of a link row: both flows write links.
    if (!transaction.journal_entry_id) {
      const { error: deleteError } = await supabase
        .from('transaction_voucher_links')
        .delete()
        .eq('transaction_id', id)
        .eq('company_id', companyId)

      if (deleteError) {
        return NextResponse.json({ error: 'Failed to remove voucher links' }, { status: 500 })
      }

      const { error: resetError } = await supabase
        .from('transactions')
        .update({
          is_business: null,
          category: null,
          reconciliation_method: null,
        })
        .eq('id', id)
        .eq('company_id', companyId)

      if (resetError) {
        return NextResponse.json({ error: 'Failed to reset transaction' }, { status: 500 })
      }

      // Behandlingshistorik (BFNAR 2013:2 kap 8, BFL 7:1). Named individually
      // because with the links gone there is no other record of which verifikat
      // the row was detached from. Awaited: an unawaited promise can be frozen
      // on serverless when the response returns, dropping the audit row.
      await logMatchEvent(supabase, user.id, id, 'unmatched', {
        matchMethod: 'manual_multi_voucher',
        previousState: {
          unlinked_journal_entry_ids: links.map((l) => l.journal_entry_id),
          link_count: links.length,
        },
      })

      return NextResponse.json({ success: true, unlinked_count: links.length, reversed: false })
    }

    // Verify journal entry is posted
    const { data: entry, error: entryError } = await supabase
      .from('journal_entries')
      .select('id, status')
      .eq('id', transaction.journal_entry_id)
      .eq('company_id', companyId)
      .single()

    if (entryError || !entry) {
      return NextResponse.json({ error: 'Journal entry not found' }, { status: 400 })
    }

    if (entry.status !== 'posted') {
      return NextResponse.json({ error: 'Journal entry is not posted' }, { status: 400 })
    }

    // Storno reversal (legally compliant: never deletes)
    try {
      await reverseEntry(supabase, companyId, user.id, transaction.journal_entry_id)
    } catch (err) {
      const typed = bookkeepingErrorResponse(err)
      if (typed) return typed
      return NextResponse.json(
        { error: getErrorMessage(err, { context: 'transaction' }) },
        { status: 500 },
      )
    }

    // A single-link coupling keeps the scalar and the link row in sync, so the
    // link has to go too or the row would still read as booked through the
    // junction after its entry was reversed.
    if (links.length > 0) {
      const { error: deleteError } = await supabase
        .from('transaction_voucher_links')
        .delete()
        .eq('transaction_id', id)
        .eq('company_id', companyId)

      if (deleteError) {
        return NextResponse.json({ error: 'Failed to remove voucher links' }, { status: 500 })
      }
    }

    // Reset transaction categorization
    const { error: updateError } = await supabase
      .from('transactions')
      .update({
        is_business: null,
        category: null,
        journal_entry_id: null,
      })
      .eq('id', id)
      .eq('company_id', companyId)

    if (updateError) {
      return NextResponse.json({ error: 'Failed to reset transaction' }, { status: 500 })
    }

    return NextResponse.json({ success: true, reversed: true })
  },
  { requireWrite: true },
)
