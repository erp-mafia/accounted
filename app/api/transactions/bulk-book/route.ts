import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { BulkBookSchema } from '@/lib/api/schemas'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { applyTemplate } from '@/lib/bookkeeping/template-library'
import { eventBus } from '@/lib/events/bus'
import { ensureInitialized } from '@/lib/init'
import type { BookingTemplateLibraryLine, Transaction } from '@/types'

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
 *  1. Link to existing voucher — { tx_ids, existing_journal_entry_id }.
 *     No new JE; the RPC just inserts N transaction_voucher_links rows.
 *
 *  2. Create new from template — { tx_ids, template_id, mode,
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

    // Three paths now (PR #608):
    //   1. existing_journal_entry_id → null new_entry, RPC links txs to JE.
    //   2. template_id → route expands template per mode, builds lines.
    //   3. manual_lines → caller-built lines pass straight through.
    let newEntryPayload: { description: string; lines: ComputedLine[] } | null = null

    if (body.manual_lines && body.entry_description) {
      // Manual mode. The Zod schema validated the 4-digit format; the
      // RPC's balance + bank-leg + negative-amount + both-sides-nonzero
      // guards still run downstream. What's missing is verifying the
      // account_numbers exist in this company's chart_of_accounts —
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
          details: { message: accountsError.message },
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

      // Need each tx's amount + currency to expand per mode. The RPC also
      // re-validates (date, direction, not-already-booked) but we need the
      // amount sum to drive the template expansion.
      const { data: txs, error: txError } = await supabase
        .from('transactions')
        .select('id, amount, currency, description, date')
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

      const txTyped = txs as Pick<Transaction, 'id' | 'amount' | 'currency' | 'description' | 'date'>[]

      // Same-currency invariant for v1. Mixed-currency batches would need
      // FX conversion per tx; out of scope. Use the dedicated
      // BULK_BOOK_MIXED_CURRENCY code so the toast doesn't blame direction
      // (PR #606 review fix).
      const currencies = new Set(txTyped.map((t) => t.currency))
      if (currencies.size > 1) {
        return errorResponseFromCode('BULK_BOOK_MIXED_CURRENCY', opLog, {
          requestId,
          details: { currencies: Array.from(currencies) },
        })
      }
      const currency = txTyped[0]!.currency

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
          })
        }
      } else {
        // one_line_per_tx — apply template per tx, prefix description with
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
                ? `${formLine.line_description ?? ''} – ${txTag}`.trim()
                : formLine.line_description || undefined,
              sort_order: sortOrder++,
            })
          }
        }
      }

      newEntryPayload = {
        description: body.entry_description,
        lines,
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
        details: { message: error.message },
      })
    }

    const result = data as RpcOk | RpcErr | null
    if (!result || !result.ok) {
      const code = (result as RpcErr | null)?.code ?? 'BULK_BOOK_RPC_FAILED'
      const details = (result as RpcErr | null)?.details
      return errorResponseFromCode(code, opLog, { requestId, details })
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
