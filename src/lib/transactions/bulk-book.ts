/**
 * Bulk-book N bank transactions on the same date into one combined verifikat
 * (samlingsverifikation per BFL 5 kap 6 §), atomically through the
 * bulk_book_transactions RPC. Three paths, exactly one per call:
 *
 *   1. existing_journal_entry_id: link the rows to an already-posted voucher
 *      (no new entry; the voucher's 19xx net must equal the row sum);
 *   2. template_id + mode + entry_description: expand a booking template
 *      per row (one_line_per_tx) or on the sum (sum_per_account);
 *   3. manual_lines + entry_description: caller-built balanced lines.
 *
 * One implementation behind the dashboard route
 * (POST /api/transactions/bulk-book) and the v1 operation
 * transactions.bulk-book (lib/operations/transactions.ts). The MCP tool
 * gnubok_bulk_book_transactions stages the same RPC through its own
 * hand-written preview and commit executor.
 *
 * Rules before the RPC: every row belongs to the company; one currency, and
 * that currency SEK (the ledger columns are kronor and nothing here carries
 * a rate); the booking-time duplicate guard per row unless force=true (then
 * each dismissed candidate is recorded in behandlingshistorik); manual
 * lines only on active accounts of the company's chart; a template the
 * caller can see (system, the company's own, or a team the user belongs to:
 * the RLS rule, re-applied here because the v1 door runs as the service
 * role); the account dimension rules. The RPC re-checks tenant scope, date,
 * direction, balance, periods and not-already-booked.
 *
 * A dry run runs every rule above and answers the lines the verifikat would
 * carry; it writes nothing (no RPC, no events, no behandlingshistorik).
 */
import type { OperationContext, OperationOutcome } from '@/lib/operations/types'
import type { BookingTemplateLibraryLine, Transaction } from '@/types'
import { applyTemplate } from '@/lib/bookkeeping/template-library'
import { mergeDimensionBags } from '@/lib/bookkeeping/dimension-resolver'
import {
  applyDimensionRules,
  assertMandatoryDimensions,
  fetchActiveDimensionRules,
} from '@/lib/bookkeeping/dimension-rules'
import { propagateUnderlagForBookedTransaction } from '@/lib/transactions/inbox-underlag'
import { detectBookingDuplicate } from '@/lib/transactions/booking-duplicate-detection'
import { appendProcessingHistory } from '@/lib/processing-history/append'
import { eventBus } from '@/lib/events/bus'
import { getErrorMessage as getUserErrorMessage } from '@/lib/errors/get-error-message'
import { roundOre } from '@/lib/money'

export interface BulkBookInput {
  tx_ids: string[]
  existing_journal_entry_id?: string
  template_id?: string
  mode?: 'one_line_per_tx' | 'sum_per_account'
  entry_description?: string
  manual_lines?: Array<{
    account_number: string
    debit_amount: number
    credit_amount: number
    currency: string
    line_description?: string
    dimensions?: Record<string, string>
  }>
  default_dimensions?: Record<string, string>
  force?: boolean
}

export interface BulkBookResult {
  mode: 'link_existing' | 'create_new'
  journal_entry_id: string
  voucher_series: string | null
  voucher_number: number | null
  linked_tx_count: number
  tx_sum: number
  docs_linked: number
}

interface RpcOk extends BulkBookResult {
  ok: true
}

interface RpcErr {
  ok: false
  code: string
  details?: Record<string, unknown>
}

interface ComputedLine {
  account_number: string
  debit_amount: number
  credit_amount: number
  currency: string
  line_description?: string
  sort_order?: number
  // Dimensions PR7: bag persisted by the RPC onto journal_entry_lines.
  dimensions?: Record<string, string>
}

type SelectedTx = Pick<
  Transaction,
  'id' | 'amount' | 'currency' | 'description' | 'date' | 'amount_sek' | 'exchange_rate' | 'cash_account_id'
>

export async function bulkBookTransactions(
  ctx: OperationContext,
  body: BulkBookInput,
  /** via: which door honoured a force override, for behandlingshistorik. */
  options: { dryRun?: boolean; via?: string } = {},
): Promise<OperationOutcome<BulkBookResult>> {
  const { supabase, companyId, userId, log } = ctx
  const opLog = log.child({ txCount: body.tx_ids.length })

  // Fetch the selected rows once, for every path: the template branch needs
  // the amounts, every branch the currencies.
  const { data: txs, error: txError } = await supabase
    .from('transactions')
    .select('id, amount, currency, description, date, amount_sek, exchange_rate, cash_account_id')
    .in('id', body.tx_ids)
    .eq('company_id', companyId)

  if (txError || !txs || txs.length === 0) return { ok: false, code: 'BULK_BOOK_TXS_NOT_FOUND' }
  if (txs.length !== body.tx_ids.length) {
    return { ok: false, code: 'BULK_BOOK_TXS_NOT_FOUND', details: { expected: body.tx_ids.length, found: txs.length } }
  }
  const txTyped = txs as SelectedTx[]

  // Currency homogeneity for all three paths (BFL 4 kap 6 §: one
  // redovisningsvaluta; a SEK+EUR sum is no belopp of any affärshändelse).
  // NULL is the legacy spelling of the column default 'SEK'.
  const currencies = new Set(txTyped.map((t) => t.currency ?? 'SEK'))
  if (currencies.size > 1) {
    return { ok: false, code: 'BULK_BOOK_MIXED_CURRENCY', details: { currencies: Array.from(currencies).sort() } }
  }
  const currency = txTyped[0]!.currency ?? 'SEK'
  // A homogeneous foreign batch is refused too: the line columns are always
  // kronor and neither this path nor the RPC carries a rate. The FX-aware
  // single-row flows book those.
  if (currency !== 'SEK') return { ok: false, code: 'BULK_BOOK_FOREIGN_CURRENCY', details: { currency } }

  // Booking-time duplicate guard, parity with /categorize and /book. The
  // OTHER selected rows and the link-existing target are the batch's own, so
  // they never flag. Checked in tx_ids order so the flagged row is
  // deterministic; a detection failure never blocks.
  const txById = new Map(txTyped.map((tx) => [tx.id, tx]))
  const duplicateExclusions = {
    excludeTransactionIds: body.tx_ids,
    excludeJournalEntryIds: body.existing_journal_entry_id ? [body.existing_journal_entry_id] : [],
  }
  const detectForTx = (tx: SelectedTx) =>
    detectBookingDuplicate(
      supabase,
      companyId,
      {
        id: tx.id,
        date: tx.date,
        amount: tx.amount,
        currency: tx.currency ?? null,
        amount_sek: tx.amount_sek ?? null,
        exchange_rate: tx.exchange_rate ?? null,
        cash_account_id: tx.cash_account_id ?? null,
      },
      duplicateExclusions,
    )
  if (body.force !== true) {
    for (const txId of body.tx_ids) {
      const tx = txById.get(txId)
      if (!tx) continue
      let candidate = null
      try {
        candidate = await detectForTx(tx)
      } catch (err) {
        opLog.warn('bulk-book duplicate detection failed (continuing)', { err, txId })
      }
      if (candidate) {
        return {
          ok: false,
          code: 'TRANSACTION_BOOK_POSSIBLE_DUPLICATE',
          details: { candidate, transaction_id: txId } as unknown as Record<string, unknown>,
        }
      }
    }
  } else if (!options.dryRun) {
    // force=true bypassed the guard: every dismissed candidate gets a
    // durable behandlingshistorik record (BFNAR 2013:2 kap 8). Best-effort.
    for (const txId of body.tx_ids) {
      const tx = txById.get(txId)
      if (!tx) continue
      try {
        const dismissed = await detectForTx(tx)
        if (!dismissed) continue
        opLog.warn('bulk-book duplicate guard bypassed', {
          reason: 'force=true',
          txId,
          dismissedJournalEntryId: dismissed.journal_entry_id,
        })
        await appendProcessingHistory({
          companyId,
          correlationId: txId,
          aggregateType: 'BankTransaction',
          aggregateId: txId,
          eventType: 'BankTransactionDuplicateDismissed',
          payload: {
            transaction_id: txId,
            dismissed_transaction_id: dismissed.transaction_id,
            dismissed_journal_entry_id: dismissed.journal_entry_id,
            // Null when the candidate's SEK value could not be established.
            amount_ore: dismissed.amount != null ? Math.round(dismissed.amount * 100) : null,
            dismissed_currency: dismissed.currency,
            dismissed_amount_in_currency: dismissed.amount_in_currency,
            entry_date: dismissed.entry_date,
            amount_verified: dismissed.amount_verified,
            unverified_reason: dismissed.unverified_reason,
            via: options.via ?? 'bulk_book_force',
          },
          actor: { type: 'user', id: userId },
          occurredAt: new Date(),
        })
      } catch (err) {
        opLog.error('failed to append duplicate-dismissal behandlingshistorik', err as Error)
      }
    }
  }

  let newEntryPayload: { description: string; lines: ComputedLine[] } | null = null

  if (body.manual_lines && body.entry_description) {
    // The schema validated the account format; the RPC checks balance and
    // sides. Here: every account exists and is active in THIS company's chart.
    const accountNumbers = Array.from(new Set(body.manual_lines.map((l) => l.account_number)))
    const { data: knownAccounts, error: accountsError } = await supabase
      .from('chart_of_accounts')
      .select('account_number')
      .eq('company_id', companyId)
      .eq('is_active', true)
      .in('account_number', accountNumbers)
    if (accountsError) {
      opLog.error('chart_of_accounts lookup failed', accountsError)
      return { ok: false, code: 'BULK_BOOK_RPC_FAILED', details: { message: getUserErrorMessage(accountsError) } }
    }
    const validSet = new Set((knownAccounts ?? []).map((a: { account_number: string }) => a.account_number))
    const invalid = accountNumbers.filter((n) => !validSet.has(n))
    if (invalid.length > 0) return { ok: false, code: 'BULK_BOOK_INVALID_ACCOUNT', details: { invalid_accounts: invalid } }

    newEntryPayload = {
      description: body.entry_description,
      lines: body.manual_lines.map((l, i) => ({
        account_number: l.account_number,
        debit_amount: roundOre(l.debit_amount),
        credit_amount: roundOre(l.credit_amount),
        currency: l.currency,
        line_description: l.line_description,
        sort_order: i,
        // Dimensions PR7: per-line bag wins over the header default.
        dimensions: mergeDimensionBags(body.default_dimensions, l.dimensions),
      })),
    }
  } else if (body.template_id && body.mode && body.entry_description) {
    const { data: template, error: templateError } = await supabase
      .from('booking_template_library')
      .select('id, name, lines, is_active, is_system, company_id, team_id')
      .eq('id', body.template_id)
      .single()

    if (templateError || !template) return { ok: false, code: 'BULK_BOOK_TEMPLATE_NOT_FOUND' }
    const tpl = template as {
      lines: BookingTemplateLibraryLine[] | null
      is_active: boolean
      is_system: boolean | null
      company_id: string | null
      team_id: string | null
    }
    // The btl_select RLS rule, re-applied: the v1 door runs as the service
    // role, where RLS does not hide another company's template.
    if (!(await templateVisible(ctx, tpl))) return { ok: false, code: 'BULK_BOOK_TEMPLATE_NOT_FOUND' }
    if (!tpl.is_active) {
      return { ok: false, code: 'BULK_BOOK_TEMPLATE_NOT_FOUND', details: { reason: 'template_inactive' } }
    }

    const templateLines = (tpl.lines ?? []) as BookingTemplateLibraryLine[]
    const totalAbs = roundOre(txTyped.reduce((s, t) => s + Math.abs(t.amount), 0))
    const lines: ComputedLine[] = []
    let sortOrder = 0

    if (body.mode === 'sum_per_account') {
      // One application at the summed amount: one line per template line.
      // Per-row detail stays recoverable via transaction_voucher_links.
      for (const formLine of applyTemplate(templateLines, totalAbs)) {
        const debit = parseFloat(formLine.debit_amount || '0') || 0
        const credit = parseFloat(formLine.credit_amount || '0') || 0
        if (debit === 0 && credit === 0) continue
        lines.push({
          account_number: formLine.account_number,
          debit_amount: roundOre(debit),
          credit_amount: roundOre(credit),
          currency,
          line_description: formLine.line_description || undefined,
          sort_order: sortOrder++,
          dimensions: body.default_dimensions,
        })
      }
    } else {
      // one_line_per_tx: the template per row, each line tagged with a short
      // row reference (BFL 5 kap 7 § motpart identification).
      for (const tx of txTyped) {
        for (const formLine of applyTemplate(templateLines, Math.abs(tx.amount))) {
          const debit = parseFloat(formLine.debit_amount || '0') || 0
          const credit = parseFloat(formLine.credit_amount || '0') || 0
          if (debit === 0 && credit === 0) continue
          const txTag = (tx.description || '').slice(0, 40).trim()
          lines.push({
            account_number: formLine.account_number,
            debit_amount: roundOre(debit),
            credit_amount: roundOre(credit),
            currency,
            line_description: txTag
              ? `${formLine.line_description ?? ''}: ${txTag}`.trim()
              : formLine.line_description || undefined,
            sort_order: sortOrder++,
            dimensions: body.default_dimensions,
          })
        }
      }
    }
    newEntryPayload = { description: body.entry_description, lines }
  }

  // Account dimension rules (dimensions PR10): the RPC bypasses the TS
  // engine, so the policy runs here. Zero rules or a failed fetch changes
  // nothing (fail-open, same posture as the engine).
  if (newEntryPayload) {
    const rules = await fetchActiveDimensionRules(supabase, companyId)
    if (rules === null) opLog.warn('dimension rule fetch failed: policy skipped (fail-open)')
    if (rules && rules.length > 0) {
      newEntryPayload.lines = applyDimensionRules(newEntryPayload.lines, rules)
      try {
        assertMandatoryDimensions(newEntryPayload.lines, rules)
      } catch (err) {
        // A BookkeepingError: the doors translate it verbatim.
        return { ok: false, code: 'UNKNOWN_ERROR', error: err }
      }
    }
  }

  if (options.dryRun) {
    const txSum = roundOre(txTyped.reduce((s, t) => s + t.amount, 0))
    return {
      ok: true,
      dryRun: true,
      preview: {
        mode: body.existing_journal_entry_id ? 'link_existing' : 'create_new',
        tx_count: txTyped.length,
        // Signed SEK sum of the selected rows (this path is SEK-only).
        tx_sum: txSum,
        tx_sum_abs: Math.abs(txSum),
        currency,
        ...(body.existing_journal_entry_id ? { existing_journal_entry_id: body.existing_journal_entry_id } : {}),
        ...(newEntryPayload
          ? { entry_description: newEntryPayload.description, lines: newEntryPayload.lines }
          : {}),
        ...(body.force ? { duplicate_guard: 'bypassed (force=true)' } : {}),
        note: 'The RPC re-checks date, direction, balance, period locks and not-already-booked at commit.',
      },
    }
  }

  const { data, error } = await supabase.rpc('bulk_book_transactions', {
    p_tx_ids: body.tx_ids,
    p_existing_journal_entry_id: body.existing_journal_entry_id ?? null,
    p_new_entry: newEntryPayload,
    p_company_id: companyId,
    // Honoured only for a service_role caller (the v1 door); a session
    // caller resolves from its own auth.uid() (migration 20260824170000).
    p_user_id: userId,
  })
  if (error) {
    opLog.error('bulk_book_transactions RPC error', error)
    return { ok: false, code: 'BULK_BOOK_RPC_FAILED', details: { message: getUserErrorMessage(error) } }
  }

  const result = data as RpcOk | RpcErr | null
  if (!result || !result.ok) {
    const code = (result as RpcErr | null)?.code ?? 'BULK_BOOK_RPC_FAILED'
    return { ok: false, code, details: (result as RpcErr | null)?.details }
  }

  // Complete matched inbox items against the samlingsverifikat. Best-effort.
  for (const txId of body.tx_ids) {
    await propagateUnderlagForBookedTransaction(supabase, companyId, txId, result.journal_entry_id)
  }

  // One transaction.reconciled event per row for existing subscribers.
  // Best-effort; a failure never rolls back the booking.
  const { data: linkedTxs } = await supabase
    .from('transactions')
    .select('*')
    .in('id', body.tx_ids)
    .eq('company_id', companyId)
  if (linkedTxs) {
    for (const tx of linkedTxs as Transaction[]) {
      try {
        await eventBus.emit({
          type: 'transaction.reconciled',
          payload: { transaction: tx, journalEntryId: result.journal_entry_id, method: 'manual', userId, companyId },
        })
      } catch (err) {
        opLog.warn('bulk_book transaction.reconciled emission failed', {
          err,
          txId: tx.id,
          journalEntryId: result.journal_entry_id,
        })
      }
    }
  }

  return {
    ok: true,
    data: {
      mode: result.mode,
      journal_entry_id: result.journal_entry_id,
      voucher_series: result.voucher_series,
      voucher_number: result.voucher_number,
      linked_tx_count: result.linked_tx_count,
      tx_sum: result.tx_sum,
      docs_linked: result.docs_linked,
    },
  }
}

/** btl_select: system templates, the company's own, and the user's teams'. */
async function templateVisible(
  ctx: OperationContext,
  tpl: { is_system: boolean | null; company_id: string | null; team_id: string | null },
): Promise<boolean> {
  if (tpl.is_system === true) return true
  if (tpl.company_id && tpl.company_id === ctx.companyId) return true
  if (!tpl.team_id) return false
  const { data: member } = await ctx.supabase
    .from('team_members')
    .select('team_id')
    .eq('team_id', tpl.team_id)
    .eq('user_id', ctx.userId)
    .limit(1)
  if ((member ?? []).length > 0) return true
  const { data: owned } = await ctx.supabase
    .from('teams')
    .select('id')
    .eq('id', tpl.team_id)
    .eq('created_by', ctx.userId)
    .limit(1)
  return (owned ?? []).length > 0
}
