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
 *      lib/bookkeeping/bank-leg.ts states the rule the RPC applies. The rows
 *      must also fit in what other rows leave of the voucher's bank leg,
 *      the single doors' rule (VOUCHER_BANK_LEG_CONSUMED,
 *      lib/transactions/voucher-bank-leg.ts), and every linked row records
 *      reconciliation_method 'manual' so it can be unlinked);
 *   2. template_id + mode + entry_description: expand a booking template
 *      per row (one_line_per_tx) or on the sum (sum_per_account);
 *   3. manual_lines + entry_description: caller-built balanced lines.
 *
 * One implementation behind the dashboard route
 * (POST /api/transactions/bulk-book) and the operation transactions.bulk-book
 * (lib/operations/transactions.ts), which serves v1, the MCP tool
 * gnubok_bulk_book_transactions and its approval.
 *
 * A row a booking review rule matches (accounted#130 step 2) is refused
 * for a new samlingsverifikat (BOOKING_REVIEW_BULK_REFUSED): a person books
 * it on its own from its review.
 *
 * Rows of several dates may only be linked to an existing verifikat (path
 * 1): one document, such as Stripe's monthly fee invoice, is settled by bank
 * rows of many days. A new samlingsverifikat (paths 2 and 3) needs one date.
 *
 * Rules before the RPC: every row belongs to the company; one currency, and
 * that currency SEK (the ledger columns are kronor and nothing here carries
 * a rate); the booking-time duplicate guard per row unless force=true (then
 * each dismissed candidate is recorded in behandlingshistorik); the lines of
 * a new verifikat (manual or from a template) only on accounts active in the
 * company's chart (chartCheck); a template the caller can see (system, the company's own, or a team the user
 * belongs to: the RLS rule, re-applied here because the v1 door runs as the
 * service role); the dimension policy (account rules and registry
 * validation). The RPC re-checks tenant scope, date, direction, balance,
 * bank net, periods and not-already-booked.
 *
 * A dry run runs every rule above, then the RPC's refusals the rows already
 * show (a booked or zero row, two dates, two directions, a link target that
 * is missing or not posted, manual lines that do not balance or carry an
 * empty line, a bank net that is not the rows' sum: bankNetMismatch), and
 * answers the lines the verifikat would carry, with the account names. It
 * writes nothing (no RPC, no events, no behandlingshistorik). Staging runs
 * the dry run, so an approval never meets a refusal the rows and lines
 * already showed (crm#1501). A transfer between two of the company's own
 * cash accounts is such a refusal: the bank net counts every 19xx line, so
 * its other end cancels the row's own; the refusal names the doors that
 * book it (categorize the row with the other account, link the other row).
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import type { z } from 'zod'
import type { BulkBookSchema } from '@/lib/api/schemas'
import type { Logger } from '@/lib/logger'
import type { OperationContext, OperationOutcome } from '@/lib/operations/types'
import type { BookingTemplateLibraryLine, Transaction } from '@/types'
import { applyTemplate, libraryLinesForCompanySkattekonto } from '@/lib/bookkeeping/template-library'
import { bankNetAccountTest, isCashLedger } from '@/lib/bookkeeping/bank-leg'
import { refuseImportVatWithoutBase } from '@/lib/bookkeeping/import-vat-base'
import { isGeneratedVatAccount } from '@/lib/bookkeeping/vat-entries'
import { resolveSettlementAccount } from '@/lib/bookkeeping/settlement-account'
import { coveredDayMessage, coveredFeedRows, isFeedConnectorRow } from '@/lib/bookkeeping/feed-row-coverage'
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
import { loadActiveBookingReviewRules } from '@/lib/booking-review/rules'
import { isPersonReview, matchBookingOfRows } from '@/lib/booking-review/check'
import { getActor } from '@/lib/bookkeeping/actor-context'
import { isBankMovementEntry } from '@/lib/transactions/bank-link'
import { readNamedBankRows } from '@/lib/transactions/is-booked'
import { propagateUnderlagForBookedTransaction } from '@/lib/transactions/inbox-underlag'
import { learnFromBankLink } from '@/lib/transactions/link-learning'
import {
  detectBookingDuplicate,
  type BookedDuplicateCandidate,
} from '@/lib/transactions/booking-duplicate-detection'
import { bankLegConsumedMessage } from '@/lib/transactions/voucher-bank-leg'
import { appendProcessingHistory } from '@/lib/processing-history/append'
import { getBASReference } from '@/lib/bookkeeping/bas-reference'
import { finalFromLines, recordDecisions, snapshotSuggestions } from '@/lib/suggestion-log/record'
import { duplicateCheck, passed, type DecisionCheck, type DuplicateVerdict } from '@/lib/suggestion-log/checks'
import { eventBus } from '@/lib/events/bus'
import { getErrorMessage as getUserErrorMessage } from '@/lib/errors/get-error-message'
import { getErrorEntry } from '@/lib/errors/structured-errors'
import { roundOre } from '@/lib/money'
import { lineBalance } from '@/lib/bookkeeping/line-balance'
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
  | 'original_description'
  | 'date'
  | 'amount_sek'
  | 'exchange_rate'
  | 'cash_account_id'
  | 'journal_entry_id'
  | 'external_id'
  | 'import_source'
  | 'bank_connection_id'
  | 'provider_transaction_id'
  | 'bank_file_import_id'
> & { is_ignored?: boolean | null; transaction_voucher_links?: Array<{ journal_entry_id: string }> | null }

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
    .select('id, amount, currency, description, merchant_name, original_description, date, amount_sek, exchange_rate, cash_account_id, journal_entry_id, is_ignored, external_id, import_source, bank_connection_id, provider_transaction_id, bank_file_import_id, transaction_voucher_links(journal_entry_id)')
    .in('id', body.tx_ids)
    .eq('company_id', companyId)

  if (txError || !txs) return { ok: false, code: 'BULK_BOOK_TXS_NOT_FOUND' }
  if (txs.length !== body.tx_ids.length) {
    // Which ids, so the caller can drop or correct them instead of guessing
    // ("One or more transactions not found" was all an agent was told).
    const found = new Set(txs.map((t) => t.id.toLowerCase()))
    const missing = [...new Set(body.tx_ids.filter((id) => !found.has(id.toLowerCase())))]
    return {
      ok: false,
      code: 'BULK_BOOK_TXS_NOT_FOUND',
      details: { expected: body.tx_ids.length, found: txs.length, missing_tx_ids: missing },
    }
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

  // An ignored row can carry no verifikat: one row fails on the row's CHECK
  // in the RPC, and several were booked through their links, still ignored.
  const ignored = txTyped.find((t) => t.is_ignored)
  if (ignored) return { ok: false, code: 'BANK_ROW_IGNORED', details: { tx_id: ignored.id } }

  // A new samlingsverifikat on a row a posted verifikat already books, though
  // no pointer or link says so (its claim never landed): the gate's answer
  // (lib/transactions/is-booked.ts). A link to an existing verifikat books
  // nothing new, and a pointer or link is the RPC's own refusal.
  if (!body.existing_journal_entry_id) {
    // In the caller's order, like the RPC's first offender; ids as stored.
    const rows = new Map(txTyped.map((t) => [t.id.toLowerCase(), t]))
    const open = [...new Set(body.tx_ids.map((id) => rows.get(id.toLowerCase())))]
      .filter((row) => row && !row.journal_entry_id && (row.transaction_voucher_links?.length ?? 0) === 0)
      .map((row) => row!.id)
    const named = await readNamedBankRows(supabase, companyId, open)
    if (named === 'read_error') return { ok: false, code: 'BANK_ROW_READ_FAILED' }
    const first = open.find((id) => named.has(id.toLowerCase()))
    if (first) {
      const booking = named.get(first.toLowerCase())!
      return {
        ok: false,
        code: 'BULK_BOOK_TX_ALREADY_BOOKED',
        details: { tx_id: first, via: 'named', journal_entry_id: booking.journalEntryId, voucher: booking.voucher },
      }
    }
  }

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

  // The ledger each row settles on, read once and only when needed.
  let ledgersRead: Promise<Map<string, string>> | null = null
  const rowLedgers = () => (ledgersRead ??= settlementLedgersByRow(supabase, companyId, txTyped, opLog))

  let newEntryPayload: { description: string; lines: ComputedLine[] } | null = null

  if (body.manual_lines && body.entry_description) {
    // The schema validated the account format; the RPC checks balance and
    // sides. Here: every account exists and is active in THIS company's chart.
    const chart = await chartCheck(supabase, companyId, body.manual_lines.map((l) => l.account_number), opLog)
    if (chart) return chart

    let isBusinessLine: (account: string) => boolean = () => false
    if (body.default_dimensions) {
      try {
        isBusinessLine = manualBusinessLineTest([...(await rowLedgers()).values()])
      } catch (err) {
        return { ok: false, code: 'UNKNOWN_ERROR', error: err }
      }
    }
    newEntryPayload = {
      description: body.entry_description,
      lines: body.manual_lines.map((l, i) => ({
        account_number: l.account_number,
        debit_amount: roundOre(l.debit_amount),
        credit_amount: roundOre(l.credit_amount),
        currency: l.currency,
        line_description: l.line_description,
        sort_order: i,
        // Dimensions PR7: per-line bag wins over the header default, which
        // tags the business lines only (crm#1313).
        dimensions: mergeDimensionBags(
          isBusinessLine(l.account_number) ? body.default_dimensions : undefined,
          l.dimensions,
        ),
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
    // applyTemplate answers one form line per template line, in order. The
    // header default tags the template's business lines only: its
    // settlement (bank) and moms lines stay untagged (crm#1313). A tag the
    // template sets on a business line wins over the header default, per key.
    const applied = (amount: number) =>
      applyTemplate(templateLines, amount).map((formLine, i) => ({
        formLine,
        dimensions: mergeDimensionBags(
          templateLines[i]?.type === 'business' ? body.default_dimensions : undefined,
          formLine.dimensions,
        ),
      }))

    if (body.mode === 'sum_per_account') {
      // One application at the summed amount: one line per template line.
      // Per-row detail stays recoverable via transaction_voucher_links.
      for (const { formLine, dimensions } of applied(totalAbs)) {
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
          dimensions,
        })
      }
    } else {
      // one_line_per_tx: the template per row, each line tagged with a short
      // row reference (BFL 5 kap 7 § motpart identification).
      for (const tx of txTyped) {
        for (const { formLine, dimensions } of applied(Math.abs(tx.amount))) {
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
            dimensions,
          })
        }
      }
    }
    // A template's accounts meet the manual lines' rule, here and not first
    // at approval, where the RPC refused an inactive one.
    const chart = await chartCheck(supabase, companyId, lines.map((l) => l.account_number), opLog)
    if (chart) return chart
    newEntryPayload = { description: body.entry_description, lines }
  }

  // A new samlingsverifikat over feed rows (Stripe) on days the books already
  // hold books that money twice (accounted#101); linking them to the existing
  // verifikat (existing_journal_entry_id) stays open. Bank rows are never read for.
  // One verifikat is all or nothing, so the whole call is refused; the answer
  // names every covered row, the day, what holds it, and the rows a retry may
  // carry (crm#1901: an agent was told none of it and probed day by day).
  if (newEntryPayload && txTyped.some(isFeedConnectorRow)) {
    const ledgers = await rowLedgers()
    const covered = await coveredFeedRows(supabase, companyId, txTyped, (id) => ledgers.get(id))
    if (covered.length > 0) {
      const coveredIds = new Set(covered.flatMap((c) => c.transaction_ids))
      const first = covered[0]!
      return {
        ok: false,
        code: 'BULK_BOOK_LEDGER_DAY_COVERED',
        messageSv: coveredDayMessage(covered, txTyped.length).sv,
        details: {
          // The first covered row, as before; coverage lists every one.
          transaction_id: first.transaction_ids[0],
          covered_through: first.covered_through,
          settlement_account: first.settlement_account,
          transaction_ids: [...coveredIds],
          uncovered_transaction_ids: txTyped.map((t) => t.id).filter((id) => !coveredIds.has(id)),
          coverage: covered,
        },
      }
    }
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

    // Importmoms with no ruta 50 line, as a company's own mall books it when
    // its fiktiv moms sits on 2615 (#83). The RPC does not know momsrutor,
    // so the rule runs here, in the dry run too.
    const importVat = await refuseImportVatWithoutBase(supabase, companyId, newEntryPayload.lines)
    if (importVat) {
      return { ok: false, code: importVat.code, details: importVat.details, messageSv: importVat.messageSv }
    }

    // Hard blocks (accounted#130 step 2): a row a booking review rule matches
    // is booked on its own, from its review, never in a samlingsverifikat.
    // Refused in the dry run too, so it is never staged; the RPC's
    // commit_journal_entry refuses it as well.
    const blockRules = await loadActiveBookingReviewRules(supabase, companyId)
    if (blockRules.length > 0) {
      const blocked: string[] = []
      for (const tx of txTyped) {
        const matched = await matchBookingOfRows(supabase, companyId, [tx], newEntryPayload.lines, blockRules)
        if (matched.length > 0) blocked.push(tx.id)
      }
      if (blocked.length > 0) return { ok: false, code: 'BOOKING_REVIEW_BULK_REFUSED', details: { transaction_ids: blocked } }
    }
  }

  // Hard blocks (accounted#130 step 2): linking rows to a posted verifikat
  // books them on its lines. A key, an agent or cron may not book a row a
  // booking review rule matches that way; a person linking in the app has
  // the verifikat in front of them.
  const linkActor = getActor()
  if (body.existing_journal_entry_id && !newEntryPayload && linkActor && !isPersonReview(linkActor)) {
    const blockRules = await loadActiveBookingReviewRules(supabase, companyId)
    if (blockRules.length > 0) {
      const { data: entryLines } = await supabase
        .from('journal_entry_lines')
        .select('account_number, debit_amount, credit_amount')
        .eq('journal_entry_id', body.existing_journal_entry_id)
      const lines = Array.isArray(entryLines) ? (entryLines as Array<{ account_number: string; debit_amount: number; credit_amount: number }>) : []
      const blocked: string[] = []
      for (const tx of txTyped) {
        if ((await matchBookingOfRows(supabase, companyId, [tx], lines, blockRules)).length > 0) blocked.push(tx.id)
      }
      if (blocked.length > 0) return { ok: false, code: 'BOOKING_REVIEW_BULK_REFUSED', details: { transaction_ids: blocked } }
    }
  }

  if (options.dryRun) {
    // The link target: there, posted, and its date (the later of the two
    // dates is the one whose period must be open).
    let existingEntryDate: string | null = null
    // The lines whose bank net the RPC measures: the new verifikat's, or the
    // posted one's the rows link to.
    let bankNetLines: ReadonlyArray<Parameters<typeof bankNetMismatch>[1][number]> = newEntryPayload?.lines ?? []
    if (body.existing_journal_entry_id) {
      const { data: je, error: jeError } = await supabase
        .from('journal_entries')
        .select('id, status, entry_date, source_type, journal_entry_lines(account_number, debit_amount, credit_amount)')
        .eq('id', body.existing_journal_entry_id)
        .eq('company_id', companyId)
        .maybeSingle()
      if (jeError) return { ok: false, code: 'UNKNOWN_ERROR', error: jeError }
      if (!je) return { ok: false, code: 'BULK_BOOK_VOUCHER_NOT_FOUND' }
      const entry = je as {
        status: string
        entry_date: string
        source_type?: string | null
        journal_entry_lines?: Parameters<typeof bankNetMismatch>[1] | null
      }
      if (entry.status !== 'posted') {
        return { ok: false, code: 'BULK_BOOK_VOUCHER_NOT_POSTED', details: { status: entry.status } }
      }
      // As on the other link doors: the database refuses this write too.
      if (!isBankMovementEntry(entry)) {
        return { ok: false, code: 'LINK_TX_JE_NOT_BANK_MOVEMENT', details: { source_type: entry.source_type } }
      }
      existingEntryDate = entry.entry_date
      bankNetLines = entry.journal_entry_lines ?? []
    }
    // The RPC's bank net, asked here so staging refuses what the approval
    // could never post (crm#1501: a clean preview, then a refusal at commit).
    let ledgerByRow: Map<string, string>
    try {
      ledgerByRow = await rowLedgers()
    } catch (err) {
      return { ok: false, code: 'UNKNOWN_ERROR', error: err }
    }
    const bankRows = txTyped.map((t) => ({ ledger: ledgerByRow.get(t.id)!, amount: t.amount }))
    const mismatch = bankNetMismatch(bankRows, bankNetLines)
    if (mismatch) return bankNetRefusal(mismatch, bankRows.map((r) => r.ledger), !!body.existing_journal_entry_id)
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
    const details = (result as RpcErr | null)?.details
    if (code === 'VOUCHER_BANK_LEG_CONSUMED' && details) {
      // Other rows already hold the verifikat's bank leg (GitHub #3507): the
      // single doors' code, with their message naming the verifikat.
      return { ok: false, code, messageSv: bankLegConsumedRefusal(details, body.tx_ids.length), details }
    }
    return { ok: false, code, details }
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

  // One row linked onto a verifikat the caller named teaches its bank text
  // from it at once (crm#1746). Several rows on one verifikat are a
  // samlingsverifikat, which teaches nothing. Never fails the booking:
  // learnFromBankLink logs and returns.
  if (body.existing_journal_entry_id && body.tx_ids.length === 1) {
    await learnFromBankLink(
      supabase,
      companyId,
      { transactionId: body.tx_ids[0], journalEntryId: result.journal_entry_id },
      'explicit',
    )
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
 * The Swedish message for the RPC's VOUCHER_BANK_LEG_CONSUMED, from its
 * details (the verifikat, the ledger, the rows' sum and what the leg books,
 * holds and has left): the wording of the single doors.
 */
function bankLegConsumedRefusal(details: Record<string, unknown>, rowCount: number): string {
  const num = (v: unknown): number | null => {
    const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN
    return Number.isFinite(n) ? roundOre(n) : null
  }
  const series = typeof details.voucher_series === 'string' ? details.voucher_series : 'A'
  const number = num(details.voucher_number)
  return bankLegConsumedMessage({
    voucherLabel: number !== null ? `${series}-${number}` : String(details.journal_entry_id ?? ''),
    accountNumber: String(details.account ?? ''),
    amount: num(details.tx_sum) ?? 0,
    verdict: { fits: false, booked: num(details.booked), held: num(details.held) ?? 0, remaining: num(details.remaining) },
    rowCount,
  })
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
  // The RPC refuses a voucher link of any role, on a row with no pointer.
  const linked = ordered.find((t) => (t.transaction_voucher_links?.length ?? 0) > 0)
  if (linked) {
    return { ok: false, code: 'BULK_BOOK_TX_ALREADY_BOOKED', details: { tx_id: linked.id, via: 'transaction_voucher_links' } }
  }
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
  const { balanced, totalDebit, totalCredit } = lineBalance(lines)
  if (!balanced) {
    return {
      ok: false,
      code: 'BULK_BOOK_UNBALANCED',
      messageSv: `Verifikationen balanserar inte (${formatCurrency(totalDebit)} debet vs ${formatCurrency(totalCredit)} kredit).`,
      details: { total_debit: totalDebit, total_credit: totalCredit },
    }
  }
  return null
}

/**
 * Which manual lines the header default_dimensions tag: the business lines,
 * that is every line except the bank side and the moms lines. The rule
 * categorize books by (buildTransactionEntryLines in
 * lib/bookkeeping/transaction-entries.ts) and the template path above
 * (its settlement and vat lines): a project or cost centre belongs to the
 * cost or revenue, never to the settlement of the bank rows or to the moms
 * on them (crm#1313). The bank side is the one bulk_book_transactions
 * measures its bank net on (bankNetAccountTest over the rows' settlement
 * ledgers), so a Stripe balance on 1686 is recognised as well as 1930. A
 * line's own bag is the caller's explicit choice and is never filtered.
 * The moms lines are told apart the way a proposal's are
 * (isGeneratedVatAccount).
 */
function manualBusinessLineTest(ledgers: string[]): (account: string) => boolean {
  const isBankSide = bankNetAccountTest(ledgers)
  return (account) => !isBankSide(account) && !isGeneratedVatAccount(account)
}

/**
 * The ledger each selected row settles on, by row id: its cash account's
 * ledger, or for a row without one the company's only enabled account in
 * its currency, else 1930 (resolveSettlementAccount, the answer
 * capture_bank_booking_context gives the RPC). One read per cash account.
 * Throws on a failed cash account lookup (nothing is written yet).
 */
async function settlementLedgersByRow(
  supabase: SupabaseClient,
  companyId: string,
  txs: SelectedTx[],
  log: Logger,
): Promise<Map<string, string>> {
  const cashAccountIds = Array.from(new Set(txs.map((t) => t.cash_account_id ?? null)))
  const ledgers = await Promise.all(
    cashAccountIds.map((id) => resolveSettlementAccount(supabase, companyId, id, log)),
  )
  const byCashAccount = new Map(cashAccountIds.map((id, i) => [id, ledgers[i]!]))
  return new Map(txs.map((t) => [t.id, byCashAccount.get(t.cash_account_id ?? null)!]))
}

/** A bank net the RPC refuses: the rows' sum against what the lines move on their ledgers. */
export interface BankNetMismatch {
  tx_sum: number
  lines_bank_net: number
  /** The first ledger, in account order, that does not move by its own rows' sum. */
  account?: string
  account_tx_sum?: number
  account_net?: number
  /**
   * A transfer between own cash accounts: every row's own ledger moves by
   * its rows' sum, and these other 19xx accounts move too. The RPC counts
   * them into the bank net (the whole 1900-1999 range), so it refuses.
   */
  transfer_accounts?: string[]
}

/**
 * The bank net bulk_book_transactions measures before it posts a new
 * verifikat or links rows to a posted one: the lines on the rows' ledgers
 * (bankNetAccountTest) must move by the rows' signed sum
 * (BULK_BOOK_AMOUNT_MISMATCH), and each ledger by its own rows' sum
 * (BANK_BOOKING_SETTLEMENT_CHANGED). The dry run, which staging runs, asks
 * this so nothing reaches an approval that the RPC refuses at commit
 * (crm#1501). Pure; null when the lines pass.
 */
export function bankNetMismatch(
  rows: ReadonlyArray<{ ledger: string; amount: number }>,
  lines: ReadonlyArray<{ account_number: string; debit_amount: number | string; credit_amount: number | string }>,
): BankNetMismatch | null {
  const net = (test: (account: string) => boolean) =>
    roundOre(
      lines
        .filter((l) => test(String(l.account_number)))
        .reduce((s, l) => s + Number(l.debit_amount) - Number(l.credit_amount), 0),
    )
  const txSum = roundOre(rows.reduce((s, r) => s + r.amount, 0))
  const linesBankNet = net(bankNetAccountTest(rows.map((r) => r.ledger)))
  const base = { tx_sum: txSum, lines_bank_net: linesBankNet }
  const ledgers = Array.from(new Set(rows.map((r) => r.ledger))).sort()
  const offLedger = ledgers.flatMap((ledger) => {
    const ledgerSum = roundOre(rows.filter((r) => r.ledger === ledger).reduce((s, r) => s + r.amount, 0))
    const ledgerNet = net((account) => account === ledger)
    return Math.abs(ledgerNet - ledgerSum) > 0.005 ? [{ account: ledger, account_tx_sum: ledgerSum, account_net: ledgerNet }] : []
  })
  if (Math.abs(linesBankNet - txSum) > 0.005) {
    if (offLedger.length > 0) return { ...base, ...offLedger[0]! }
    // Each ledger moves by its own rows: what is left is another of the
    // company's cash accounts, the other end of a transfer.
    const transfer = Array.from(
      new Set(
        lines
          .map((l) => String(l.account_number))
          .filter((a) => isCashLedger(a) && !ledgers.includes(a)),
      ),
    ).sort()
    return transfer.length > 0 ? { ...base, transfer_accounts: transfer } : base
  }
  return offLedger.length > 0 ? { ...base, ...offLedger[0]! } : null
}

/**
 * The Swedish refusal for a bank net mismatch: naming the account and both
 * amounts, or for a transfer between own cash accounts the two doors that
 * book it (crm#1501: categorize the row with the other account as
 * motkonto, then link the other account's row to that verifikat).
 */
function bankNetRefusal(mismatch: BankNetMismatch, ledgers: string[], linkExisting: boolean): Failure {
  const bankAccounts = Array.from(new Set(ledgers)).sort()
  const details = { ...mismatch, bank_accounts: bankAccounts, ...(linkExisting ? { link_existing: true } : {}) }
  if (mismatch.transfer_accounts) {
    const own = bankAccounts.join(', ')
    const other = mismatch.transfer_accounts.join(', ')
    return {
      ok: false,
      code: 'BULK_BOOK_AMOUNT_MISMATCH',
      messageSv: linkExisting
        ? `Verifikationen är en överföring mellan egna konton (${own} och ${other}), som samlingskopplingen inte tar. ` +
          'Koppla raden till verifikationen en och en (link_transaction_to_journal_entry).'
        : `En överföring mellan egna konton (${own} och ${other}) kan inte bokföras som samlingsverifikation. ` +
          `Bokför raden på ${own} med motkonto ${other} (categorize_transaction med account_override ${other}) ` +
          `och koppla sedan raden på ${other} till samma verifikation (link_transaction_to_journal_entry).`,
      details,
    }
  }
  const account = mismatch.account ?? bankAccounts.join(', ')
  const expected = mismatch.account_tx_sum ?? mismatch.tx_sum
  const moved = mismatch.account_net ?? mismatch.lines_bank_net
  return {
    ok: false,
    code: 'BULK_BOOK_AMOUNT_MISMATCH',
    messageSv:
      `Verifikationen ska röra bankradernas konto ${account} med ${formatCurrency(expected)}, ` +
      `men raderna rör det med ${formatCurrency(moved)}.`,
    details,
  }
}

/**
 * The accounts of a new verifikat's lines (manual or from a template) must
 * be active in the company's chart: the RPC refuses any other with
 * BULK_BOOK_INVALID_ACCOUNT at commit, so staging refuses it first, saying
 * which are deactivated and which are not in the chart at all. One chart
 * read; null when every account is active.
 */
async function chartCheck(
  supabase: SupabaseClient,
  companyId: string,
  accounts: string[],
  log: Logger,
): Promise<Failure | null> {
  const accountNumbers = Array.from(new Set(accounts))
  const { data, error } = await supabase
    .from('chart_of_accounts')
    .select('account_number, is_active')
    .eq('company_id', companyId)
    .in('account_number', accountNumbers)
  if (error) {
    log.error('chart_of_accounts lookup failed', error)
    return { ok: false, code: 'BULK_BOOK_RPC_FAILED', details: { message: getUserErrorMessage(error) } }
  }
  const inChart = new Map(
    ((data ?? []) as Array<{ account_number: string; is_active?: boolean | null }>).map((a) => [
      String(a.account_number),
      a.is_active !== false,
    ]),
  )
  const inactive = accountNumbers.filter((n) => inChart.get(n) === false)
  const missing = accountNumbers.filter((n) => !inChart.has(n))
  const invalid = [...inactive, ...missing].sort()
  if (invalid.length === 0) return null
  return {
    ok: false,
    code: 'BULK_BOOK_INVALID_ACCOUNT',
    details: {
      invalid_accounts: invalid,
      ...(inactive.length > 0 ? { inactive_accounts: inactive } : {}),
      ...(missing.length > 0 ? { not_in_chart: missing } : {}),
    },
  }
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
  Partial<Pick<Transaction, 'external_id' | 'import_source' | 'bank_connection_id' | 'provider_transaction_id' | 'bank_file_import_id'>>

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
        // Two entries of one feed the ids tell apart are never twins
        // (crm#1271; crm#1312: a second Swish batch of the same price).
        external_id: tx.external_id ?? null,
        import_source: tx.import_source ?? null,
        bank_connection_id: tx.bank_connection_id ?? null,
        provider_transaction_id: tx.provider_transaction_id ?? null,
        bank_file_import_id: tx.bank_file_import_id ?? null,
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
