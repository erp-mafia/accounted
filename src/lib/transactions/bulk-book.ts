/**
 * Bulk-book N bank transactions into one combined verifikat
 * (samlingsverifikation per BFL 5 kap 6 §), atomically through the
 * bulk_book_transactions RPC behind the engine door commitBulkBooking
 * (lib/bookkeeping/engine.ts, reached through the posting port's
 * commitSqlPosting), which also emits journal_entry.committed for a new
 * verifikat. Three paths, exactly one per call:
 *
 *   1. existing_journal_entry_id: link the rows to an already-posted voucher
 *      (no new entry; the voucher's bank net must equal the row sum, measured
 *      on the ledgers the rows settle on: all of 19xx for a row on a 19xx
 *      account, the ledger alone for a cash account kept elsewhere, such as
 *      a Stripe balance on 1686. bankNetAccountTest in
 *      lib/bookkeeping/bank-leg.ts states the rule the RPC applies);
 *   2. template_id + mode + entry_description: expand a booking template
 *      per row (one_line_per_tx) or on the sum (sum_per_account);
 *   3. manual_lines + entry_description: caller-built balanced lines.
 *
 * One implementation behind the dashboard route
 * (POST /api/transactions/bulk-book) and the operation transactions.bulk-book
 * (lib/operations/transactions.ts), which serves v1, the MCP tool
 * gnubok_bulk_book_transactions and its approval.
 *
 * Rows of several dates may only be linked to an existing verifikat (path
 * 1): one document, such as Stripe's monthly fee invoice, is settled by bank
 * rows of many days. A new samlingsverifikat (paths 2 and 3) needs one date.
 *
 * Rules before the RPC: every row belongs to the company; one currency, and
 * that currency SEK (the ledger columns are kronor and nothing here carries
 * a rate); the booking-time duplicate guard per row unless force=true (then
 * each dismissed candidate is recorded in behandlingshistorik); manual
 * lines only on active accounts of the company's chart; a template the
 * caller can see (system, the company's own, or a team the user belongs to:
 * the RLS rule, re-applied here because the v1 door runs as the service
 * role); the dimension policy (account rules and registry validation). The
 * RPC re-checks tenant scope, date, direction, balance, periods and
 * not-already-booked.
 *
 * A dry run runs every rule above, then the RPC's refusals the rows already
 * show (a booked or zero row, two dates, two directions, a link target that
 * is missing or not posted, manual lines that do not balance or carry an
 * empty line), and answers the lines the verifikat would carry, with the
 * account names. It writes nothing (no RPC, no events, no
 * behandlingshistorik).
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import type { z } from 'zod'
import type { BulkBookSchema } from '@/lib/api/schemas'
import type { Logger } from '@/lib/logger'
import type { OperationContext, OperationOutcome } from '@/lib/operations/types'
import type { BookingTemplateLibraryLine, Transaction } from '@/types'
import { applyTemplate, libraryLinesForCompanySkattekonto } from '@/lib/bookkeeping/template-library'
import type { SqlBusinessEventLink } from '@/lib/bookkeeping/business-event-link'
import { bulkBookedBankLineBusinessEvent } from '@/lib/bookkeeping/sql-posting-business-events'
import { linkBasisColumns } from '@/lib/links/stamp'
import { postingPort } from '@/lib/posting/port'
import {
  mergeDimensionBags,
  validateEntryDimensions,
  type DimensionAliasInput,
} from '@/lib/bookkeeping/dimension-resolver'
import {
  applyDimensionRules,
  assertMandatoryDimensions,
  fetchActiveDimensionRules,
} from '@/lib/bookkeeping/dimension-rules'
import { isBookkeepingError } from '@/lib/bookkeeping/errors'
import { propagateUnderlagForBookedTransaction } from '@/lib/transactions/inbox-underlag'
import {
  detectBookingDuplicate,
  type BookedDuplicateCandidate,
} from '@/lib/transactions/booking-duplicate-detection'
import { appendProcessingHistory } from '@/lib/processing-history/append'
import { getBASReference } from '@/lib/bookkeeping/bas-reference'
import { finalFromLines, recordDecisions, snapshotSuggestions } from '@/lib/suggestion-log/record'
import { duplicateCheck, passed, type DecisionCheck, type DuplicateVerdict } from '@/lib/suggestion-log/checks'
import { eventBus } from '@/lib/events/bus'
import { getErrorMessage as getUserErrorMessage } from '@/lib/errors/get-error-message'
import { getErrorEntry } from '@/lib/errors/structured-errors'
import { roundOre } from '@/lib/money'
import { formatCurrency } from '@/lib/utils'

/** The request every door validates (BulkBookSchema, the v1 and MCP contract). */
export type BulkBookInput = z.output<typeof BulkBookSchema>

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
  | 'id'
  | 'amount'
  | 'currency'
  | 'description'
  | 'merchant_name'
  | 'date'
  | 'amount_sek'
  | 'exchange_rate'
  | 'cash_account_id'
  | 'journal_entry_id'
  | 'external_id'
  | 'import_source'
  | 'bank_connection_id'
>

type Failure = Extract<OperationOutcome<never>, { ok: false }>

export async function bulkBookTransactions(
  ctx: OperationContext,
  body: BulkBookInput,
  /** via: which door honoured a force override, for behandlingshistorik. */
  options: { dryRun?: boolean; via?: string } = {},
): Promise<OperationOutcome<BulkBookResult>> {
  const { supabase, companyId, userId, log } = ctx
  const opLog = log.child({ txCount: body.tx_ids.length })

  // Manual lines the RPC would refuse, answered from the input alone.
  if (options.dryRun && body.manual_lines) {
    const lineRefusal = manualLinesRefusal(body.manual_lines)
    if (lineRefusal) return lineRefusal
  }

  // Fetch the selected rows once, for every path: the template branch needs
  // the amounts, every branch the currencies.
  const { data: txs, error: txError } = await supabase
    .from('transactions')
    .select('id, amount, currency, description, merchant_name, date, amount_sek, exchange_rate, cash_account_id, journal_entry_id, external_id, import_source, bank_connection_id')
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

  // The RPC's own refusals the rows already show, answered on the dry run so
  // a staged booking never waits for an approval that cannot post. The RPC
  // re-checks all of them under its row locks.
  if (options.dryRun) {
    const rowRefusal = rowShapeRefusal(body.tx_ids, txTyped, { linkExisting: !!body.existing_journal_entry_id })
    if (rowRefusal) return rowRefusal
  }

  // Booking-time duplicate guard, parity with /categorize and /book.
  const duplicate = await runBulkBookDuplicateGuard(
    supabase,
    companyId,
    userId,
    txTyped,
    {
      txIds: body.tx_ids,
      existingJournalEntryId: body.existing_journal_entry_id ?? null,
      force: body.force === true,
      recordDismissal: !options.dryRun,
      via: options.via ?? 'bulk_book_force',
    },
    opLog,
  )
  if (!duplicate.ok) {
    const dup = duplicate.details.candidate
    return {
      ok: false,
      code: duplicate.code,
      // Names the verifikat, so the approver and the dialog see which.
      messageSv: `${getErrorEntry(duplicate.code)?.message_sv ?? ''} (verifikat ${dup.voucher_label}, ${dup.entry_date})`.trim(),
      details: duplicate.details as unknown as Record<string, unknown>,
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

    // A system template's 1630 is the skattekonto: it books the company's
    // skattekonto account, 2012 for an enskild firma that runs it there
    // (PH 175). A company's own template keeps its author's accounts.
    const rawLines = (tpl.lines ?? []) as BookingTemplateLibraryLine[]
    const templateLines = tpl.is_system
      ? await libraryLinesForCompanySkattekonto(ctx.supabase, ctx.companyId, rawLines)
      : rawLines
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

  // Dimension policy: the RPC bypasses the TS engine, so it runs here.
  if (newEntryPayload) {
    try {
      newEntryPayload.lines = await enforceBulkBookDimensionPolicy(
        supabase,
        companyId,
        newEntryPayload.lines,
        opLog,
      )
    } catch (err) {
      // A BookkeepingError: the doors translate it verbatim.
      if (isBookkeepingError(err)) return { ok: false, code: 'UNKNOWN_ERROR', error: err }
      throw err
    }
  }

  if (options.dryRun) {
    // The link target: there, posted, and its date (the later of the two
    // dates is the one whose period must be open).
    let existingEntryDate: string | null = null
    if (body.existing_journal_entry_id) {
      const { data: je, error: jeError } = await supabase
        .from('journal_entries')
        .select('id, status, entry_date')
        .eq('id', body.existing_journal_entry_id)
        .eq('company_id', companyId)
        .maybeSingle()
      if (jeError) return { ok: false, code: 'UNKNOWN_ERROR', error: jeError }
      if (!je) return { ok: false, code: 'BULK_BOOK_VOUCHER_NOT_FOUND' }
      const entry = je as { status: string; entry_date: string }
      if (entry.status !== 'posted') {
        return { ok: false, code: 'BULK_BOOK_VOUCHER_NOT_POSTED', details: { status: entry.status } }
      }
      existingEntryDate = entry.entry_date
    }
    const txSum = roundOre(txTyped.reduce((s, t) => s + t.amount, 0))
    const first = txTyped.find((t) => t.id === body.tx_ids[0]) ?? txTyped[0]!
    // Rows of several dates (a link only): the earliest and the latest.
    const dates = Array.from(new Set(txTyped.map((t) => t.date))).sort()
    return {
      ok: true,
      dryRun: true,
      preview: {
        mode: body.existing_journal_entry_id ? 'link_existing' : 'create_new',
        tx_count: txTyped.length,
        tx_date: dates.length > 1 ? dates[0]! : first.date,
        ...(dates.length > 1 ? { tx_date_to: dates[dates.length - 1]! } : {}),
        direction: first.amount > 0 ? 'income' : 'expense',
        // The first row's counterparty text, for a title the approver recognises.
        lead_description: String(first.merchant_name || first.description || '').trim().slice(0, 40),
        // Signed SEK sum of the selected rows (this path is SEK-only).
        tx_sum: txSum,
        tx_sum_abs: Math.abs(txSum),
        currency,
        ...(body.existing_journal_entry_id
          ? { existing_journal_entry_id: body.existing_journal_entry_id, existing_entry_date: existingEntryDate }
          : {}),
        ...(newEntryPayload
          ? {
              entry_description: newEntryPayload.description,
              lines: await withAccountNames(supabase, companyId, newEntryPayload.lines),
            }
          : {}),
        ...(body.force ? { duplicate_guard: 'bypassed (force=true)' } : {}),
        note: 'The RPC re-checks date, direction, balance, period locks and not-already-booked at commit.',
      },
    }
  }

  // What was on offer for each row, taken before the booking.
  const suggestionSnapshot = await snapshotSuggestions(supabase, companyId, body.tx_ids)

  // The posting port (its SQL step): a new samlingsverifikat books every row
  // as its own business act, so one bank.categorized event per row, in the
  // order of tx_ids, which the RPC links to its draft before the number is
  // drawn. A link to a posted verifikat posts nothing and records nothing.
  // Off: nothing is built and the RPC is called as before.
  let businessEvents: SqlBusinessEventLink | undefined
  if (newEntryPayload) {
    const byId = new Map(txTyped.map((t) => [t.id, t]))
    const templateId = body.manual_lines ? null : (body.template_id ?? null)
    try {
      businessEvents = await postingPort.recordEventsForSql({
        supabase,
        companyId,
        events: () => {
          const linkBasis = linkBasisColumns('user_created')
          return body.tx_ids.map((id) => bulkBookedBankLineBusinessEvent(byId.get(id)!, { linkBasis, templateId }))
        },
      })
    } catch (err) {
      // strict: an event that could not be recorded stops the booking before any number.
      opLog.error('bulk_book business events not recorded (strict)', err)
      return { ok: false, code: 'BULK_BOOK_RPC_FAILED', details: { message: getUserErrorMessage(err) } }
    }
  }

  // The engine door, through the posting port: it also emits
  // journal_entry.committed for a new samlingsverifikat, which the RPC alone
  // never announces.
  const { data, error } = await postingPort.commitSqlPosting({
    supabase,
    companyId,
    userId,
    fn: 'bulk_book_transactions',
    args: [
      {
        txIds: body.tx_ids,
        existingJournalEntryId: body.existing_journal_entry_id ?? null,
        newEntry: newEntryPayload,
        commitMethod: 'bulk_accept',
        ...(businessEvents ? { businessEvents } : {}),
      },
    ],
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

  // One decision row per bank line, all pointing at the one verifikat.
  // Linking to an existing voucher posts no lines of its own.
  const postedLines = (newEntryPayload?.lines ?? []).map((l) => ({
    account: l.account_number,
    debit: l.debit_amount,
    credit: l.credit_amount,
  }))
  // The guards this door ran, here and inside the RPC (which refuses a
  // booked row, and for a new verifikat an unknown account or a locked
  // period); the duplicate verdict is each row's own.
  const checksFor = (txId: string): DecisionCheck[] => [
    passed('already_booked'),
    passed('currency'),
    duplicateCheck(duplicate.verdicts.get(txId) ?? { kind: 'clear' }),
    ...(newEntryPayload ? [passed('chart'), passed('dimension_policy'), passed('period_lock')] : []),
  ]
  await recordDecisions(
    supabase,
    suggestionSnapshot,
    body.tx_ids.map((txId) => ({
      transactionId: txId,
      final: finalFromLines(result.journal_entry_id, postedLines),
      checks: checksFor(txId),
    })),
    userId,
  )

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

/**
 * The first refusal the RPC would give that the selected rows already show:
 * a row with a verifikat, a zero row, two dates or two directions (BFL 5 kap
 * 6 § allows one gemensam verifikation only for likartade affärshändelser of
 * one day). Two dates are refused only for a new samlingsverifikat: a link to
 * an existing verifikat records which rows settle it, and one document can
 * be settled by rows of several days. Checked in the caller's order, like the
 * RPC's first offender.
 */
function rowShapeRefusal(
  txIds: string[],
  txs: SelectedTx[],
  opts: { linkExisting: boolean },
): Failure | null {
  const byId = new Map(txs.map((t) => [t.id, t]))
  const ordered = txIds.map((id) => byId.get(id)).filter((t): t is SelectedTx => t !== undefined)
  const booked = ordered.find((t) => t.journal_entry_id)
  if (booked) return { ok: false, code: 'BULK_BOOK_TX_ALREADY_BOOKED', details: { tx_id: booked.id } }
  const zero = ordered.find((t) => t.amount === 0)
  if (zero) return { ok: false, code: 'BULK_BOOK_TX_ZERO_AMOUNT', details: { tx_id: zero.id } }
  const firstDate = ordered[0]?.date
  const otherDate = opts.linkExisting ? undefined : ordered.find((t) => t.date !== firstDate)
  if (otherDate) {
    return { ok: false, code: 'BULK_BOOK_DATE_MISMATCH', details: { first_date: firstDate, other_date: otherDate.date } }
  }
  const expected = (ordered[0]?.amount ?? 0) > 0 ? 'income' : 'expense'
  const other = ordered.find((t) => (expected === 'income' ? t.amount < 0 : t.amount > 0))
  if (other) return { ok: false, code: 'BULK_BOOK_DIRECTION_MISMATCH', details: { expected, tx_id: other.id } }
  return null
}

/**
 * Manual lines that the RPC would refuse or that are no bokföringspost: a
 * line with neither a debit nor a credit (BFL 5 kap 6 §), or debits and
 * credits that do not balance (0.005 is float equalisation only; the RPC
 * enforces the öre).
 */
function manualLinesRefusal(lines: NonNullable<BulkBookInput['manual_lines']>): Failure | null {
  const empty = lines.findIndex((l) => roundOre(l.debit_amount) === 0 && roundOre(l.credit_amount) === 0)
  if (empty >= 0) {
    return {
      ok: false,
      code: 'VALIDATION_ERROR',
      messageSv: `manual_lines.${empty}: en verifikationsrad måste ha ett belopp i debet eller kredit (BFL 5 kap 6 §).`,
      details: { issues: [{ field: `manual_lines.${empty}`, message: 'debit_amount och credit_amount kan inte båda vara noll.' }] },
    }
  }
  const debit = roundOre(lines.reduce((s, l) => s + l.debit_amount, 0))
  const credit = roundOre(lines.reduce((s, l) => s + l.credit_amount, 0))
  if (Math.abs(debit - credit) > 0.005) {
    return {
      ok: false,
      code: 'BULK_BOOK_UNBALANCED',
      messageSv: `Verifikationen balanserar inte (${formatCurrency(debit)} debet vs ${formatCurrency(credit)} kredit).`,
      details: { total_debit: debit, total_credit: credit },
    }
  }
  return null
}

/**
 * The lines as the approver reads them: each account with its name from the
 * company's chart, else the BAS reference name. One chart read per voucher.
 */
async function withAccountNames(
  supabase: SupabaseClient,
  companyId: string,
  lines: ComputedLine[],
): Promise<Array<ComputedLine & { account_name: string | null }>> {
  const accountNumbers = Array.from(new Set(lines.map((l) => l.account_number)))
  const { data } = await supabase
    .from('chart_of_accounts')
    .select('account_number, account_name')
    .eq('company_id', companyId)
    .in('account_number', accountNumbers)
  const names = new Map(
    ((data ?? []) as Array<{ account_number: string; account_name: string | null }>).map((a) => [
      String(a.account_number),
      a.account_name ?? '',
    ]),
  )
  return lines.map((l) => ({
    ...l,
    account_name: names.get(l.account_number) ?? getBASReference(l.account_number)?.account_name ?? null,
  }))
}

/**
 * The dimension policy every bulk-book door runs on a new samlingsverifikat's
 * lines before bulk_book_transactions: the dashboard and v1 through
 * bulkBookTransactions above, the MCP tool at stage and its executor at
 * commit (rules may change and a value may be archived between the two). The
 * RPC inserts and commits in SQL and never passes through createDraftEntry or
 * commitEntry, so without this the MCP door skipped the rules and no door
 * checked the codes against the registry. Same layers, order and toggle
 * semantics as the engine:
 *   1. account dimension rules: default/fixed applied onto the bags (a
 *      failed rule fetch fails open, like the engine);
 *   2. registry validation (validateEntryDimensions: free for untagged
 *      lines, free text while dimensions_enabled is off, unknown or archived
 *      codes refused otherwise);
 *   3. 'required' rules asserted on the resulting bags.
 * The RPC books source_type 'manual', which the rule policy enforces, so no
 * exemption applies. Returns the lines with the rules applied (the same array
 * when nothing applies). Throws MandatoryDimensionMissingError or
 * DimensionValidationError, which every door already translates.
 */
export async function enforceBulkBookDimensionPolicy<
  T extends DimensionAliasInput & { account_number: string },
>(
  supabase: SupabaseClient,
  companyId: string,
  lines: T[],
  log?: Pick<Logger, 'warn'>,
): Promise<T[]> {
  const rules = await fetchActiveDimensionRules(supabase, companyId)
  if (rules === null) {
    log?.warn('dimension rule fetch failed: rules skipped (fail-open)', { companyId })
  }
  const ruled = rules && rules.length > 0 ? applyDimensionRules(lines, rules) : lines
  await validateEntryDimensions(supabase, companyId, ruled)
  if (rules && rules.length > 0) assertMandatoryDimensions(ruled, rules)
  return ruled
}

export type BulkBookDuplicateTx = Pick<
  Transaction,
  'id' | 'amount' | 'currency' | 'date' | 'amount_sek' | 'exchange_rate' | 'cash_account_id'
> &
  /** Provider identity: optional, a row without it is compared on content only. */
  Partial<Pick<Transaction, 'external_id' | 'import_source' | 'bank_connection_id'>>

export type BulkBookDuplicateGuardResult =
  /** verdicts: how the guard let each row through, for its decision's checks (empty on a dry-run force). */
  | { ok: true; verdicts: Map<string, DuplicateVerdict> }
  | {
      ok: false
      code: 'TRANSACTION_BOOK_POSSIBLE_DUPLICATE'
      details: { candidate: BookedDuplicateCandidate; transaction_id: string }
    }

/**
 * The booking-time duplicate guard every bulk-book door runs before
 * bulk_book_transactions: the dashboard and v1 through bulkBookTransactions
 * above, the MCP tool at stage and its executor at commit (another verifikat
 * may book the same bank line between the two). The RPC itself only refuses a
 * row that already has a verifikat, so without this a door could book a bank
 * line the ledger already books (a supplier invoice marked paid, a manual
 * voucher, a booked sibling row) a second time.
 *
 * The OTHER selected rows and the link-existing target are the batch's own,
 * so they never flag. Checked in txIds order so the flagged row is
 * deterministic; a detection failure never blocks. force=true skips the
 * refusal; with recordDismissal every dismissed candidate gets a durable
 * behandlingshistorik record (BFNAR 2013:2 kap 8), best-effort.
 */
export async function runBulkBookDuplicateGuard(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  txs: BulkBookDuplicateTx[],
  opts: {
    txIds: string[]
    existingJournalEntryId: string | null
    force: boolean
    recordDismissal: boolean
    via: string
  },
  log: Pick<Logger, 'warn' | 'error'>,
): Promise<BulkBookDuplicateGuardResult> {
  const txById = new Map(txs.map((tx) => [tx.id, tx]))
  const exclusions = {
    excludeTransactionIds: opts.txIds,
    excludeJournalEntryIds: opts.existingJournalEntryId ? [opts.existingJournalEntryId] : [],
  }
  const detectForTx = (tx: BulkBookDuplicateTx) =>
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
        // Two bookings of one provider feed under different ids are never
        // twins (crm#1271).
        external_id: tx.external_id ?? null,
        import_source: tx.import_source ?? null,
        bank_connection_id: tx.bank_connection_id ?? null,
      },
      exclusions,
    )
  const verdicts = new Map<string, DuplicateVerdict>()
  if (!opts.force) {
    for (const txId of opts.txIds) {
      const tx = txById.get(txId)
      if (!tx) continue
      let candidate = null
      try {
        candidate = await detectForTx(tx)
        verdicts.set(txId, { kind: 'clear' })
      } catch (err) {
        log.warn('bulk-book duplicate detection failed (continuing)', { err, txId })
        verdicts.set(txId, { kind: 'detection_failed' })
      }
      if (candidate) {
        return { ok: false, code: 'TRANSACTION_BOOK_POSSIBLE_DUPLICATE', details: { candidate, transaction_id: txId } }
      }
    }
    return { ok: true, verdicts }
  }
  if (!opts.recordDismissal) return { ok: true, verdicts }
  for (const txId of opts.txIds) {
    const tx = txById.get(txId)
    if (!tx) continue
    let dismissed: BookedDuplicateCandidate | null
    try {
      dismissed = await detectForTx(tx)
    } catch (err) {
      log.warn('bulk-book duplicate detection failed under force (continuing)', { err, txId })
      verdicts.set(txId, { kind: 'detection_failed' })
      continue
    }
    if (!dismissed) {
      verdicts.set(txId, { kind: 'clear' })
      continue
    }
    verdicts.set(txId, {
      kind: 'forced',
      journal_entry_id: dismissed.journal_entry_id ?? null,
      transaction_id: dismissed.transaction_id ?? null,
    })
    try {
      log.warn('bulk-book duplicate guard bypassed', {
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
          via: opts.via,
        },
        actor: { type: 'user', id: userId },
        occurredAt: new Date(),
      })
    } catch (err) {
      log.error('failed to append duplicate-dismissal behandlingshistorik', err as Error)
    }
  }
  return { ok: true, verdicts }
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
