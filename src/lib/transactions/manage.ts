/**
 * What a user can do to one bank transaction BEFORE it is booked: delete a
 * row they typed in by hand, edit its working title, move it to another of
 * the company's cash accounts, and fill in a missing SEK rate. One
 * implementation behind the dashboard routes (/api/transactions/[id],
 * /api/transactions/[id]/cash-account, /api/transactions/[id]/refresh-
 * exchange-rate) and the v1 operations (lib/operations/transactions.ts), so
 * every door applies the same rules:
 *
 *   - only a mutable staging row may change: NOT booked (journal_entry_id),
 *     NOT confirmed-matched (invoice_id / supplier_invoice_id). Once booked
 *     the row is räkenskapsinformation: the fix is unlink or storno;
 *   - delete additionally refuses rows fetched from the bank or imported from
 *     a file (an external record of money that moved; ignore them instead)
 *     and rows whose payment_match_log history the immutability trigger
 *     protects (BFL 7 kap);
 *   - a move additionally refuses rows anchored through
 *     transaction_voucher_links (bulk-book N>1 sets no journal_entry_id),
 *     a target outside the company and a target in another currency.
 *
 * Every UPDATE re-asserts the gate in its WHERE clause, so a row booked or
 * auto-matched between read and write is refused, never overwritten.
 *
 * A dry run reads, checks and answers a preview; it writes nothing, never
 * calls Riksbanken and never touches the exchange rate cache.
 */
import type { OperationContext, OperationOutcome } from '@/lib/operations/types'
import type { Currency } from '@/types'
import { isImportedTransaction } from '@/lib/transactions/origin'
import { reenableIfUnused } from '@/lib/cash-accounts/service'
import { fetchExchangeRate } from '@/lib/currency/riksbanken'
import { roundOre } from '@/lib/money'

type Failure = Extract<OperationOutcome<never>, { ok: false }>

const TX_NOT_FOUND: Failure = { ok: false, code: 'TX_CATEGORIZE_TX_NOT_FOUND' }

function failed(error: unknown): Failure {
  return { ok: false, code: 'UNKNOWN_ERROR', error }
}

// ---------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------

export interface DeletedTransaction {
  transaction_id: string
  deleted: true
}

/**
 * Hard-delete one unbooked transaction the user created in the app (manual
 * entry, or one an agent added). Bank-synced and file-imported rows are an
 * external record and can only be ignored; booked rows need unlink/storno.
 */
export async function deleteTransaction(
  ctx: OperationContext,
  transactionId: string,
  options: { dryRun?: boolean } = {},
): Promise<OperationOutcome<DeletedTransaction>> {
  const { supabase, companyId, log } = ctx

  // bank_connection_id + import_source tell where the row came from
  // (lib/transactions/origin.ts).
  const { data: transaction, error: fetchError } = await supabase
    .from('transactions')
    .select('id, journal_entry_id, bank_connection_id, import_source')
    .eq('id', transactionId)
    .eq('company_id', companyId)
    .single()
  if (fetchError || !transaction) return TX_NOT_FOUND

  const row = transaction as {
    id: string
    journal_entry_id: string | null
    bank_connection_id: string | null
    import_source: string | null
  }

  // A booked/matched row is räkenskapsinformation: unlink or storno, never delete.
  if (row.journal_entry_id) return { ok: false, code: 'TRANSACTION_DELETE_BOOKED' }

  // Rows from the bank feed or a bank file are an external record of money
  // that moved: deleting one would silently drop a real bank line (and a
  // re-sync would bring it back). They can be ignored, never deleted.
  if (isImportedTransaction(row)) return { ok: false, code: 'TRANSACTION_DELETE_IMPORTED' }

  if (options.dryRun) {
    return {
      ok: true,
      dryRun: true,
      preview: {
        transaction_id: row.id,
        would_delete: true,
        import_source: row.import_source ?? null,
        note: 'A row with payment match history is refused at commit (TRANSACTION_DELETE_HAS_AUDIT_TRAIL): the history is append-only.',
      },
    }
  }

  const { error: deleteError } = await supabase
    .from('transactions')
    .delete()
    .eq('id', transactionId)
    .eq('company_id', companyId)

  if (deleteError) {
    // An unbooked row can still carry payment_match_log rows (written at
    // ingest for every auto-suggested match). Their FK cascades on delete,
    // but the audit-immutability trigger raises P0001: surface that as an
    // actionable refusal (match or ignore instead) rather than a bare 500.
    const code = (deleteError as { code?: string }).code
    const message = (deleteError as { message?: string }).message ?? ''
    if (code === 'P0001' || /Audit log entries cannot be modified or deleted/i.test(message)) {
      return { ok: false, code: 'TRANSACTION_DELETE_HAS_AUDIT_TRAIL' }
    }
    log.error('transaction delete failed', { transactionId, code })
    return { ok: false, code: 'TRANSACTION_DELETE_FAILED' }
  }

  log.info('transaction deleted', { transactionId, actor: ctx.userId })
  return { ok: true, data: { transaction_id: row.id, deleted: true } }
}

// ---------------------------------------------------------------------------
// Update: working title and/or cash account
// ---------------------------------------------------------------------------

export interface UpdateTransactionInput {
  /** New working title; the bank original stays in original_description. */
  description?: string
  /** BAS 19xx ledger account of the target cash account, as a string. */
  account_number?: string
}

export interface UpdatedTransaction {
  id: string
  description: string | null
  title_edited_at: string | null
  cash_account_id: string | null
}

interface TargetAccount {
  id: string
  ledger_account: string
  currency: string
  enabled: boolean | null
  bank_connection_id: string | null
  invoice_payee: boolean | null
}

/**
 * Edit the working title and/or move the row to another cash account. Both
 * only on an unbooked, unmatched row; the move also refuses a row anchored
 * through transaction_voucher_links and a target in another currency.
 * Passing the bank original as description restores the "not edited" tag.
 */
export async function updateTransaction(
  ctx: OperationContext,
  transactionId: string,
  input: UpdateTransactionInput,
  options: { dryRun?: boolean } = {},
): Promise<OperationOutcome<UpdatedTransaction>> {
  const { supabase, companyId, log, userId } = ctx
  const moving = input.account_number !== undefined
  const retitling = input.description !== undefined
  // The code a refused row answers: a move names the move, a title edit the title.
  const lockedCode = moving ? 'TRANSACTION_MOVE_BOOKED' : 'TRANSACTION_TITLE_LOCKED'

  const { data: fetched, error: fetchError } = await supabase
    .from('transactions')
    .select('id, description, original_description, currency, cash_account_id, journal_entry_id, invoice_id, supplier_invoice_id')
    .eq('id', transactionId)
    .eq('company_id', companyId)
    .single()
  if (fetchError || !fetched) return TX_NOT_FOUND

  const transaction = fetched as {
    id: string
    description: string | null
    original_description: string | null
    currency: string | null
    cash_account_id: string | null
    journal_entry_id: string | null
    invoice_id: string | null
    supplier_invoice_id: string | null
  }

  // Gate: editable only when neither booked nor confirmed-matched. (A
  // confirmed match also sets journal_entry_id; all three are checked for
  // defense in depth.) An unbooked row has no fiscal period, so the period
  // lock is satisfied implicitly.
  if (transaction.journal_entry_id || transaction.invoice_id || transaction.supplier_invoice_id) {
    return { ok: false, code: lockedCode }
  }

  let target: TargetAccount | null = null
  if (moving) {
    // Bulk-book (N>1) anchors a transaction to a verifikat through
    // transaction_voucher_links WITHOUT setting journal_entry_id, so the gate
    // above misses it. PostgREST cannot express NOT EXISTS in an update
    // filter, so this is a pre-check; a link appearing concurrently implies
    // the booking flow ran, which sets its own transaction state.
    const { data: voucherLinks, error: tvlError } = await supabase
      .from('transaction_voucher_links')
      .select('transaction_id')
      .eq('company_id', companyId)
      .eq('transaction_id', transactionId)
      .limit(1)
    if (tvlError) return failed(tvlError)
    if ((voucherLinks ?? []).length > 0) return { ok: false, code: 'TRANSACTION_MOVE_BOOKED' }

    const { data: account, error: accountError } = await supabase
      .from('cash_accounts')
      .select('id, ledger_account, currency, enabled, bank_connection_id, invoice_payee')
      .eq('company_id', companyId)
      .eq('ledger_account', input.account_number!)
      .maybeSingle()
    if (accountError) return failed(accountError)
    if (!account) return { ok: false, code: 'TRANSACTION_MOVE_UNKNOWN_ACCOUNT' }
    target = account as TargetAccount

    // A cross-currency move would strand the row: every report scope pins
    // the account currency, so the row would vanish from BOTH accounts'
    // reconciliation.
    if ((transaction.currency ?? 'SEK').toUpperCase() !== target.currency.toUpperCase()) {
      return { ok: false, code: 'TRANSACTION_MOVE_CURRENCY_MISMATCH' }
    }
  }

  // Restoring to the bank original clears the "edited" tag; any other value
  // marks the title as user-edited. Compared against the TRIMMED original.
  const isRestore =
    retitling &&
    transaction.original_description != null &&
    input.description === transaction.original_description.trim()

  if (options.dryRun) {
    return {
      ok: true,
      dryRun: true,
      preview: {
        transaction_id: transaction.id,
        ...(retitling
          ? { description: { from: transaction.description, to: input.description, restores_bank_original: isRestore } }
          : {}),
        ...(target
          ? {
              cash_account: {
                from_cash_account_id: transaction.cash_account_id,
                to_cash_account_id: target.id,
                to_ledger_account: target.ledger_account,
                // A disabled, unconnected target is turned back on first: the
                // disable guard refuses open transactions on a hidden account.
                reenables_account: target.enabled === false && target.bank_connection_id == null,
              },
            }
          : {}),
      },
    }
  }

  // An unbooked row is about to land on the target, so an account the
  // company turned off as unused comes back on first. Before the move, so a
  // failed re-enable moves nothing.
  if (target) {
    try {
      await reenableIfUnused(supabase, companyId, target)
    } catch (err) {
      return failed(err)
    }
  }

  // Literal payloads per case (the schema guard checks literal columns).
  const titleEditedAt = isRestore ? null : new Date().toISOString()
  const write =
    retitling && target
      ? supabase
          .from('transactions')
          .update({ description: input.description, title_edited_at: titleEditedAt, cash_account_id: target.id })
      : retitling
        ? supabase.from('transactions').update({ description: input.description, title_edited_at: titleEditedAt })
        : supabase.from('transactions').update({ cash_account_id: target!.id })

  const { data: updated, error: updateError } = await write
    .eq('id', transactionId)
    .eq('company_id', companyId)
    // Re-assert the full editable gate atomically against a concurrent book
    // or auto-match (ingest's supplier auto-match can set
    // supplier_invoice_id WITHOUT journal_entry_id).
    .is('journal_entry_id', null)
    .is('invoice_id', null)
    .is('supplier_invoice_id', null)
    .select('id, description, title_edited_at, cash_account_id')
    .maybeSingle()

  if (updateError) return failed(updateError)
  // 0 rows updated: the row was booked/matched between read and write.
  if (!updated) return { ok: false, code: lockedCode }

  // Behandlingshistorik (BFNAR 2013:2 kap 8): light-touch for a pre-verifikat
  // working label and staging binding; updated_at (trigger) captures "when".
  // The description text is not logged: a bank label can carry PII, and the
  // before-value stays recoverable in original_description.
  if (retitling) {
    log.info('transaction title edited', {
      transactionId,
      actor: userId,
      restored: isRestore,
      previousLength: transaction.description?.length ?? 0,
      newLength: input.description!.length,
    })
  }
  if (target) {
    log.info('transaction moved to another cash account', {
      transactionId,
      actor: userId,
      fromCashAccountId: transaction.cash_account_id,
      toCashAccountId: target.id,
      toLedgerAccount: target.ledger_account,
    })
  }

  const row = updated as Partial<UpdatedTransaction> & { id: string }
  return {
    ok: true,
    data: {
      id: row.id,
      description: row.description ?? null,
      title_edited_at: row.title_edited_at ?? null,
      cash_account_id: row.cash_account_id ?? null,
    },
  }
}

// ---------------------------------------------------------------------------
// Refresh exchange rate
// ---------------------------------------------------------------------------

export interface RefreshedExchangeRate<T = Record<string, unknown>> {
  /** The transaction row after the refresh (unchanged when nothing was needed). */
  transaction: T
  /** False for a SEK row or one that already carried a rate. */
  refreshed: boolean
}

/**
 * Fill in the SEK amount and Riksbanken rate of an unbooked foreign-currency
 * transaction that is missing them. A SEK row, or one that already carries
 * both, is answered unchanged. A booked row is never touched.
 */
export async function refreshTransactionExchangeRate(
  ctx: OperationContext,
  transactionId: string,
  options: { dryRun?: boolean } = {},
): Promise<OperationOutcome<RefreshedExchangeRate>> {
  const { supabase, companyId } = ctx

  const { data: fetched, error: fetchError } = await supabase
    .from('transactions')
    .select('*')
    .eq('id', transactionId)
    .eq('company_id', companyId)
    .single()
  if (fetchError || !fetched) return TX_NOT_FOUND

  const transaction = fetched as Record<string, unknown> & {
    id: string
    currency: string
    amount: number
    date: string
    amount_sek: number | null
    exchange_rate: number | null
    journal_entry_id: string | null
  }

  // No-op for SEK transactions, or when the rate is already there.
  if (
    transaction.currency === 'SEK' ||
    (transaction.amount_sek != null && transaction.exchange_rate != null)
  ) {
    if (options.dryRun) {
      return { ok: true, dryRun: true, preview: { transaction_id: transaction.id, needs_rate: false } }
    }
    return { ok: true, data: { transaction, refreshed: false } }
  }

  // The UPDATE below only matches an unbooked row; refuse a booked one up
  // front so the dry run answers the same.
  if (transaction.journal_entry_id) return { ok: false, code: 'TX_EXCHANGE_RATE_BOOKED' }

  if (options.dryRun) {
    // No Riksbanken call and no cache write on a dry run.
    return {
      ok: true,
      dryRun: true,
      preview: {
        transaction_id: transaction.id,
        needs_rate: true,
        currency: transaction.currency,
        rate_date: transaction.date,
        source: 'Riksbanken',
      },
    }
  }

  const rate = await fetchExchangeRate(transaction.currency as Currency, new Date(transaction.date), supabase)
  if (!rate) {
    return {
      ok: false,
      code: 'TX_EXCHANGE_RATE_UNAVAILABLE',
      details: { currency: transaction.currency, date: transaction.date },
    }
  }

  const { data: updated, error: updateError } = await supabase
    .from('transactions')
    .update({
      amount_sek: roundOre(transaction.amount * rate.rate),
      exchange_rate: rate.rate,
      exchange_rate_date: rate.date,
    })
    .eq('id', transactionId)
    .eq('company_id', companyId)
    .is('journal_entry_id', null)
    .select('*')
    .maybeSingle()

  if (updateError) return failed(updateError)
  // Booked between read and write.
  if (!updated) return { ok: false, code: 'TX_EXCHANGE_RATE_BOOKED' }
  return { ok: true, data: { transaction: updated as Record<string, unknown>, refreshed: true } }
}
