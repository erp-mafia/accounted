import { NextResponse } from 'next/server'
import { withCronContext } from '@/lib/api/with-cron-context'
import { createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { checkInvoicePaymentRowInvariant } from '@/lib/invoices/payment-row-invariant'

export const maxDuration = 60

// The weekly ledger invariant scan: the SIE import checks, and the customer AR
// sub-ledger rule that every settled invoice has its invoice_payments row
// (#2019; a missing row doubles revenue and VAT at a kontantmetod year end).
export const GET = withCronContext('cron.sie_import_invariants',async (_request,ctx) => {
  const supabase = createServiceClientNoCookies()
  const {data,error} = await supabase.rpc('check_sie_import_invariants')
  if (error) throw error
  const broken = Number(data.duplicate_groups)+Number(data.missing_holds)+Number(data.stale_holds) > 0
  if (broken) ctx.log.error('SIE ledger invariant violated',new Error('SIE_IMPORT_INVARIANT'),{alert:true,...data})
  else ctx.log.info('SIE ledger invariants checked',data)
  const paymentRows = await checkInvoicePaymentRowInvariant(supabase)
  const paymentRowsBroken = paymentRows.missing_payment_rows > 0
  if (paymentRowsBroken) ctx.log.error('Invoice payment-row invariant violated',new Error('INVOICE_PAYMENT_ROW_INVARIANT'),{alert:true,...paymentRows})
  else ctx.log.info('Invoice payment-row invariant checked',paymentRows)
  return NextResponse.json({data,paymentRows},{status:broken || paymentRowsBroken ? 503 : 200})
})
