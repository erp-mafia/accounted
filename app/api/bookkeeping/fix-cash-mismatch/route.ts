/**
 * GET  /api/bookkeeping/fix-cash-mismatch   → list affected payments
 * POST /api/bookkeeping/fix-cash-mismatch   → remediate one payment (or all)
 *
 * Targeted fix for the cash/clearing routing bug. The old matcher chose its
 * journal entry shape from the company's current accounting_method instead
 * of from invoice.journal_entry_id, so customers who sent invoices under
 * accrual (Dr 1510 / Cr 30xx + 26xx on send) and then matched a bank
 * receipt after the company had flipped to kontantmetoden ended up with:
 *   - 1510 Kundfordran NEVER credited (orphan receivable on the books)
 *   - 30xx Försäljning AND 26xx Utgående moms double-counted
 *   - momsdeklaration would over-report output VAT
 *
 * Detection: any invoice_payments row whose payment journal entry has
 * source_type='invoice_cash_payment' while the underlying invoice carries
 * its own (still-active) accrual JE.
 *
 * Remediation per affected payment:
 *   1. reverseEntry(payment_je): storno cancels Dr 1930 / Cr 30xx / Cr 26xx
 *   2. createInvoicePaymentJournalEntry: posts the correct Dr 1930 / Cr 1510
 *   3. Re-link invoice_payments + transactions to the new JE
 *
 * Net effect on the books: 30xx and 26xx are restored to their correct
 * (single-count) amounts, 1510 is cleared, 1930 nets to a single debit,
 * invoice keeps status='paid', transaction keeps invoice_id linkage.
 */
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponse, errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { reverseEntry } from '@/lib/bookkeeping/engine'
import { createInvoicePaymentJournalEntry } from '@/lib/bookkeeping/invoice-entries'
import { ensureInitialized } from '@/lib/init'
import type { Invoice } from '@/types'

ensureInitialized()

type AffectedPayment = {
  payment_id: string
  payment_journal_entry_id: string
  invoice_id: string
  invoice_number: string | null
  counterparty_name: string | null
  amount: number
  payment_date: string
  transaction_id: string | null
  invoice_journal_entry_id: string
}

async function findAffected(
  supabase: import('@supabase/supabase-js').SupabaseClient,
  companyId: string,
): Promise<AffectedPayment[]> {
  // 1. Find payment JEs that took the (now-wrong) cash path.
  const { data: cashPaymentEntries, error: jeErr } = await supabase
    .from('journal_entries')
    .select('id, source_id, status')
    .eq('company_id', companyId)
    .eq('source_type', 'invoice_cash_payment')
    .eq('status', 'posted')
  if (jeErr) throw jeErr
  if (!cashPaymentEntries || cashPaymentEntries.length === 0) return []

  // 2. For each, the source_id is the invoice; affected iff that invoice
  //    ALSO has its own journal_entry_id (i.e. 1510 was booked on send).
  const invoiceIds = Array.from(new Set(cashPaymentEntries.map((e) => e.source_id).filter(Boolean)))
  if (invoiceIds.length === 0) return []

  const { data: invoices, error: invErr } = await supabase
    .from('invoices')
    .select('id, invoice_number, journal_entry_id, customer:customers(name)')
    .eq('company_id', companyId)
    .in('id', invoiceIds)
    .not('journal_entry_id', 'is', null)
  if (invErr) throw invErr
  const invoiceMap = new Map(
    (invoices ?? []).map((i) => [
      i.id as string,
      {
        invoice_number: (i.invoice_number as string | null) ?? null,
        invoice_journal_entry_id: i.journal_entry_id as string,
        counterparty_name: ((i.customer as { name?: string | null } | null)?.name) ?? null,
      },
    ]),
  )

  // 3. Pull the invoice_payments rows so we can show + later re-link.
  const affectedJeIds = cashPaymentEntries
    .filter((e) => invoiceMap.has(e.source_id as string))
    .map((e) => e.id as string)
  if (affectedJeIds.length === 0) return []

  const { data: payments, error: payErr } = await supabase
    .from('invoice_payments')
    .select('id, invoice_id, journal_entry_id, amount, payment_date, transaction_id')
    .eq('company_id', companyId)
    .in('journal_entry_id', affectedJeIds)
  if (payErr) throw payErr

  return (payments ?? []).map((p) => {
    const inv = invoiceMap.get(p.invoice_id as string)!
    return {
      payment_id: p.id as string,
      payment_journal_entry_id: p.journal_entry_id as string,
      invoice_id: p.invoice_id as string,
      invoice_number: inv.invoice_number,
      counterparty_name: inv.counterparty_name,
      amount: p.amount as number,
      payment_date: p.payment_date as string,
      transaction_id: (p.transaction_id as string | null) ?? null,
      invoice_journal_entry_id: inv.invoice_journal_entry_id,
    }
  })
}

export const GET = withRouteContext(
  'bookkeeping.fix_cash_mismatch.list',
  async (_request, ctx) => {
    const { supabase, companyId, log, requestId } = ctx
    try {
      const affected = await findAffected(supabase, companyId!)
      return NextResponse.json({ affected })
    } catch (err) {
      log.error('failed to detect cash-mismatch payments', err as Error)
      return errorResponse(err, log, { requestId })
    }
  },
)

const PostSchema = z.object({
  // Either a single payment to fix, or omit to fix all currently detected.
  payment_id: z.string().uuid().optional(),
})

export const POST = withRouteContext(
  'bookkeeping.fix_cash_mismatch.apply',
  async (request, ctx) => {
    const { user, supabase, companyId, log, requestId } = ctx

    let body: unknown
    try {
      body = await request.json()
    } catch {
      body = {}
    }
    const parsed = PostSchema.safeParse(body)
    if (!parsed.success) {
      return errorResponseFromCode('VALIDATION_ERROR', log, { requestId })
    }
    const { payment_id } = parsed.data

    let targets: AffectedPayment[]
    try {
      const all = await findAffected(supabase, companyId!)
      targets = payment_id ? all.filter((p) => p.payment_id === payment_id) : all
    } catch (err) {
      log.error('failed to detect targets', err as Error)
      return errorResponse(err, log, { requestId })
    }

    if (targets.length === 0) {
      return NextResponse.json({ fixed: 0, results: [] })
    }

    const results: Array<{
      payment_id: string
      ok: boolean
      old_journal_entry_id: string
      storno_journal_entry_id?: string
      new_journal_entry_id?: string
      error?: string
    }> = []

    for (const t of targets) {
      try {
        // Storno the wrong cash entry. This reverses Dr 1930 / Cr 30xx / Cr
        // 26xx by posting the mirror, restoring revenue + VAT to their pre-
        // match (correctly-counted-once) state.
        const storno = await reverseEntry(supabase, companyId!, user.id, t.payment_journal_entry_id)

        // Re-fetch the invoice so we have currency / exchange rate metadata
        // for the clearing entry. Customer name is best-effort.
        const { data: inv, error: invErr } = await supabase
          .from('invoices')
          .select('*, customer:customers(name)')
          .eq('id', t.invoice_id)
          .eq('company_id', companyId)
          .single()
        if (invErr || !inv) throw invErr ?? new Error('invoice missing')

        const clearing = await createInvoicePaymentJournalEntry(
          supabase,
          companyId!,
          user.id,
          inv as Invoice,
          t.payment_date,
          undefined,
          (inv.customer as { name?: string } | null)?.name ?? t.counterparty_name ?? undefined,
          t.amount,
        )
        if (!clearing) throw new Error('clearing entry creation returned null')

        // Re-link the invoice_payments row to the new (correct) JE.
        const { error: relinkPayErr } = await supabase
          .from('invoice_payments')
          .update({ journal_entry_id: clearing.id })
          .eq('id', t.payment_id)
          .eq('company_id', companyId)
        if (relinkPayErr) throw relinkPayErr

        // Re-link the transaction too, so /transactions reflects the correct
        // voucher when the user clicks through.
        if (t.transaction_id) {
          const { error: relinkTxErr } = await supabase
            .from('transactions')
            .update({ journal_entry_id: clearing.id })
            .eq('id', t.transaction_id)
            .eq('company_id', companyId)
          if (relinkTxErr) {
            log.warn('failed to relink transaction; voucher chain still correct via payment row', {
              transactionId: t.transaction_id,
              error: relinkTxErr.message,
            })
          }
        }

        results.push({
          payment_id: t.payment_id,
          ok: true,
          old_journal_entry_id: t.payment_journal_entry_id,
          storno_journal_entry_id: storno.id,
          new_journal_entry_id: clearing.id,
        })
      } catch (err) {
        log.error('remediation failed for payment', err as Error, { paymentId: t.payment_id })
        results.push({
          payment_id: t.payment_id,
          ok: false,
          old_journal_entry_id: t.payment_journal_entry_id,
          error: err instanceof Error ? err.message : 'Unknown error',
        })
      }
    }

    return NextResponse.json({
      fixed: results.filter((r) => r.ok).length,
      failed: results.filter((r) => !r.ok).length,
      results,
    })
  },
  { requireWrite: true },
)
