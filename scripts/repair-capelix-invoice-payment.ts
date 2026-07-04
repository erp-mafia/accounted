#!/usr/bin/env npx tsx
/**
 * Repair the Capelix AB invoice-001 double-booking (2026-05-29).
 *
 * Incident: v1 mark-paid read invoiceAlreadyBooked from a column its select
 * never fetched (fixed in PR #713). Capelix (kontantmetoden) had invoice 001
 * registered at send (voucher A6: Dr 1510 / Cr 3001 1500 / Cr 2611 375), so
 * mark-paid should have CLEARED 1510: instead it booked a cash entry
 * (voucher A41: Dr 1930 / Cr 3001 1500 / Cr 2611 375). Net damage: revenue
 * 3001 and VAT 2611 double-counted, 1510 carries an orphaned 1 875 kr debit.
 *
 * Fix (engine-faithful, storno-only per BFL/BFNAR 2013:2, period is open,
 * moms_period=yearly with no declaration filed, so no rättelse needed):
 *   1. reverseEntry(A41): storno the wrong cash entry per 2026-05-29.
 *   2. createInvoicePaymentJournalEntry(...): the correct clearing entry
 *      (Dr 1930 / Cr 1510, 1 875 kr) per 2026-05-29.
 *   3. Relink the bank transaction and invoice_payments row from A41 to the
 *      new clearing entry (same economics, keeps reconciliation intact).
 *
 * Net account effect: 3001 −1500, 2611 −375, 1510 −1875 (cleared), 1930
 * unchanged (matches the real bank inflow).
 *
 * Every step checks preconditions and skips completed work: safe to re-run.
 *
 * Usage:
 *   npx tsx scripts/repair-capelix-invoice-payment.ts            # dry run
 *   npx tsx scripts/repair-capelix-invoice-payment.ts --commit   # apply
 */

import { config } from 'dotenv'
config({ path: '.env.local' })
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { reverseEntry } from '../lib/bookkeeping/engine'
import { createInvoicePaymentJournalEntry } from '../lib/bookkeeping/invoice-entries'
import type { Invoice } from '../types'

const COMPANY_ID = 'c02c8b65-c7c3-4830-b099-853ad174fbd0' // Capelix AB
const OWNER_USER_ID = '81526a33-df2d-41a6-a3dd-98bea1efa80d'
const INVOICE_ID = '2a9ba8c4-8c2b-45b6-a492-8367b881b968' // invoice 001
const REGISTRATION_ENTRY_ID = '3f721508-5ab4-468f-9f35-36b41a8d26a5' // A6
const WRONG_CASH_ENTRY_ID = 'b25b0f6f-d88e-465e-a966-f3a57638638d' // A41
const PAYMENT_DATE = '2026-05-29'

const COMMIT = process.argv.includes('--commit')

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!supabaseUrl || !serviceRoleKey) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local')
  process.exit(1)
}
const supabase = createClient(supabaseUrl, serviceRoleKey) as SupabaseClient

async function entryStatus(id: string): Promise<{ status: string; voucher: string } | null> {
  const { data } = await supabase
    .from('journal_entries')
    .select('status, voucher_series, voucher_number')
    .eq('company_id', COMPANY_ID)
    .eq('id', id)
    .maybeSingle()
  if (!data) return null
  return { status: data.status, voucher: `${data.voucher_series}${data.voucher_number}` }
}

async function main() {
  console.log('─────────────────────────────────────────────────────────')
  console.log(`Capelix invoice-001 repair: ${COMMIT ? 'COMMIT' : 'DRY RUN'}`)
  console.log('─────────────────────────────────────────────────────────')

  // ── Preconditions ──────────────────────────────────────────────
  const registration = await entryStatus(REGISTRATION_ENTRY_ID)
  const wrongCash = await entryStatus(WRONG_CASH_ENTRY_ID)
  if (!registration || registration.status !== 'posted') {
    throw new Error(`Registration entry A6 not found/posted (got ${registration?.status}), aborting`)
  }
  console.log(`✓ Registration ${registration.voucher}: posted`)

  const { data: invoiceRow } = await supabase
    .from('invoices')
    .select('*, customer:customers(name)')
    .eq('company_id', COMPANY_ID)
    .eq('id', INVOICE_ID)
    .maybeSingle()
  if (!invoiceRow) throw new Error('Invoice not found, aborting')
  if (invoiceRow.journal_entry_id !== REGISTRATION_ENTRY_ID) {
    throw new Error(
      `invoice.journal_entry_id is ${invoiceRow.journal_entry_id}, expected the A6 registration entry, aborting`,
    )
  }
  console.log(`✓ Invoice ${invoiceRow.invoice_number}: status=${invoiceRow.status}, total=${invoiceRow.total}, linked to A6`)

  // Existing correct clearing entry? (idempotency for step 2)
  const { data: existingClearing } = await supabase
    .from('journal_entries')
    .select('id, status, voucher_series, voucher_number')
    .eq('company_id', COMPANY_ID)
    .eq('source_type', 'invoice_paid')
    .eq('source_id', INVOICE_ID)
    .eq('status', 'posted')
    .maybeSingle()

  // ── Step 1: storno A41 ─────────────────────────────────────────
  let stornoDone = false
  if (!wrongCash) throw new Error('Wrong cash entry A41 not found, aborting')
  if (wrongCash.status === 'reversed') {
    console.log(`✓ Step 1 already done: ${wrongCash.voucher} is reversed`)
    stornoDone = true
  } else if (wrongCash.status === 'posted') {
    if (COMMIT) {
      const storno = await reverseEntry(supabase, COMPANY_ID, OWNER_USER_ID, WRONG_CASH_ENTRY_ID, PAYMENT_DATE)
      console.log(`✓ Step 1: stornoed ${wrongCash.voucher} → reversal voucher ${storno.voucher_series}${storno.voucher_number}`)
      stornoDone = true
    } else {
      console.log(`→ Step 1 (dry run): would storno ${wrongCash.voucher} (Dr 1930 / Cr 3001 / Cr 2611) per ${PAYMENT_DATE}`)
    }
  } else {
    throw new Error(`Unexpected A41 status: ${wrongCash.status}, aborting`)
  }

  // ── Step 2: correct clearing entry ─────────────────────────────
  let clearingId: string | null = existingClearing?.id ?? null
  if (existingClearing) {
    console.log(`✓ Step 2 already done: clearing entry ${existingClearing.voucher_series}${existingClearing.voucher_number} exists`)
  } else if (COMMIT) {
    if (!stornoDone) throw new Error('Refusing to book clearing before storno, aborting')
    const clearing = await createInvoicePaymentJournalEntry(
      supabase,
      COMPANY_ID,
      OWNER_USER_ID,
      invoiceRow as unknown as Invoice,
      PAYMENT_DATE,
      undefined,
      (invoiceRow as { customer?: { name?: string } }).customer?.name,
      // Full invoice total: the engine would otherwise read remaining_amount,
      // which is 0 on this already-paid row.
      Number(invoiceRow.total),
    )
    if (!clearing) throw new Error('Clearing entry was not created (no open fiscal period?), aborting')
    clearingId = clearing.id
    console.log(`✓ Step 2: booked clearing Dr 1930 / Cr 1510 ${invoiceRow.total} kr → voucher ${clearing.voucher_series}${clearing.voucher_number}`)
  } else {
    console.log(`→ Step 2 (dry run): would book clearing entry Dr 1930 / Cr 1510 ${invoiceRow.total} kr per ${PAYMENT_DATE}`)
  }

  // ── Step 3: relink bank transaction + payment row ──────────────
  if (COMMIT && clearingId) {
    const { data: relinkTx } = await supabase
      .from('transactions')
      .update({ journal_entry_id: clearingId })
      .eq('company_id', COMPANY_ID)
      .eq('journal_entry_id', WRONG_CASH_ENTRY_ID)
      .select('id')
    console.log(`✓ Step 3a: relinked ${relinkTx?.length ?? 0} bank transaction(s) A41 → clearing`)

    const { data: relinkPay } = await supabase
      .from('invoice_payments')
      .update({ journal_entry_id: clearingId })
      .eq('company_id', COMPANY_ID)
      .eq('journal_entry_id', WRONG_CASH_ENTRY_ID)
      .select('id')
    console.log(`✓ Step 3b: relinked ${relinkPay?.length ?? 0} invoice_payments row(s) A41 → clearing`)
  } else if (!COMMIT) {
    const { count: txCount } = await supabase
      .from('transactions')
      .select('id', { count: 'exact', head: true })
      .eq('company_id', COMPANY_ID)
      .eq('journal_entry_id', WRONG_CASH_ENTRY_ID)
    console.log(`→ Step 3 (dry run): would relink ${txCount ?? 0} bank transaction(s) + invoice_payments row(s) to the clearing entry`)
  }

  // ── Verify ─────────────────────────────────────────────────────
  if (COMMIT) {
    // True ledger net: include 'reversed' entries too, a reversed entry's
    // lines stay in the GL and its storno (which carries the same source_id)
    // cancels them. Filtering to 'posted' only would count the storno without
    // its counterpart and report a false imbalance.
    const { data: lines } = await supabase
      .from('journal_entry_lines')
      .select('account_number, debit_amount, credit_amount, journal_entry:journal_entries!inner(company_id, source_id, status)')
      .eq('journal_entry.company_id', COMPANY_ID)
      .eq('journal_entry.source_id', INVOICE_ID)
      .in('journal_entry.status', ['posted', 'reversed'])
    const net = new Map<string, number>()
    for (const l of lines ?? []) {
      const acct = l.account_number as string
      net.set(acct, (net.get(acct) ?? 0) + Number(l.debit_amount) - Number(l.credit_amount))
    }
    console.log('Net per account over posted entries for this invoice:')
    for (const [acct, sum] of [...net.entries()].sort()) {
      console.log(`  ${acct}: ${Math.round(sum * 100) / 100}`)
    }
    const ok =
      Math.abs(net.get('1510') ?? 0) < 0.005 &&
      Math.round(Math.abs(net.get('3001') ?? 0)) === 1500 &&
      Math.round(Math.abs(net.get('2611') ?? 0)) === 375 &&
      Math.round(net.get('1930') ?? 0) === 1875
    console.log(ok ? '✓ VERIFIED: 1510 cleared, revenue/VAT single-counted, 1930 matches bank inflow' : '✗ VERIFY FAILED: inspect manually')
    if (!ok) process.exit(1)
  }

  console.log('─────────────────────────────────────────────────────────')
  console.log(COMMIT ? 'Repair complete.' : 'Dry run complete: re-run with --commit to apply.')
}

main().catch((err) => {
  console.error('Repair failed:', err)
  process.exit(1)
})
