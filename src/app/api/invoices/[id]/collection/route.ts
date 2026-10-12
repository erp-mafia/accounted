import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody, validateQuery } from '@/lib/api/validate'
import { getCollectionsAvailability } from '@/lib/collections/availability'
import { handOverInvoice } from '@/lib/collections/case-actions'
import { caseView, loadCaseEvents } from '@/lib/collections/case'
import { caseRefusalResponse, webCaseServiceDeps } from '@/lib/collections/case-routes'
import { loadLiveConnection } from '@/lib/collections/connection'
import { readCollectionsEnv } from '@/lib/collections/flags'
import { withdrawFeeInfo } from '@/lib/collections/stages'
import { loadCaseEscalationCheck, loadInvoiceCase, loadInvoiceReadiness } from '@/lib/collections/invoice-collection'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { createServiceClient } from '@/lib/supabase/server'

/** Connect gives openCase 120 s and the adapter waits 130 s for it. */
export const maxDuration = 150

const ParamsSchema = z.object({ id: z.uuid() })

const QuerySchema = z.object({
  /** "1": the handover dialog is open; answer whether and how the invoice can be handed over. */
  readiness: z.enum(['0', '1']).optional(),
  /** Bank rows the person marked as not a payment of this invoice. */
  dismissed: z.string().max(4000).optional(),
})

const OpenBodySchema = z.object({
  start_step: z.enum(['reminder', 'collection']).nullable().optional(),
  expected_remaining: z.number().min(0).max(1_000_000_000),
  bank_attested: z.boolean().optional(),
  delivery_attested: z.boolean().optional(),
  imported_attested: z.boolean().optional(),
  response_attested: z.boolean().optional(),
  dismissed_transaction_ids: z.array(z.uuid()).max(200).optional(),
})

async function invoiceVisible(ctx: { supabase: import('@supabase/supabase-js').SupabaseClient; companyId: string }, id: string): Promise<boolean> {
  const { data, error } = await ctx.supabase.from('invoices').select('id').eq('company_id', ctx.companyId).eq('id', id).maybeSingle()
  if (error) throw new Error(`invoice lookup failed: ${error.message}`)
  return data !== null
}

/**
 * GET /api/invoices/[id]/collection: the invoice's case (open, or the latest
 * closed or refused one) with its trail, refreshed from the provider at most
 * once a minute, plus where the start entry points stand. With
 * ?readiness=1 (a dialog is open) also, for a handover, the checklist, the
 * claim and the bank check, and, for an escalation of an open case, the
 * escalation check (still owed, every payment reported, the bank). Reading a
 * case is an obligation path: it renders whatever the start gates say.
 */
export const GET = withRouteContext<{ params: Promise<{ id: string }> }>(
  'invoice.collection.get',
  async (request, ctx, { params }) => {
    const parsed = ParamsSchema.safeParse(await params)
    if (!parsed.success) return errorResponseFromCode('VALIDATION_ERROR', ctx.log, { requestId: ctx.requestId })
    const query = validateQuery(request, QuerySchema, { log: ctx.log, operation: 'invoice.collection.get' })
    if (!query.success) return query.response
    const invoiceId = parsed.data.id
    if (!(await invoiceVisible(ctx, invoiceId))) return errorResponseFromCode('INVOICE_NOT_FOUND', ctx.log, { requestId: ctx.requestId })

    const env = readCollectionsEnv()
    const availability = await getCollectionsAvailability(ctx.supabase, ctx.companyId, { env })
    const db = createServiceClient()
    const deps = { db, log: ctx.log }
    const [caseRow, connectionRow] = await Promise.all([
      loadInvoiceCase(deps, ctx.companyId, invoiceId, { refresh: true }),
      availability.connection ? loadLiveConnection(db, ctx.companyId) : Promise.resolve(null),
    ])

    const wantsReadiness = query.data.readiness === '1'
    const canStart = availability.start === 'ready'
    const dismissed = (query.data.dismissed ?? '').split(',').filter((id) => z.uuid().safeParse(id).success)
    const handover = !caseRow?.isOpen || caseRow.stage === 'invoice_sent'
    const readiness =
      wantsReadiness && canStart && handover
        ? await loadInvoiceReadiness({ ...deps, userId: ctx.user.id }, ctx.companyId, invoiceId, dismissed)
        : null
    // An open case waiting for an escalation (approve the next step, "it is
    // not paid"): the same check the commit runs, shown when the dialog opens.
    // Decisions on an open case are obligations, so no start gate here.
    const escalation =
      wantsReadiness && !handover && caseRow?.isOpen
        ? await loadCaseEscalationCheck(deps, ctx.companyId, invoiceId, dismissed)
        : null

    return NextResponse.json(
      {
        data: {
          availability: {
            start: availability.start,
            enabled: availability.enabled,
            capability: availability.capability,
            sandbox: availability.sandbox,
            obligations: availability.obligations,
            displayName: availability.displayName,
            portalUrl: availability.provider?.portalUrl ?? null,
            feeSummarySv: availability.provider?.feeSummarySv ?? null,
            withdrawFreeDays: availability.provider?.features.withdrawFreeDays ?? null,
            connection: availability.connection
              ? {
                  state: availability.connection.state,
                  ladderMode: availability.connection.ladderMode,
                  ladderDaysAfterDue: connectionRow?.ladder_days_after_due ?? null,
                }
              : null,
          },
          case: caseRow,
          // The withdraw dialog's fee line: shown, and confirmed, once the provider's free days have passed.
          withdrawFee: caseRow?.isOpen
            ? withdrawFeeInfo(caseRow.openedAt, availability.provider?.features.withdrawFreeDays ?? null, new Date())
            : null,
          readiness,
          escalation,
        },
      },
      { headers: { 'Cache-Control': 'no-store' } },
    )
  },
)

/**
 * POST /api/invoices/[id]/collection: "Skicka till inkasso". Runs every
 * check again at commit (eligibility, the bank check, the amount the person
 * saw), takes the attestations only from this browser session, reserves the
 * case and hands the invoice over through Connect. An invoice the provider
 * only delivered gets its reminders started on the same claim instead.
 */
export const POST = withRouteContext<{ params: Promise<{ id: string }> }>(
  'invoice.collection.open',
  async (request, ctx, { params }) => {
    const parsed = ParamsSchema.safeParse(await params)
    if (!parsed.success) return errorResponseFromCode('VALIDATION_ERROR', ctx.log, { requestId: ctx.requestId })
    const body = await validateBody(request, OpenBodySchema, { log: ctx.log, operation: 'invoice.collection.open' })
    if (!body.success) return body.response
    if (!(await invoiceVisible(ctx, parsed.data.id))) return errorResponseFromCode('INVOICE_NOT_FOUND', ctx.log, { requestId: ctx.requestId })

    const deps = await webCaseServiceDeps(ctx, readCollectionsEnv())
    const outcome = await handOverInvoice(deps, {
      invoiceId: parsed.data.id,
      startStep: body.data.start_step ?? null,
      expectedRemaining: body.data.expected_remaining,
      attestations: {
        bank: body.data.bank_attested,
        delivery: body.data.delivery_attested,
        imported: body.data.imported_attested,
        response: body.data.response_attested,
      },
      dismissedTransactionIds: body.data.dismissed_transaction_ids,
    })
    if (!outcome.ok) return caseRefusalResponse(outcome, ctx)
    if (outcome.dryRun) return NextResponse.json({ data: { preview: outcome.preview } })
    const events = await loadCaseEvents(deps.db, outcome.case.id)
    return NextResponse.json({
      data: {
        case: caseView(outcome.case, events),
        registered: 'registered' in outcome ? outcome.registered : true,
      },
    })
  },
  { requireWrite: true },
)
