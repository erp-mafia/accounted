import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { LinkTransactionVouchersSchema } from '@/lib/api/schemas'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { getErrorMessage as getUserErrorMessage } from '@/lib/errors/get-error-message'
import { logMatchEvent } from '@/lib/invoices/match-log'
import { propagateUnderlagForBookedTransaction } from '@/lib/transactions/inbox-underlag'
import { ensureInitialized } from '@/lib/init'

ensureInitialized()

interface RpcLink {
  journal_entry_id: string
  allocated_amount: number
  voucher_series: string | null
  voucher_number: number | null
}

interface RpcOk {
  ok: true
  transaction_id: string
  link_count: number
  allocated_total: number
  settlement_account: string
  links: RpcLink[]
}

interface RpcErr {
  ok: false
  code: string
  details?: Record<string, unknown>
}

/**
 * POST /api/transactions/[id]/link-vouchers
 *
 * Couple ONE bank transaction to N already-posted verifikat.
 *
 * This is the 1:N direction of bank matching: a single bank movement that
 * settles several verifikat that already exist (the reported case: "jag har
 * bokfört flera utlägg men gjort en utbetalning"). It creates NO bookkeeping.
 * The verifikat were committed through the sanctioned path already; all this
 * writes is transaction_voucher_links rows.
 *
 * The RPC is the atomicity and authorization boundary: it re-resolves the
 * caller from auth.uid(), takes FOR UPDATE locks on the transaction and every
 * target entry, validates the whole payload BEFORE inserting anything, and
 * returns a structured jsonb error. This route is a thin wrapper that maps
 * that code onto the canonical envelope.
 *
 * For creating new verifikat from one lumped row, see /split-book: that flow
 * writes to the ledger and therefore carries period-lock and voucher-sequence
 * concerns this one does not.
 */
export const POST = withRouteContext<{ params: Promise<{ id: string }> }>(
  'transaction.link_vouchers',
  async (request, ctx, { params }) => {
    const { id: transactionId } = await params
    const { user, supabase, companyId, log, requestId } = ctx

    const validation = await validateBody(request, LinkTransactionVouchersSchema, {
      log,
      operation: 'transaction.link_vouchers',
    })
    if (!validation.success) return validation.response

    const txLog = log.child({ transactionId })

    const { data, error } = await supabase.rpc('link_transaction_to_vouchers', {
      p_transaction_id: transactionId,
      p_links: validation.data.links,
      p_company_id: companyId,
    })

    if (error) {
      txLog.error('link_transaction_to_vouchers RPC error', error)
      return errorResponseFromCode('LINK_VOUCHERS_DB_ERROR', txLog, {
        requestId,
        details: { message: getUserErrorMessage(error) },
      })
    }

    const result = data as RpcOk | RpcErr | null
    if (!result || !result.ok) {
      const code = (result as RpcErr | null)?.code ?? 'LINK_VOUCHERS_DB_ERROR'
      return errorResponseFromCode(code, txLog, {
        requestId,
        details: (result as RpcErr | null)?.details,
      })
    }

    // Behandlingshistorik (BFNAR 2013:2 kap 8, BFL 7:1): coupling a bank row to
    // verifikat is a match event and belongs in the append-only log, exactly
    // like the single-link and invoice-match paths. Awaited: an unawaited
    // promise can be frozen on serverless when the response returns, silently
    // dropping the audit row.
    for (const link of result.links) {
      await logMatchEvent(supabase, user.id, transactionId, 'linked_to_existing_voucher', {
        matchMethod: 'manual_multi_voucher',
        newState: {
          journal_entry_id: link.journal_entry_id,
          allocated_amount: link.allocated_amount,
          link_count: result.link_count,
        },
      })
    }

    // Complete any matched inbox underlag against the transaction so it leaves
    // the active inbox. With several targets there is no single verifikat to
    // pin an underlag to, so this only runs for the unambiguous single-link
    // case; multi-link underlag is handled per part by the split-book flow.
    if (result.link_count === 1) {
      await propagateUnderlagForBookedTransaction(
        supabase,
        companyId!,
        transactionId,
        result.links[0].journal_entry_id,
      )
    }

    return NextResponse.json({
      data: {
        transaction_id: result.transaction_id,
        link_count: result.link_count,
        allocated_total: result.allocated_total,
        settlement_account: result.settlement_account,
        links: result.links,
      },
    })
  },
  { requireWrite: true },
)
