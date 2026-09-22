import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponse, errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { fetchExchangeRate } from '@/lib/currency/riksbanken'
import { guardSandbox } from '@/lib/sandbox/guard'
import type { Currency, Transaction } from '@/types'

export const POST = withRouteContext(
  'transaction.refreshExchangeRate',
  async (_request, ctx, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params
    const { supabase, companyId, log, requestId } = ctx

    const blocked = await guardSandbox(supabase, companyId)
    if (blocked) return blocked

    const { data: transaction, error: fetchError } = await supabase
      .from('transactions')
      .select('*')
      .eq('id', id)
      .eq('company_id', companyId)
      .single<Transaction>()

    if (fetchError || !transaction) {
      return errorResponseFromCode('TX_CATEGORIZE_TX_NOT_FOUND', log, { requestId })
    }

    // No-op for SEK transactions, or when the rate is already cached.
    if (
      transaction.currency === 'SEK' ||
      (transaction.amount_sek != null && transaction.exchange_rate != null)
    ) {
      return NextResponse.json({ data: transaction })
    }

    const rate = await fetchExchangeRate(transaction.currency as Currency, new Date(transaction.date), supabase)
    if (!rate) {
      return errorResponseFromCode('TX_EXCHANGE_RATE_UNAVAILABLE', log, {
        requestId,
        details: { currency: transaction.currency, date: transaction.date },
      })
    }

    const amountSek = Math.round(transaction.amount * rate.rate * 100) / 100

    const { data: updated, error: updateError } = await supabase
      .from('transactions')
      .update({
        amount_sek: amountSek,
        exchange_rate: rate.rate,
        exchange_rate_date: rate.date,
      })
      .eq('id', id)
      .eq('company_id', companyId)
      .is('journal_entry_id', null)
      .select('*')
      .single<Transaction>()

    if (updateError || !updated) {
      return errorResponse(updateError ?? new Error('Failed to persist exchange rate'), log, {
        requestId,
      })
    }

    return NextResponse.json({ data: updated })
  },
  { requireWrite: true },
)
