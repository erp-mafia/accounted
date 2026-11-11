import { NextResponse } from 'next/server'
import { withCronContext } from '@/lib/api/with-cron-context'
import { createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { checkInvoicePaymentRowInvariant } from '@/lib/invoices/payment-row-invariant'
import {
  checkFailure,
  checkSieImportJobInvariants,
  scanSieImportDuplicateVouchers,
  type CheckFailure,
} from '@/lib/import/sie-import-invariants'

export const maxDuration = 300
// No duplicate-voucher page starts after this. A started page, like each
// single-call check before the pages, ends within its 30 s statement timeout.
const RUN_BUDGET_MS = 200_000

type Outcome<T> = { value: T; failure: null } | { value: null; failure: CheckFailure }

async function settle<T>(check: () => Promise<T>): Promise<Outcome<T>> {
  try {
    return { value: await check(), failure: null }
  } catch (err) {
    return { value: null, failure: checkFailure(err) }
  }
}

const outcome = (failure: CheckFailure | null) => (failure ? { finished: false, code: failure.code } : { finished: true })

// The weekly ledger invariant scan: the SIE import checks, and the customer AR
// sub-ledger rule that every settled invoice has its invoice_payments row
// (#2019; a missing row doubles revenue and VAT at a kontantmetod year end).
// Each check runs on its own statement budget and the duplicate check goes
// page by page, so one slow check no longer hides the others: the response
// says which checks finished and how many companies the duplicate check
// reached (error messages go to the run log only). A violation found is 503
// even when the scan is incomplete; an incomplete scan without one is 500,
// never a clean 200.
export const GET = withCronContext('cron.sie_import_invariants',async (_request,ctx) => {
  const supabase = createServiceClientNoCookies()
  const jobs = await settle(() => checkSieImportJobInvariants(supabase))
  const paymentRows = await settle(() => checkInvoicePaymentRowInvariant(supabase))
  const duplicates = await scanSieImportDuplicateVouchers(supabase,{deadline:ctx.startedAt + RUN_BUDGET_MS})

  const {finished,stopped,failure,companies_checked,last_company_id,...duplicateCounts} = duplicates
  const data = {...duplicateCounts,...(jobs.value ?? {})}
  const checks = {
    sie_import_jobs: outcome(jobs.failure),
    sie_import_duplicates: {finished,companies_checked,last_company_id,
      ...(stopped ? {stopped} : {}),...(failure ? {code:failure.code} : {})},
    invoice_payment_rows: outcome(paymentRows.failure),
  }
  const complete = Object.values(checks).every((check) => check.finished)

  const broken = duplicates.duplicate_groups + (jobs.value ? jobs.value.missing_holds + jobs.value.stale_holds : 0) > 0
  if (broken) ctx.log.error('SIE ledger invariant violated',new Error('SIE_IMPORT_INVARIANT'),{alert:true,...data})
  else if (jobs.value && finished) ctx.log.info('SIE ledger invariants checked',data)
  const paymentRowsBroken = (paymentRows.value?.missing_payment_rows ?? 0) > 0
  if (paymentRowsBroken) ctx.log.error('Invoice payment-row invariant violated',new Error('INVOICE_PAYMENT_ROW_INVARIANT'),{alert:true,...paymentRows.value})
  else if (paymentRows.value) ctx.log.info('Invoice payment-row invariant checked',paymentRows.value)
  if (!complete) {
    ctx.log.error('Ledger invariant scan incomplete',new Error('LEDGER_INVARIANT_SCAN_INCOMPLETE'),{alert:true,checks,
      failures:{sie_import_jobs:jobs.failure?.message,sie_import_duplicates:failure?.message,invoice_payment_rows:paymentRows.failure?.message}})
  }

  const status = broken || paymentRowsBroken ? 503 : complete ? 200 : 500
  return NextResponse.json({data,paymentRows:paymentRows.value,complete,checks},{status})
})
