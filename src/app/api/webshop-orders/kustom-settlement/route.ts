import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { decodeFileContent } from '@/lib/import/shared/encoding'
import { createServiceClient } from '@/lib/supabase/server'
import { upsertWebshopOrders } from '@/lib/webshop-orders/ingest'
import {
  kustomImport,
  kustomOrderNumbers,
  kustomPayoutExternalId,
  kustomPayoutRecord,
  parseKustomSettlementReport,
} from '@/lib/webshop-orders/kustom-settlement'

const MAX_BYTES = 10 * 1024 * 1024

/** The shop feeds a Kustom Checkout sale can also arrive through. */
const SHOP_FEEDS = ['woocommerce', 'shopify']

/** Order numbers per lookup: a short IN list, far below PostgREST's 1,000-row cap. */
const LOOKUP_CHUNK = 100

/**
 * POST /api/webshop-orders/kustom-settlement
 *
 * Reads one Kustom settlement report (FormData `file`) onto the Orders page:
 * its sales as orders and its returns as refunds, through the same
 * upsertWebshopOrders write the Zettle, Shopify and WooCommerce feeds use.
 * Books nothing. The same file read twice changes nothing (rows are keyed by
 * Kustom's capture and refund ids, the payout by its reference). The payout
 * is stored (webshop_payouts), so its bank row is proposed as one verifikat:
 * the bank net, Kustom's fees and the clearing account gross. Answers with
 * the payout as the report states it.
 *
 * A sale the shop's own feed (WooCommerce, Shopify) already has, by order
 * number, is held rather than imported bookable: booking both would double
 * the revenue and the VAT.
 *
 * Inserts into webshop_orders are service-role only (no member INSERT policy,
 * 20260811073315); the write is scoped to the caller's active company, which
 * the wrapper has checked they may write (requireWrite).
 */
export const POST = withRouteContext(
  'webshop_orders.kustom_settlement',
  async (request, ctx) => {
    const { supabase, companyId, user, log, requestId } = ctx

    const formData = await request.formData()
    const file = formData.get('file')
    if (!(file instanceof File)) {
      return errorResponseFromCode('KUSTOM_SETTLEMENT_NO_FILE', log, { requestId })
    }
    if (file.size > MAX_BYTES) {
      return errorResponseFromCode('KUSTOM_SETTLEMENT_TOO_LARGE', log, { requestId })
    }

    const opLog = log.child({ filename: file.name, sizeBytes: file.size })
    const outcome = parseKustomSettlementReport(decodeFileContent(await file.arrayBuffer()))
    if (!outcome.ok) return errorResponseFromCode(outcome.code, opLog, { requestId })

    const numbers = kustomOrderNumbers(outcome.file)
    const knownElsewhere = new Set<string>()
    for (let i = 0; i < numbers.length; i += LOOKUP_CHUNK) {
      const { data, error } = await supabase
        .from('webshop_orders')
        .select('order_number')
        .eq('company_id', companyId)
        .in('platform', SHOP_FEEDS)
        .in('order_number', numbers.slice(i, i + LOOKUP_CHUNK))
      if (error) {
        opLog.error('kustom settlement shop-feed lookup failed', { error: error.message })
        return errorResponseFromCode('KUSTOM_SETTLEMENT_IMPORT_FAILED', opLog, { requestId })
      }
      for (const row of (data ?? []) as Array<{ order_number: string }>) knownElsewhere.add(row.order_number)
    }

    const { payout, rows, salesHeld, returnsHeld, returnsLeftOut } = kustomImport(outcome.file, knownElsewhere)
    const service = createServiceClient()
    const result = await upsertWebshopOrders(service, companyId, user.id, rows)
    if (result.errors > 0) {
      opLog.error('kustom settlement rows not saved', { errors: result.errors, firstError: result.firstError })
      return errorResponseFromCode('KUSTOM_SETTLEMENT_IMPORT_FAILED', opLog, { requestId })
    }

    // The payout, once: a second upload of the report finds it by its key.
    // A payout no bank row has claimed takes the report's figures again (a
    // corrected report); a claimed or booked one keeps what it was booked by.
    const record = kustomPayoutRecord(payout)
    if (record) {
      const { error: payoutError } = await service
        .from('webshop_payouts')
        .upsert({ ...record, company_id: companyId, user_id: user.id }, { onConflict: 'company_id,external_id', ignoreDuplicates: true })
      const { error: refreshError } = payoutError
        ? { error: null }
        : await service
            .from('webshop_payouts')
            .update({ reference: record.reference, payout_date: record.payout_date, currency: record.currency, amount: record.amount, lines: record.lines })
            .eq('company_id', companyId)
            .eq('external_id', record.external_id)
            .is('transaction_id', null)
            .is('journal_entry_id', null)
      if (payoutError || refreshError) {
        opLog.error('kustom payout not saved', { error: (payoutError ?? refreshError)?.message })
        return errorResponseFromCode('KUSTOM_SETTLEMENT_IMPORT_FAILED', opLog, { requestId })
      }
    } else if (payout.reference) {
      // A corrected report whose payout reached no bank: the payout an earlier
      // upload stored under the same reference is not proposed any more,
      // unless a bank row already claimed or booked it.
      const { error: withdrawError } = await service
        .from('webshop_payouts')
        .delete()
        .eq('company_id', companyId)
        .eq('external_id', kustomPayoutExternalId(payout))
        .is('transaction_id', null)
        .is('journal_entry_id', null)
      if (withdrawError) {
        opLog.error('kustom payout not withdrawn', { error: withdrawError.message })
        return errorResponseFromCode('KUSTOM_SETTLEMENT_IMPORT_FAILED', opLog, { requestId })
      }
    }

    return NextResponse.json({
      data: {
        payout,
        sales: rows.filter((r) => r.row_type === 'order').length,
        refunds: rows.filter((r) => r.row_type === 'refund').length,
        inserted: result.inserted,
        updated: result.updated,
        unchanged: result.unchanged,
        frozen_flagged: result.frozenFlagged,
        sales_held: salesHeld,
        returns_held: returnsHeld,
        returns_left_out: returnsLeftOut,
        payout_recorded: record !== null,
      },
    })
  },
  { requireWrite: true },
)
