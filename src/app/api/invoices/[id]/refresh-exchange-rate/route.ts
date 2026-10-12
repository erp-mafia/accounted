import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponse, errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { fetchExchangeRate } from '@/lib/currency/riksbanken'
import { roundOre } from '@/lib/money'
import { resolvePeriodStatusForDate } from '@/lib/core/bookkeeping/period-service'
import { guardSandbox } from '@/lib/sandbox/guard'
import type { Currency, Invoice } from '@/types'
import { UUID_RE } from '@/lib/invariants/uuid'

/**
 * POST /api/invoices/[id]/refresh-exchange-rate
 *
 * Repair path for a foreign-currency invoice whose SEK conversion is missing
 * or was stamped from the wrong day's rate. The invoice twin of
 * /api/transactions/[id]/refresh-exchange-rate.
 *
 * Why it exists: buildInvoiceWriteData fetches the Riksbanken rate at create
 * time. One transient 429 there used to leave exchange_rate NULL forever, and
 * resolveSekAmount() then books the raw foreign number as if it were kronor
 * (1 000 EUR posted as 1 000 kr on 1510/2611). PATCH /api/invoices/[id] cannot
 * fix it: that route only accepts drafts, and the invoice is already sent.
 * Several structured errors (MATCH_INVOICE_BOOKING_RATE_MISSING,
 * BATCH_FX_RATE_MISSING) tell the user to "komplettera fakturans exchange_rate"
 * and this is the endpoint that actually does it.
 *
 * What it changes: only exchange_rate, exchange_rate_date and the three *_sek
 * columns. The invoice's own currency amounts (subtotal / vat_amount / total /
 * remaining_amount) are never touched: the customer's debt is denominated in
 * the invoice currency and re-rating it would silently reprice a sent invoice.
 *
 * Which rate: the one at the TAXABLE EVENT, per ML 8 kap 21-23 § ("Rate to
 * use: at time of taxable event (delivery/supply date or advance payment date,
 * not invoice date unless same)"). delivery_date when set, otherwise
 * invoice_date, which is the same day by definition when delivery_date is null
 * (ML 17 kap 24 § p.7 requires the delivery date on the invoice precisely when
 * the two differ).
 *
 * Booked invoices are REFUSED, never re-rated. Once the invoice has a
 * verifikat, the SEK amounts are bokförda poster: changing them is a rättelse
 * of a posted entry and BFL 5 kap 5 § allows exactly two tracks for that
 * (storno via reverseEntry/correctEntry, or the inline rättelse RPCs). A
 * silent UPDATE of the invoice row behind a committed verifikat would also
 * desync the invoice from the ledger it produced, which is the worse failure:
 * the reports would keep showing the old, wrong SEK value.
 */
export const POST = withRouteContext<{ params: Promise<{ id: string }> }>(
  'invoice.refreshExchangeRate',
  async (_request, { supabase, companyId, log, requestId }, { params }) => {
    const { id } = await params

    // Defense in depth: a malformed id would otherwise reach Postgres as an
    // invalid uuid literal (22P02) and surface as a confusing 404.
    if (!UUID_RE.test(id)) {
      return errorResponseFromCode('VALIDATION_ERROR', log, {
        requestId,
        details: { field: 'id', reason: 'not_a_uuid' },
      })
    }

    // Riksbanken is a gated external service in the sandbox.
    const blocked = await guardSandbox(supabase, companyId)
    if (blocked) return blocked

    // The *_sek columns are projected solely so the post-update compensation
    // below can restore the exact prior values if a concurrent booking wins.
    const { data: invoice, error: fetchError } = await supabase
      .from('invoices')
      .select(
        'id, status, currency, invoice_date, delivery_date, subtotal, vat_amount, total, exchange_rate, exchange_rate_date, subtotal_sek, vat_amount_sek, total_sek, journal_entry_id',
      )
      .eq('id', id)
      .eq('company_id', companyId)
      .single<
        Pick<
          Invoice,
          | 'id'
          | 'status'
          | 'currency'
          | 'invoice_date'
          | 'delivery_date'
          | 'subtotal'
          | 'vat_amount'
          | 'total'
          | 'exchange_rate'
          | 'exchange_rate_date'
          | 'subtotal_sek'
          | 'vat_amount_sek'
          | 'total_sek'
          | 'journal_entry_id'
        >
      >()

    if (fetchError || !invoice) {
      return errorResponseFromCode('INVOICE_NOT_FOUND', log, { requestId })
    }

    // A SEK invoice has no conversion to repair.
    if (invoice.currency === 'SEK') {
      return NextResponse.json({ data: invoice })
    }

    // Guard 1: already booked → the SEK values live in a verifikat.
    // invoice.journal_entry_id is the primary link, but it was backfilled late
    // (see mark-sent) so older booked rows can still carry NULL. The
    // journal_entries lookup by source_id is the authoritative check.
    if (invoice.journal_entry_id) {
      return errorResponseFromCode('INVOICE_FX_REFRESH_BOOKED', log, {
        requestId,
        details: { invoice_id: id, journal_entry_id: invoice.journal_entry_id },
      })
    }

    const { data: linkedEntries, error: entriesError } = await supabase
      .from('journal_entries')
      .select('id, voucher_series, voucher_number')
      .eq('company_id', companyId)
      .eq('source_id', id)
      .limit(1)

    if (entriesError) {
      // Fail closed: an unknown booking state must not authorise a re-rate.
      log.error('invoice fx refresh: journal entry lookup failed', entriesError, { invoiceId: id })
      return errorResponse(entriesError, log, { requestId })
    }
    if (linkedEntries && linkedEntries.length > 0) {
      return errorResponseFromCode('INVOICE_FX_REFRESH_BOOKED', log, {
        requestId,
        details: { invoice_id: id, journal_entry_id: linkedEntries[0].id },
      })
    }

    // Guard 2: period locks. The invoice's verifikat is dated invoice_date
    // (invoice-entries.ts), so that is the period this repair feeds. Behind a
    // lock/close the whole räkenskapsinformation for the period is frozen and
    // the only route is storno. resolvePeriodStatusForDate fails CLOSED: a
    // failed lookup reports `locked`, which is the answer we want here too.
    const periodStatus = await resolvePeriodStatusForDate(supabase, companyId, invoice.invoice_date)
    if (periodStatus.status !== 'open') {
      return errorResponseFromCode('INVOICE_FX_REFRESH_PERIOD_LOCKED', log, {
        requestId,
        details: {
          invoice_id: id,
          date: invoice.invoice_date,
          period_status: periodStatus.status,
          lock_date: periodStatus.lock_date,
          lookup_failed: periodStatus.lookup_failed ?? false,
        },
      })
    }

    const rateDate = invoice.delivery_date || invoice.invoice_date
    const rate = await fetchExchangeRate(
      invoice.currency as Currency,
      new Date(rateDate),
      supabase,
    )
    if (!rate) {
      return errorResponseFromCode('INVOICE_FX_REFRESH_RATE_UNAVAILABLE', log, {
        requestId,
        details: { invoice_id: id, currency: invoice.currency, date: rateDate },
      })
    }

    // Idempotent: nothing to write when the stored rate already is the
    // taxable-event rate.
    if (invoice.exchange_rate === rate.rate && invoice.exchange_rate_date === rate.date) {
      return NextResponse.json({ data: invoice })
    }

    const toSek = (amount: number) => roundOre(amount * rate.rate)

    const { data: updated, error: updateError } = await supabase
      .from('invoices')
      .update({
        exchange_rate: rate.rate,
        exchange_rate_date: rate.date,
        subtotal_sek: toSek(invoice.subtotal),
        vat_amount_sek: toSek(invoice.vat_amount),
        total_sek: toSek(invoice.total),
        updated_at: new Date().toISOString(),
      })
      .eq('id', id)
      .eq('company_id', companyId)
      // TOCTOU: a concurrent send/book between the guard above and this write
      // must lose, not silently re-rate a now-posted invoice.
      .is('journal_entry_id', null)
      .select('*')

    if (updateError) {
      log.error('invoice fx refresh: persist failed', updateError, { invoiceId: id })
      return errorResponse(updateError, log, { requestId })
    }
    if (!updated || updated.length === 0) {
      return errorResponseFromCode('INVOICE_FX_REFRESH_BOOKED', log, {
        requestId,
        details: { invoice_id: id, reason: 'booked_concurrently' },
      })
    }

    // TOCTOU compensation. The `.is('journal_entry_id', null)` CAS above only
    // covers the invoice ROW, but a booking flow that read the invoice at the
    // OLD rate can commit its journal entry after our journal_entries check
    // and before invoices.journal_entry_id is stamped: the verifikat then
    // posts at the old rate while the row now stores the new one, the exact
    // divergence this route exists to prevent. Re-check by source_id; if an
    // entry appeared, restore the prior values via a CAS on the values this
    // request just wrote (never clobbering a later legitimate write) and
    // report the booked conflict. A perfect fix needs DB-level serialization
    // (out of scope); this shrinks the race window from the whole request to
    // the few milliseconds between this SELECT and the revert.
    const { data: postEntries, error: postCheckError } = await supabase
      .from('journal_entries')
      .select('id')
      .eq('company_id', companyId)
      .eq('source_id', id)
      .limit(1)

    if (postCheckError) {
      // Cannot tell whether a booking won the race: leave the update in place
      // (same residual risk as before this compensation existed) but make the
      // blind spot visible in logs.
      log.warn('invoice fx refresh: post-update booking recheck failed', {
        invoiceId: id,
        error: postCheckError.message,
      })
    } else if (postEntries && postEntries.length > 0) {
      const { error: revertError } = await supabase
        .from('invoices')
        .update({
          exchange_rate: invoice.exchange_rate,
          exchange_rate_date: invoice.exchange_rate_date,
          subtotal_sek: invoice.subtotal_sek ?? null,
          vat_amount_sek: invoice.vat_amount_sek ?? null,
          total_sek: invoice.total_sek ?? null,
          updated_at: new Date().toISOString(),
        })
        .eq('id', id)
        .eq('company_id', companyId)
        // CAS on exactly what this request wrote: if someone else already
        // changed the rate again, their write wins and nothing is reverted.
        .eq('exchange_rate', rate.rate)
        .eq('exchange_rate_date', rate.date)
      if (revertError) {
        log.error('invoice fx refresh: revert after concurrent booking failed', revertError, {
          invoiceId: id,
        })
      }
      return errorResponseFromCode('INVOICE_FX_REFRESH_BOOKED', log, {
        requestId,
        details: {
          invoice_id: id,
          journal_entry_id: (postEntries[0] as { id: string }).id,
          reason: 'booked_concurrently_reverted',
        },
      })
    }

    return NextResponse.json({ data: updated[0] })
  },
  { requireWrite: true },
)
