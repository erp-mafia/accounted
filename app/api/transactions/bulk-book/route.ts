import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { BulkBookSchema } from '@/lib/api/schemas'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { applyTemplate } from '@/lib/bookkeeping/template-library'
import { mergeDimensionBags } from '@/lib/bookkeeping/dimension-resolver'
import {
  applyDimensionRules,
  assertMandatoryDimensions,
  fetchActiveDimensionRules,
} from '@/lib/bookkeeping/dimension-rules'
import { bookkeepingErrorResponse } from '@/lib/bookkeeping/errors'
import { propagateUnderlagForBookedTransaction } from '@/lib/transactions/inbox-underlag'
import { detectBookingDuplicate } from '@/lib/transactions/booking-duplicate-detection'
import { appendProcessingHistory } from '@/lib/processing-history/append'
import { eventBus } from '@/lib/events/bus'
import { ensureInitialized } from '@/lib/init'
import type { BookingTemplateLibraryLine, Transaction } from '@/types'
import { getErrorMessage as getUserErrorMessage } from '@/lib/errors/get-error-message'

ensureInitialized()

interface RpcOk {
  ok: true
  mode: 'link_existing' | 'create_new'
  journal_entry_id: string
  voucher_series: string | null
  voucher_number: number | null
  linked_tx_count: number
  tx_sum: number
  docs_linked: number
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
  // Dimensions PR7: bag persisted by the RPC onto journal_entry_lines
  // (with cost_center/project mirrors derived server-side).
  dimensions?: Record<string, string>
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

/**
 * POST /api/transactions/bulk-book
 *
 * Bulk-book N bank transactions on the same date into one combined
 * verifikat (samlingsverifikation per BFL 5 kap 6§). Two flows:
 *
 *  1. Link to existing voucher: { tx_ids, existing_journal_entry_id }.
 *     No new JE; the RPC just inserts N transaction_voucher_links rows.
 *
 *  2. Create new from template: { tx_ids, template_id, mode,
 *     entry_description }. The route fetches the template, expands it
 *     per the chosen mode, and passes the resulting balanced lines to
 *     the RPC. The RPC then commits the verifikat atomically.
 *
 * `applyTemplate` lives in TS (ratio / VAT math); the RPC stays focused
 * on locking, balance, and link insertion.
 */
export const POST = withRouteContext(
  'transaction.bulk_book',
  async (request, ctx) => {
    const { user, supabase, companyId, log, requestId } = ctx

    const validation = await validateBody(request, BulkBookSchema, {
      log,
      operation: 'transaction.bulk_book',
    })
    if (!validation.success) return validation.response
    const body = validation.data

    const opLog = log.child({ txCount: body.tx_ids.length })

    // Fetch the selected txs ONCE, up front, for every path. The template
    // branch needs the amounts to expand the template; all three branches
    // need the currencies for the homogeneity gate below.
    const { data: txs, error: txError } = await supabase
      .from('transactions')
      .select('id, amount, currency, description, date, amount_sek, exchange_rate, cash_account_id')
      .in('id', body.tx_ids)
      .eq('company_id', companyId)

    if (txError || !txs || txs.length === 0) {
      return errorResponseFromCode('BULK_BOOK_TXS_NOT_FOUND', opLog, { requestId })
    }
    if (txs.length !== body.tx_ids.length) {
      return errorResponseFromCode('BULK_BOOK_TXS_NOT_FOUND', opLog, {
        requestId,
        details: { expected: body.tx_ids.length, found: txs.length },
      })
    }

    const txTyped = txs as Pick<
      Transaction,
      'id' | 'amount' | 'currency' | 'description' | 'date' | 'amount_sek' | 'exchange_rate' | 'cash_account_id'
    >[]

    // Currency homogeneity, enforced BEFORE the branch split so it covers
    // all three paths (template, manual_lines, existing_journal_entry_id).
    // BFL 4 kap 6 § requires the bokföring to be presented in one and the
    // same redovisningsvaluta. A samlingsverifikation mixing e.g. SEK and
    // EUR has no representable single belopp: summing the raw amounts adds
    // 100 EUR to 100 SEK as if they were one unit, and the verifikat would
    // then state an amount matching no affärshändelse (BFL 5 kap 7 §
    // "belopp"). Nothing the caller can pass makes that correct without
    // per-tx FX rates, so this refuses instead of warning. Mirrors the MCP
    // twin (gnubok_bulk_book_transactions), which guards the same three
    // paths; cross-currency batches belong in the FX-aware batch-allocate
    // flow (kursdifferens on 7960/3960).
    // NULL currency is legacy for the column default 'SEK' (the codebase
    // reads it that way everywhere), so it is normalized before comparison:
    // a NULL/SEK selection is not a currency mix and must stay bookable.
    const currencies = new Set(txTyped.map((t) => t.currency ?? 'SEK'))
    if (currencies.size > 1) {
      return errorResponseFromCode('BULK_BOOK_MIXED_CURRENCY', opLog, {
        requestId,
        details: { currencies: Array.from(currencies).sort() },
      })
    }
    const currency = txTyped[0]!.currency ?? 'SEK'

    // A HOMOGENEOUS foreign batch is refused too: the RPC writes the line
    // amounts into journal_entry_lines.debit_amount/credit_amount, which are
    // ALWAYS kronor, and neither the route nor the RPC carries an exchange
    // rate here. Two EUR transactions of 100 + 200 would produce a verifikat
    // whose 300 is read as kronor by balansräkning, momsdeklaration and SIE
    // export. Foreign-currency transactions are booked individually through
    // the FX-aware flows, which resolve a rate and book the kursdifferens.
    // The RPC enforces the same refusal for callers that bypass this route.
    if (currency !== 'SEK') {
      return errorResponseFromCode('BULK_BOOK_FOREIGN_CURRENCY', opLog, {
        requestId,
        details: { currency },
      })
    }

    // Booking-time duplicate guard, parity with /categorize and /book: each
    // selected tx is about to be anchored to a verifikat, and a twin already
    // in the ledger means one affärshändelse gets booked twice (felaktig
    // bokföring per BFL). Per-tx detection with intra-batch exclusions: the
    // OTHER selected txs are distinct events the user explicitly picked, and
    // the link-existing target voucher is the batch's own destination, so
    // neither may flag. Checked in tx_ids order so the flagged tx is
    // deterministic. Soft guard: the caller re-runs with force=true after the
    // user reviews the candidate; detection failures never block a booking.
    const txById = new Map(txTyped.map((tx) => [tx.id, tx]))
    const duplicateExclusions = {
      excludeTransactionIds: body.tx_ids,
      excludeJournalEntryIds: body.existing_journal_entry_id ? [body.existing_journal_entry_id] : [],
    }
    const detectForTx = (tx: (typeof txTyped)[number]) =>
      detectBookingDuplicate(
        supabase,
        companyId!,
        {
          id: tx.id,
          date: tx.date,
          // `amount` is denominated in `currency`; the guard's FX contract
          // needs the row's own conversion fields alongside.
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
          return errorResponseFromCode('TRANSACTION_BOOK_POSSIBLE_DUPLICATE', opLog, {
            requestId,
            details: { candidate, transaction_id: txId },
          })
        }
      }
    } else {
      // force=true bypassed the guard. Booking over a DETECTED possible
      // double-booking is a bookkeeping decision that needs a durable
      // behandlingshistorik record (BFNAR 2013:2 kap 8), parity with the
      // /categorize and agent bypass paths. Best-effort; never blocks.
      for (const txId of body.tx_ids) {
        const tx = txById.get(txId)
        if (!tx) continue
        try {
          const dismissed = await detectForTx(tx)
          if (!dismissed) continue
          opLog.warn('bulk-book duplicate guard bypassed', {
            reason: 'force=true',
            requestId,
            txId,
            dismissedJournalEntryId: dismissed.journal_entry_id,
          })
          await appendProcessingHistory({
            companyId: companyId!,
            correlationId: txId,
            aggregateType: 'BankTransaction',
            aggregateId: txId,
            eventType: 'BankTransactionDuplicateDismissed',
            payload: {
              transaction_id: txId,
              dismissed_transaction_id: dismissed.transaction_id,
              dismissed_journal_entry_id: dismissed.journal_entry_id,
              // Null when the candidate's SEK value could not be established;
              // the foreign figures below then carry the durable record.
              amount_ore: dismissed.amount != null ? Math.round(dismissed.amount * 100) : null,
              dismissed_currency: dismissed.currency,
              dismissed_amount_in_currency: dismissed.amount_in_currency,
              entry_date: dismissed.entry_date,
              amount_verified: dismissed.amount_verified,
              unverified_reason: dismissed.unverified_reason,
              via: 'bulk_book_force',
            },
            actor: { type: 'user', id: user.id },
            occurredAt: new Date(),
          })
        } catch (err) {
          opLog.error('failed to append duplicate-dismissal behandlingshistorik', err as Error)
        }
      }
    }

    // Three paths now (PR #608):
    //   1. existing_journal_entry_id → null new_entry, RPC links txs to JE.
    //   2. template_id → route expands template per mode, builds lines.
    //   3. manual_lines → caller-built lines pass straight through.
    let newEntryPayload: { description: string; lines: ComputedLine[] } | null = null

    if (body.manual_lines && body.entry_description) {
      // Manual mode. The Zod schema validated the 4-digit format; the
      // RPC's balance + bank-leg + negative-amount + both-sides-nonzero
      // guards still run downstream. What's missing is verifying the
      // account_numbers exist in this company's chart_of_accounts:
      // without it a typo or adversarial caller could post to a BAS
      // account that doesn't exist, corrupting the hauptbok and
      // breaking SIE export. Single roundtrip allowlist check.
      const accountNumbers = Array.from(
        new Set(body.manual_lines.map((l) => l.account_number)),
      )
      const { data: knownAccounts, error: accountsError } = await supabase
        .from('chart_of_accounts')
        .select('account_number')
        .eq('company_id', companyId)
        .eq('is_active', true)
        .in('account_number', accountNumbers)
      if (accountsError) {
        opLog.error('chart_of_accounts lookup failed', accountsError)
        return errorResponseFromCode('BULK_BOOK_RPC_FAILED', opLog, {
          requestId,
          details: { message: getUserErrorMessage(accountsError) },
        })
      }
      const validSet = new Set(
        (knownAccounts ?? []).map((a: { account_number: string }) => a.account_number),
      )
      const invalid = accountNumbers.filter((n) => !validSet.has(n))
      if (invalid.length > 0) {
        return errorResponseFromCode('BULK_BOOK_INVALID_ACCOUNT', opLog, {
          requestId,
          details: { invalid_accounts: invalid },
        })
      }
      newEntryPayload = {
        description: body.entry_description,
        lines: body.manual_lines.map((l, i) => ({
          account_number: l.account_number,
          debit_amount: round2(l.debit_amount),
          credit_amount: round2(l.credit_amount),
          currency: l.currency,
          line_description: l.line_description,
          sort_order: i,
          // Dimensions PR7: per-line bag wins over the header default.
          dimensions: mergeDimensionBags(body.default_dimensions, l.dimensions),
        })),
      }
    } else if (body.template_id && body.mode && body.entry_description) {
      // Fetch the template. RLS scopes to user's companies + system templates,
      // so we don't need a company_id filter here.
      const { data: template, error: templateError } = await supabase
        .from('booking_template_library')
        .select('id, name, lines, is_active')
        .eq('id', body.template_id)
        .single()

      if (templateError || !template) {
        return errorResponseFromCode('BULK_BOOK_TEMPLATE_NOT_FOUND', opLog, { requestId })
      }
      if (!template.is_active) {
        return errorResponseFromCode('BULK_BOOK_TEMPLATE_NOT_FOUND', opLog, {
          requestId,
          details: { reason: 'template_inactive' },
        })
      }

      const templateLines = (template.lines ?? []) as BookingTemplateLibraryLine[]

      // The tx rows (amount + currency) were fetched and currency-gated
      // above; the RPC still re-validates date, direction, and
      // not-already-booked.
      const txAbsAmounts = txTyped.map((t) => Math.abs(t.amount))
      const totalAbs = round2(txAbsAmounts.reduce((s, a) => s + a, 0))

      const lines: ComputedLine[] = []
      let sortOrder = 0

      if (body.mode === 'sum_per_account') {
        // One application of the template at the summed amount → one line
        // per template line. Compact verifikat; per-tx detail recoverable
        // via transaction_voucher_links.
        const applied = applyTemplate(templateLines, totalAbs)
        for (const formLine of applied) {
          const debit = parseFloat(formLine.debit_amount || '0') || 0
          const credit = parseFloat(formLine.credit_amount || '0') || 0
          if (debit === 0 && credit === 0) continue
          lines.push({
            account_number: formLine.account_number,
            debit_amount: round2(debit),
            credit_amount: round2(credit),
            currency,
            line_description: formLine.line_description || undefined,
            sort_order: sortOrder++,
            // Dimensions PR7: header default applies to all template lines.
            dimensions: body.default_dimensions,
          })
        }
      } else {
        // one_line_per_tx: apply template per tx, prefix description with
        // a short tx reference so the verifikat preserves per-row audit
        // detail (BFL 5 kap 7§ motpart identification).
        for (const tx of txTyped) {
          const applied = applyTemplate(templateLines, Math.abs(tx.amount))
          for (const formLine of applied) {
            const debit = parseFloat(formLine.debit_amount || '0') || 0
            const credit = parseFloat(formLine.credit_amount || '0') || 0
            if (debit === 0 && credit === 0) continue
            const txTag = (tx.description || '').slice(0, 40).trim()
            lines.push({
              account_number: formLine.account_number,
              debit_amount: round2(debit),
              credit_amount: round2(credit),
              currency,
              line_description: txTag
                ? `${formLine.line_description ?? ''}: ${txTag}`.trim()
                : formLine.line_description || undefined,
              sort_order: sortOrder++,
              // Dimensions PR7: header default applies to all template lines.
              dimensions: body.default_dimensions,
            })
          }
        }
      }

      newEntryPayload = {
        description: body.entry_description,
        lines,
      }
    }

    // Account dimension rules (dimensions PR10): the bulk-book RPC bypasses
    // the TS engine, so the policy layer runs here — defaults/fixed applied
    // to the computed lines, then 'required' asserted. Zero rules (the
    // default) or a failed fetch changes nothing (fail-open, same posture as
    // the engine).
    if (newEntryPayload) {
      const rules = await fetchActiveDimensionRules(supabase, companyId!)
      if (rules === null) {
        opLog.warn('dimension rule fetch failed — policy skipped (fail-open)')
      }
      if (rules && rules.length > 0) {
        newEntryPayload.lines = applyDimensionRules(newEntryPayload.lines, rules)
        try {
          assertMandatoryDimensions(newEntryPayload.lines, rules)
        } catch (err) {
          const mapped = bookkeepingErrorResponse(err)
          if (mapped) return mapped
          throw err
        }
      }
    }

    // p_user_id removed in PR #608 (round-3 hardening pattern applied
    // consistently). RPC resolves the caller via auth.uid().
    const { data, error } = await supabase.rpc('bulk_book_transactions', {
      p_tx_ids: body.tx_ids,
      p_existing_journal_entry_id: body.existing_journal_entry_id ?? null,
      p_new_entry: newEntryPayload,
      p_company_id: companyId,
    })

    if (error) {
      opLog.error('bulk_book_transactions RPC error', error)
      return errorResponseFromCode('BULK_BOOK_RPC_FAILED', opLog, {
        requestId,
        details: { message: getUserErrorMessage(error) },
      })
    }

    const result = data as RpcOk | RpcErr | null
    if (!result || !result.ok) {
      const code = (result as RpcErr | null)?.code ?? 'BULK_BOOK_RPC_FAILED'
      const details = (result as RpcErr | null)?.details
      return errorResponseFromCode(code, opLog, { requestId, details })
    }

    // Complete any matched inbox items against the samlingsverifikat: link
    // their underlag and stamp them consumed so they leave the active inbox.
    // Best-effort, logged inside; created_journal_entry_id is UNIQUE so at
    // most one item can carry the stamp; the inbox list derives "booked"
    // from the voucher links for the rest.
    for (const txId of body.tx_ids) {
      await propagateUnderlagForBookedTransaction(
        supabase,
        companyId!,
        txId,
        result.journal_entry_id,
      )
    }

    // Emit one transaction.reconciled event per tx so existing subscribers
    // (reminder cancellation, automation, processing-history) keep working.
    // Best-effort; a failure here does not roll back the booking.
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
            payload: {
              transaction: tx,
              journalEntryId: result.journal_entry_id,
              method: 'manual',
              userId: user.id,
              companyId,
            },
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

    return NextResponse.json({
      data: {
        mode: result.mode,
        journal_entry_id: result.journal_entry_id,
        voucher_series: result.voucher_series,
        voucher_number: result.voucher_number,
        linked_tx_count: result.linked_tx_count,
        tx_sum: result.tx_sum,
        docs_linked: result.docs_linked,
      },
    })
  },
  { requireWrite: true },
)
