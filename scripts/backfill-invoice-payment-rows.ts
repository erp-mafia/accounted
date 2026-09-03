#!/usr/bin/env npx tsx
/**
 * Backfill for issue #2019: customer invoices settled through "Markera som
 * betald" (or the Stripe payment sync) before settleInvoicePayment wrote the
 * invoice_payments row.
 *
 * Why it matters: the kontantmetod bokslut cut-off reads invoice_payments
 * ONLY (payment DATE, not remaining_amount), so a paid invoice without a row
 * is re-booked as a fordran with vilande moms at year end, double-counting
 * revenue and VAT. The same gap hides the payment from the "Betalningar"
 * view and from the voucher -> invoice reference map.
 *
 * What it writes: one row per invoice, amount = paid_amount in invoice
 * currency, payment_date = the payment voucher's entry_date (paid_at was the
 * wall-clock registration time before 2026-08-02 and is not trusted),
 * journal_entry_id = the single posted payment voucher, transaction_id NULL,
 * notes tagged `backfill:#2019` so the whole run reverts with one statement:
 *
 *   DELETE FROM invoice_payments WHERE notes LIKE 'backfill:#2019%';
 *
 * Never guesses (lib/invoices/backfill-invoice-payment-rows.ts): an invoice
 * with zero or several posted payment vouchers is listed, not written, and
 * so is one whose existing rows sum to less than paid_amount (a pre-fix
 * manual partial next to a bank-matched one) or whose voucher booked a
 * different amount than the header says. Idempotent: invoices whose rows
 * cover paid_amount are excluded.
 *
 * Every executed run is recorded in behandlingshistorik (one
 * InvoicePaymentRowBackfilled event per company, BFL 5 kap 11 §): the rows
 * feed the bokslut cut-off, so the bulk write is a change to processing.
 *
 * Usage:
 *   npx tsx scripts/backfill-invoice-payment-rows.ts                 # dry-run (default)
 *   npx tsx scripts/backfill-invoice-payment-rows.ts --execute       # apply
 *   npx tsx scripts/backfill-invoice-payment-rows.ts --company <id>  # one company only
 *   npx tsx scripts/backfill-invoice-payment-rows.ts --verbose        # list every skipped invoice
 *
 * DRY-RUN IS THE DEFAULT. Point NEXT_PUBLIC_SUPABASE_URL /
 * SUPABASE_SERVICE_ROLE_KEY (.env.local) at staging first; prod only after
 * explicit confirmation. Service role bypasses RLS but not the
 * payment_company_consistency trigger, so a row can never land on the wrong
 * tenant.
 */

import { config } from 'dotenv'
config({ path: '.env.local' })
import { randomUUID } from 'node:crypto'
import { createClient } from '@supabase/supabase-js'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { roundOre } from '@/lib/money'
import { appendProcessingHistoryWithClient } from '@/lib/processing-history/append'
import {
  BACKFILL_NOTES_TAG,
  PAYMENT_VOUCHER_SOURCE_TYPES,
  planInvoicePaymentBackfill,
  settlementSekFromLines,
  type BackfillInvoice,
  type BackfillPaymentRow,
  type BackfillSkipReason,
  type BackfillVoucher,
  type ExistingPaymentRows,
} from '@/lib/invoices/backfill-invoice-payment-rows'

const EXECUTE = process.argv.includes('--execute')
const VERBOSE = process.argv.includes('--verbose')
const companyArgIndex = process.argv.indexOf('--company')
const COMPANY_FILTER = companyArgIndex >= 0 ? process.argv[companyArgIndex + 1] : null

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!supabaseUrl || !serviceRoleKey) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local')
  process.exit(1)
}
if (companyArgIndex >= 0 && !COMPANY_FILTER) {
  console.error('--company needs a company id')
  process.exit(1)
}

const supabase = createClient(supabaseUrl, serviceRoleKey)

const CHUNK = 200
const INSERT_BATCH = 100

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

async function main() {
  console.log(`Target: ${supabaseUrl}`)
  console.log(EXECUTE ? 'MODE: EXECUTE (writing)' : 'MODE: dry-run (no writes)')
  if (COMPANY_FILTER) console.log(`Company filter: ${COMPANY_FILTER}`)

  // 1. Candidate invoices: paid or partially paid with money received.
  const invoices = await fetchAllRows<BackfillInvoice>(({ from, to }) => {
    let q = supabase
      .from('invoices')
      .select(
        'id, company_id, user_id, invoice_number, status, document_type, currency, exchange_rate, paid_amount, paid_at',
      )
      .in('status', ['paid', 'partially_paid'])
      .gt('paid_amount', 0)
    if (COMPANY_FILTER) q = q.eq('company_id', COMPANY_FILTER)
    return q.order('id', { ascending: true }).range(from, to)
  })
  console.log(`Paid / partially paid invoices with paid_amount > 0: ${invoices.length}`)

  const invoiceIds = invoices.map((i) => i.id)

  // 2. Existing sub-ledger rows and posted payment vouchers, per invoice.
  const existingRows = new Map<string, ExistingPaymentRows>()
  const vouchersByInvoice = new Map<string, BackfillVoucher[]>()
  for (const ids of chunk(invoiceIds, CHUNK)) {
    const rows = await fetchAllRows<{ id: string; invoice_id: string; amount: number | null }>(
      ({ from, to }) =>
        supabase
          .from('invoice_payments')
          .select('id, invoice_id, amount')
          .in('invoice_id', ids)
          .order('id', { ascending: true })
          .range(from, to),
    )
    for (const r of rows) {
      const acc = existingRows.get(r.invoice_id) ?? { count: 0, sum: 0 }
      acc.count += 1
      acc.sum = roundOre(acc.sum + Number(r.amount ?? 0))
      existingRows.set(r.invoice_id, acc)
    }

    const vouchers = await fetchAllRows<BackfillVoucher>(({ from, to }) =>
      supabase
        .from('journal_entries')
        .select('id, source_id, source_type, status, entry_date')
        .in('source_id', ids)
        .in('source_type', [...PAYMENT_VOUCHER_SOURCE_TYPES])
        .eq('status', 'posted')
        .order('id', { ascending: true })
        .range(from, to),
    )
    const voucherIds = vouchers.map((v) => v.id)
    const lines = voucherIds.length
      ? await fetchAllRows<{
          journal_entry_id: string
          account_number: string
          debit_amount: number | null
          credit_amount: number | null
        }>(({ from, to }) =>
          supabase
            .from('journal_entry_lines')
            .select('journal_entry_id, account_number, debit_amount, credit_amount')
            .in('journal_entry_id', voucherIds)
            .order('id', { ascending: true })
            .range(from, to),
        )
      : []
    const linesByVoucher = new Map<string, typeof lines>()
    for (const l of lines) {
      const list = linesByVoucher.get(l.journal_entry_id) ?? []
      list.push(l)
      linesByVoucher.set(l.journal_entry_id, list)
    }
    for (const v of vouchers) {
      if (!v.source_id) continue
      v.settlement_sek = settlementSekFromLines(linesByVoucher.get(v.id) ?? [])
      const list = vouchersByInvoice.get(v.source_id) ?? []
      list.push(v)
      vouchersByInvoice.set(v.source_id, list)
    }
  }

  // 3. Plan.
  const toInsert: Array<{ invoice: BackfillInvoice; row: BackfillPaymentRow }> = []
  const skipped = new Map<BackfillSkipReason, BackfillInvoice[]>()
  for (const invoice of invoices) {
    const plan = planInvoicePaymentBackfill(
      invoice,
      vouchersByInvoice.get(invoice.id) ?? [],
      existingRows.get(invoice.id) ?? { count: 0, sum: 0 },
    )
    if (plan.kind === 'insert') {
      toInsert.push({ invoice, row: plan.row })
    } else {
      const list = skipped.get(plan.reason) ?? []
      list.push(invoice)
      skipped.set(plan.reason, list)
    }
  }

  console.log('')
  console.log(`Rows to insert: ${toInsert.length}`)
  const perCompany = new Map<string, number>()
  for (const { row } of toInsert) perCompany.set(row.company_id, (perCompany.get(row.company_id) ?? 0) + 1)
  for (const [companyId, n] of perCompany) console.log(`  ${companyId}: ${n}`)
  for (const { invoice, row } of toInsert) {
    console.log(
      `  + ${invoice.company_id} ${invoice.invoice_number ?? invoice.id} ` +
        `${row.amount} ${row.currency} on ${row.payment_date} -> ${row.journal_entry_id}`,
    )
  }

  console.log('')
  console.log('Skipped:')
  for (const [reason, list] of skipped) {
    console.log(`  ${reason}: ${list.length}`)
    // The reasons that need a human: a paid invoice with no voucher to hang
    // the row on, several vouchers whose split is unknown, or existing rows
    // that do not cover paid_amount. On prod the first group is dominated by
    // imported history (paid long before the company came here; thousands of
    // rows), so it is summarised per company unless --verbose asks for every
    // invoice.
    if (
      reason === 'no_payment_voucher' ||
      reason === 'multiple_payment_vouchers' ||
      reason === 'rows_short' ||
      reason === 'voucher_amount_mismatch' ||
      reason === 'voucher_amount_unverifiable'
    ) {
      if (VERBOSE) {
        for (const inv of list) {
          console.log(`    ${inv.company_id} ${inv.invoice_number ?? inv.id} (${inv.status}, paid ${inv.paid_amount})`)
        }
      } else {
        const byCompany = new Map<string, number>()
        for (const inv of list) byCompany.set(inv.company_id, (byCompany.get(inv.company_id) ?? 0) + 1)
        for (const [companyId, n] of byCompany) console.log(`    ${companyId}: ${n}`)
      }
    }
  }

  if (!EXECUTE) {
    console.log('')
    console.log('Re-run with --execute to apply.')
    return
  }

  // 4. Write in batches. A unique-index collision (a row written between the
  // read and this insert) fails the batch loudly rather than being skipped.
  let inserted = 0
  for (const batch of chunk(toInsert, INSERT_BATCH)) {
    const { error } = await supabase.from('invoice_payments').insert(batch.map((b) => b.row))
    if (error) {
      console.error(`Insert failed after ${inserted} rows: ${error.code ?? ''} ${error.message}`)
      process.exitCode = 1
      return
    }
    inserted += batch.length
  }
  console.log('')
  console.log(`Inserted ${inserted} row(s) tagged "${BACKFILL_NOTES_TAG}".`)
  console.log(`Rollback: DELETE FROM invoice_payments WHERE notes LIKE '${BACKFILL_NOTES_TAG}%';`)

  // 5. Behandlingshistorik: one event per company naming every row written.
  // The rows feed the bokslut cut-off, so the run is a change to processing
  // (BFL 5 kap 11 §, BFNAR 2013:2 p. 9.16). Rows without their change-log
  // entry must not stay: if the append fails, that company's rows from this
  // run are deleted again (by id, tag-guarded) so data and audit trail move
  // together, and the company is listed for a re-run.
  const runId = randomUUID()
  const byCompany = new Map<string, Array<{ invoice: BackfillInvoice; row: BackfillPaymentRow }>>()
  for (const item of toInsert) {
    const list = byCompany.get(item.row.company_id) ?? []
    list.push(item)
    byCompany.set(item.row.company_id, list)
  }
  let appended = 0
  const rolledBack: string[] = []
  for (const [companyId, items] of byCompany) {
    try {
      await appendProcessingHistoryWithClient(supabase, {
        companyId,
        correlationId: runId,
        aggregateType: 'System',
        aggregateId: companyId,
        eventType: 'InvoicePaymentRowBackfilled',
        payload: {
          source: 'backfill-invoice-payment-rows',
          issue: 2019,
          notes_tag: BACKFILL_NOTES_TAG,
          row_count: items.length,
          invoice_ids: items.map((i) => i.invoice.id),
          journal_entry_ids: items.map((i) => i.row.journal_entry_id),
        },
        actor: { type: 'system', id: 'backfill-invoice-payment-rows' },
        occurredAt: new Date(),
      })
      appended += 1
    } catch (err) {
      console.error(
        `processing_history append failed for company ${companyId}: ` +
          (err instanceof Error ? err.message : String(err)),
      )
      const { error: rollbackError } = await supabase
        .from('invoice_payments')
        .delete()
        .eq('company_id', companyId)
        .in('invoice_id', items.map((i) => i.invoice.id))
        .like('notes', `${BACKFILL_NOTES_TAG}%`)
      if (rollbackError) {
        console.error(
          `  rollback of ${items.length} row(s) for ${companyId} FAILED: ${rollbackError.message}. ` +
            `Delete by hand: DELETE FROM invoice_payments WHERE company_id = '${companyId}' AND notes LIKE '${BACKFILL_NOTES_TAG}%';`,
        )
      } else {
        console.error(`  rolled back ${items.length} row(s) for ${companyId}; re-run the script for this company.`)
        rolledBack.push(companyId)
      }
      process.exitCode = 1
    }
  }
  console.log(`Behandlingshistorik: ${appended}/${byCompany.size} company event(s) appended (run ${runId}).`)
  if (rolledBack.length > 0) {
    console.log(`Rolled back (no audit event): ${rolledBack.join(', ')}`)
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
