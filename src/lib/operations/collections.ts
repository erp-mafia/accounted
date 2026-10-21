/**
 * Collections operations: find the overdue invoices that could go to the
 * company's collections provider, read an invoice's case, hand an invoice
 * over, and act on an open case. Never named after the provider: the
 * provider is whatever the company activated through Accounted Connect.
 *
 * Rules live in lib/collections (open-case.ts, case-actions.ts,
 * candidates.ts, invoice-collection.ts), shared with the dashboard routes
 * POST /api/invoices/[id]/collection, POST .../collection/actions and
 * GET /api/collections/candidates.
 *
 * Registered in the registry only while COLLECTIONS_ENABLED is set, so the
 * MCP search index shows nothing while the feature is dark; an operation
 * staged earlier still commits (operationForPendingType knows them all).
 * Every run() asks the same gates as the routes (flags.ts).
 *
 * Agents hand over only what needs no person's word: a delivered invoice,
 * no customer answer to our reminders, a bank check that passed. Attestation
 * fields are refused (COLLECTION_ATTESTATION_WEB_ONLY), and both staged
 * types are approvable only by a person in the web UI when they hand over
 * or escalate (risk-tiers.ts requiresWebApproval). There is no v1 REST door
 * yet: it would publish the operations in the OpenAPI document while the
 * feature is dark.
 */
import { z } from 'zod'
import { collectionsActionSchema, type CollectionsAction } from '@accounted/connect-contract'
import { loadCollectionsGateFacts } from '@/lib/collections/availability'
import { handOverInvoice, runCaseAction } from '@/lib/collections/case-actions'
import { caseView, loadCaseEvents, type CollectionCaseView } from '@/lib/collections/case'
import { getCollectionsProvider } from '@/lib/collections/catalogue'
import { listCollectionCandidates } from '@/lib/collections/candidates'
import { loadLiveConnection } from '@/lib/collections/connection'
import { collectionsEnvelopeCode, collectionsErrorMessage, providerDisplayName } from '@/lib/collections/errors'
import { readCollectionsEnv } from '@/lib/collections/flags'
import { loadInvoiceCase } from '@/lib/collections/invoice-collection'
import { MAX_PAUSE_DAYS, withdrawFeeInfo } from '@/lib/collections/stages'
import { gateRefusal, hasCollectionsWording, type CollectionsRefusal, type CollectionsServiceDeps } from '@/lib/collections/service-deps'
import { createServiceClient } from '@/lib/supabase/server'
import { COLLECTIONS_BOOKING_OPERATION_LIST } from './collections-booking'
import type { OperationContext, OperationOutcome } from './types'
import { defineOperation } from './types'

const META = { request_id: 'req_…', api_version: '2026-05-12' }

const INVOICE_ID = z.uuid().describe('The customer invoice id, from GET /invoices.')

/**
 * The case services write collection_cases and their trail, which only the
 * service role may write (RLS grants members SELECT only). Every door that
 * runs these operations has established the caller's membership of
 * ctx.companyId (the MCP and v1 key, the commit route's company context),
 * and every query the services make filters on that company. The gate facts
 * are read with the caller's own client.
 */
async function serviceDeps(ctx: OperationContext): Promise<CollectionsServiceDeps> {
  const env = readCollectionsEnv()
  return {
    db: createServiceClient(),
    companyId: ctx.companyId,
    actor: { userId: ctx.userId, name: ctx.userId },
    channel: 'agent',
    facts: await loadCollectionsGateFacts(ctx.supabase, ctx.companyId),
    env,
    log: ctx.log,
  }
}

async function providerName(ctx: OperationContext): Promise<string> {
  try {
    const connection = await loadLiveConnection(ctx.supabase, ctx.companyId)
    return providerDisplayName({ connectionName: connection?.display_name ?? null })
  } catch {
    return providerDisplayName({})
  }
}

/** A refusal as an operation failure, worded with the provider's name where the code names it. */
async function failure(ctx: OperationContext, refusal: CollectionsRefusal): Promise<Extract<OperationOutcome<never>, { ok: false }>> {
  if (refusal.code === 'CAPABILITY_REQUIRED') return { ok: false, code: 'COLLECTIONS_CAPABILITY_BLOCKED' }
  const code = refusal.upstream ? collectionsEnvelopeCode(refusal.upstream.code) : refusal.code
  if (refusal.upstream || hasCollectionsWording(refusal.code)) {
    return {
      ok: false,
      code,
      details: { ...(refusal.details ?? {}), ...(refusal.upstream ? { upstream_code: refusal.upstream.code } : {}) },
      messageSv: collectionsErrorMessage(refusal.upstream?.code ?? refusal.code, { provider: await providerName(ctx) }),
    }
  }
  return { ok: false, code, details: refusal.details }
}

const Block = z.string().describe('A check the invoice fails, e.g. elig_not_overdue, elig_below_minimum, debtor_missing_address.')

const CaseEvent = z.object({
  event_id: z.string(),
  occurred_at: z.string(),
  kind: z.string(),
  stage_from: z.string().nullable(),
  stage_to: z.string().nullable(),
  direction: z.string().nullable(),
  label: z.string(),
  amount: z.number().nullable(),
})

const CaseView = z.object({
  case_id: z.string().uuid(),
  invoice_id: z.string().uuid(),
  origin: z.string(),
  start_step: z.string(),
  submission_status: z.string().describe('preparing, submitted (the call is retried), registered or failed.'),
  case_number: z.string().nullable(),
  merged: z.boolean(),
  stage: z.string().describe('registered, invoice_sent, reminder, collection, awaiting_decision, enforcement, payment_plan, monitoring, paused, closed_paid, closed_other or unknown.'),
  decision_kind: z.string().nullable().describe('While awaiting_decision: what the provider waits for.'),
  is_open: z.boolean(),
  close_reason: z.string().nullable(),
  provider_state_label: z.string().nullable(),
  next_action_date: z.string().nullable(),
  next_action_label: z.string().nullable(),
  actions: z.array(z.string()).describe('The actions the case offers right now.'),
  claim_amount: z.number(),
  outstanding_principal: z.number().nullable(),
  outstanding_total: z.number().nullable(),
  paused_by_sweep: z.boolean(),
  opened_at: z.string(),
  closed_at: z.string().nullable(),
  last_synced_at: z.string().nullable(),
  sync_error: z.string().nullable(),
  events: z.array(CaseEvent),
})

type CaseViewOut = z.infer<typeof CaseView>

/** The case as the tools answer it: snake_case, every identifier qualified (no bare id). */
function caseOut(view: CollectionCaseView): CaseViewOut {
  return {
    case_id: view.id,
    invoice_id: view.invoiceId,
    origin: view.origin,
    start_step: view.startStep,
    submission_status: view.submissionStatus,
    case_number: view.caseNumber,
    merged: view.merged,
    stage: view.stage,
    decision_kind: view.decisionKind,
    is_open: view.isOpen,
    close_reason: view.closeReason,
    provider_state_label: view.providerStateLabel,
    next_action_date: view.nextActionDate,
    next_action_label: view.nextActionLabel,
    actions: [...view.actions],
    claim_amount: view.claimAmount,
    outstanding_principal: view.outstandingPrincipal,
    outstanding_total: view.outstandingTotal,
    paused_by_sweep: view.pausedBySweep,
    opened_at: view.openedAt,
    closed_at: view.closedAt,
    last_synced_at: view.lastSyncedAt,
    sync_error: view.syncError,
    events: view.events.map((e) => ({
      event_id: e.id,
      occurred_at: e.occurredAt,
      kind: e.kind,
      stage_from: e.stageFrom,
      stage_to: e.stageTo,
      direction: e.direction,
      label: e.label,
      amount: e.amount,
    })),
  }
}

// ---------------------------------------------------------------------------
// collections.candidates.list
// ---------------------------------------------------------------------------

export const collectionsCandidatesList = defineOperation({
  id: 'collections.candidates.list',
  kind: 'read',
  scope: 'invoices:read',
  risk: 'low',
  reversible: false,
  docs: {
    summary: 'List the overdue customer invoices that could be handed over to the company\'s collections provider.',
    description:
      'Overdue customer invoices (due date passed, Europe/Stockholm) that are issued and still owed, checked against the handover rules: SEK and a Swedish customer, at least the company\'s minimum, no open case, a complete postal address, an org number for a business, not time-barred, no ROT/RUT share refused by Skatteverket. The bank check (an unbooked payment that may be this invoice) and a consumer\'s age are checked when the invoice is handed over, not here.',
    useWhen: 'Deciding which overdue invoices to stage for collection with gnubok_send_invoice_to_collection.',
    doNotUseFor: 'Reading an invoice\'s case (gnubok_get_collection_case) or listing every unpaid invoice (GET /invoices).',
    pitfalls: [
      'needs_attestation=true means only a person can hand the invoice over in the web UI (the invoice has no delivery record, was imported, or the customer answered a reminder).',
      'COLLECTIONS_DISABLED or COLLECTIONS_NOT_ACTIVE: the company has not activated collections, or it is switched off on this installation.',
    ],
    example: {
      response: {
        data: {
          candidates: [
            {
              invoice_id: '7d1e…',
              invoice_number: 'F-1042',
              customer_id: '1c2d…',
              customer_name: 'Kund AB',
              due_date: '2026-09-01',
              overdue_days: 33,
              claim_amount: 12500,
              remaining_amount: 12500,
              eligible: true,
              blocks: [],
              needs_attestation: false,
            },
          ],
        },
        meta: META,
      },
    },
  },
  input: z.object({
    include_ineligible: z.boolean().optional().describe('Also list overdue invoices that fail a check, with the checks they fail.'),
  }),
  output: z.object({
    candidates: z.array(
      z.object({
        invoice_id: z.string().uuid(),
        invoice_number: z.string().nullable(),
        customer_id: z.string().nullable(),
        customer_name: z.string().nullable(),
        due_date: z.string(),
        overdue_days: z.number(),
        claim_amount: z.number(),
        remaining_amount: z.number(),
        eligible: z.boolean(),
        blocks: z.array(Block),
        needs_attestation: z.boolean(),
      }),
    ),
  }),
  errorCodes: ['COLLECTIONS_DISABLED', 'COLLECTIONS_NOT_ACTIVE', 'COLLECTIONS_CAPABILITY_BLOCKED'],
  mcp: {
    name: 'gnubok_list_collection_candidates',
    title: 'List Collection Candidates',
    description:
      'List overdue customer invoices that could be handed over to the company\'s collections provider, with the checks each passes or fails. The bank check runs at handover.',
    keywords: ['inkasso', 'påminnelse', 'förfallna fakturor', 'obetalda fakturor', 'skicka till inkasso', 'kravhantering'],
  },
  run: async (ctx, input) => {
    const deps = await serviceDeps(ctx)
    const refused = gateRefusal('handover', deps)
    if (refused) return failure(ctx, refused)
    const connection = await loadLiveConnection(ctx.supabase, ctx.companyId)
    if (!connection) return { ok: false, code: 'COLLECTIONS_NOT_ACTIVE' }
    const provider = await getCollectionsProvider(connection.route)
    const candidates = await listCollectionCandidates(ctx.supabase, {
      companyId: ctx.companyId,
      connection,
      features: provider?.features ?? null,
      includeIneligible: input.include_ineligible === true,
    })
    return { ok: true, data: { candidates } }
  },
})

// ---------------------------------------------------------------------------
// collections.cases.get
// ---------------------------------------------------------------------------

export const collectionsCasesGet = defineOperation({
  id: 'collections.cases.get',
  kind: 'read',
  scope: 'invoices:read',
  risk: 'low',
  reversible: false,
  docs: {
    summary: 'Read an invoice\'s collection case: stage, what the provider waits for, the actions it offers, amounts and timeline.',
    description:
      'The invoice\'s open case, or its latest closed or refused one, re-read from the provider when it was last read more than a minute ago. Works whatever the company\'s plan or switches say: an open case is always readable.',
    useWhen: 'Following up an invoice handed over to collection, or before gnubok_collection_case_action to see which actions the case offers.',
    doNotUseFor: 'Finding invoices to hand over (gnubok_list_collection_candidates).',
    pitfalls: [
      'case=null means the invoice was never handed over.',
      'submission_status=submitted means the handover is still being registered; it is retried automatically.',
    ],
    example: {
      request: { invoice_id: '7d1e…' },
      response: {
        data: {
          case: { case_id: '2b9c…', stage: 'reminder', is_open: true, actions: ['pause', 'withdraw', 'dispute'] },
          withdraw_fee: { may_apply: false, free_days: 14, free_until: '2026-10-20T09:00:00.000Z' },
        },
        meta: META,
      },
    },
  },
  input: z.object({ invoice_id: INVOICE_ID }),
  output: z.object({
    case: CaseView.nullable(),
    withdraw_fee: z
      .object({
        may_apply: z.boolean().describe('Withdrawing now may cost a fee at the provider: tell the user, then pass fee_acknowledged=true.'),
        free_days: z.number().nullable().describe('The days after the handover a withdrawal is free; null when the provider does not say.'),
        free_until: z.string().nullable(),
      })
      .nullable()
      .describe('For an open case: whether withdrawing it may cost a fee.'),
  }),
  errorCodes: ['INVOICE_NOT_FOUND'],
  mcp: {
    name: 'gnubok_get_collection_case',
    title: 'Get Collection Case',
    description:
      'Read an invoice\'s collection case: stage, the decision the provider waits for, the actions it offers now, outstanding amounts and the timeline.',
    keywords: ['inkasso', 'inkassoärende', 'ärende', 'påminnelse', 'kronofogden', 'status inkasso'],
  },
  run: async (ctx, input) => {
    const { data: invoice, error } = await ctx.supabase
      .from('invoices')
      .select('id')
      .eq('company_id', ctx.companyId)
      .eq('id', input.invoice_id)
      .maybeSingle()
    if (error) throw new Error(`invoice lookup failed: ${error.message}`)
    if (!invoice) return { ok: false, code: 'INVOICE_NOT_FOUND' }
    // Refreshing writes what the provider says onto the case: the service role (see serviceDeps).
    const view = await loadInvoiceCase({ db: createServiceClient(), log: ctx.log }, ctx.companyId, input.invoice_id, { refresh: true })
    let withdrawFee: { may_apply: boolean; free_days: number | null; free_until: string | null } | null = null
    if (view?.isOpen) {
      const connection = await loadLiveConnection(ctx.supabase, ctx.companyId)
      const provider = connection ? await getCollectionsProvider(connection.route) : null
      const fee = withdrawFeeInfo(view.openedAt, provider?.features.withdrawFreeDays ?? null, new Date())
      withdrawFee = { may_apply: fee.mayApply, free_days: fee.freeDays, free_until: fee.freeUntil }
    }
    return { ok: true, data: { case: view ? caseOut(view) : null, withdraw_fee: withdrawFee } }
  },
})

// ---------------------------------------------------------------------------
// collections.cases.open
// ---------------------------------------------------------------------------

const ATTESTATION_REFUSED = 'Refused for agents (COLLECTION_ATTESTATION_WEB_ONLY): only a person attests in the web UI.'

export const collectionsCasesOpen = defineOperation({
  id: 'collections.cases.open',
  kind: 'write',
  scope: 'invoices:write',
  // Sends a customer's claim to a collections provider, which starts writing
  // to the customer: external and not undone by a later call (a withdrawal
  // can cost a fee).
  risk: 'high',
  reversible: false,
  docs: {
    summary: 'Hand an overdue customer invoice over to the company\'s collections provider.',
    description:
      'Runs every handover check again (eligibility, the bank check for unbooked payments that may be this invoice, the amount still owed), then registers the claim with the provider, which starts with a reminder or a collection notice. The invoice PDF goes with it. The invoice\'s status does not change; payments recorded later are reported to the provider. The dry run checks everything as reads and contacts no provider.',
    useWhen: 'gnubok_list_collection_candidates lists the invoice as eligible and the customer has not paid.',
    doNotUseFor: 'Invoices that need a person\'s attestation (imported, no delivery record, a customer answer to a reminder, a bank not synced in 24 hours): only a person can hand those over in the web UI.',
    pitfalls: [
      'expected_remaining must equal what is still owed: a payment that arrived meanwhile answers 409 COLLECTION_REMAINING_CHANGED.',
      '409 COLLECTION_BANK_CANDIDATES: an unbooked incoming payment may be this invoice; book it or let a person dismiss it.',
      '409 COLLECTION_BANK_STALE: the account the customer pays to was not synced in 24 hours.',
      '409 COLLECTION_REMINDER_FEE_NOT_AGREED: a reminder needs a reminder fee agreed by the invoice date; omit start_step to start at the inkassokrav.',
      'Approval is web-only: a person approves the staged operation in Accounted.',
    ],
    example: {
      request: { invoice_id: '7d1e…', expected_remaining: 12500, start_step: 'collection' },
      response: { data: { case: { case_id: '2b9c…', stage: 'registered', submission_status: 'registered' }, registered: true }, meta: META },
    },
  },
  input: z.object({
    invoice_id: INVOICE_ID,
    expected_remaining: z.number().min(0).describe('What is still owed on the invoice, from gnubok_list_collection_candidates (remaining_amount).'),
    start_step: z.enum(['reminder', 'collection']).nullable().optional().describe('Where the provider starts; default the company\'s choice.'),
    bank_attested: z.boolean().optional().describe(ATTESTATION_REFUSED),
    delivery_attested: z.boolean().optional().describe(ATTESTATION_REFUSED),
    imported_attested: z.boolean().optional().describe(ATTESTATION_REFUSED),
    response_attested: z.boolean().optional().describe(ATTESTATION_REFUSED),
  }),
  output: z.object({ case: CaseView, registered: z.boolean().describe('False while the handover is still being registered (retried automatically).') }),
  errorCodes: [
    'COLLECTIONS_DISABLED',
    'COLLECTIONS_NOT_ACTIVE',
    'COLLECTIONS_CAPABILITY_BLOCKED',
    'INVOICE_NOT_FOUND',
    'COLLECTION_NOT_ELIGIBLE',
    'COLLECTION_BANK_CANDIDATES',
    'COLLECTION_BANK_STALE',
    'COLLECTION_ATTESTATION_WEB_ONLY',
    'COLLECTION_REMAINING_CHANGED',
    'COLLECTION_CASE_EXISTS',
    'COLLECTION_PAYMENT_HISTORY_UNSUPPORTED',
    'COLLECTION_START_STEP_UNAVAILABLE',
    'COLLECTION_REMINDER_FEE_NOT_AGREED',
  ],
  mcp: {
    name: 'gnubok_send_invoice_to_collection',
    title: 'Send Invoice to Collection',
    description:
      'Stage handing an overdue invoice to the company\'s collections provider. The preview re-runs every check incl. the bank check; nothing is sent until a person approves it in Accounted. Check gnubok_list_collection_candidates first.',
    keywords: ['inkasso', 'skicka till inkasso', 'påminnelse', 'inkassokrav', 'obetald faktura', 'kravhantering'],
    stage: {
      pendingType: 'open_collection_case',
      title: () => 'Skicka faktura till inkasso',
    },
  },
  run: async (ctx, input, { dryRun }) => {
    const deps = await serviceDeps(ctx)
    const outcome = await handOverInvoice(deps, {
      invoiceId: input.invoice_id,
      startStep: input.start_step ?? null,
      expectedRemaining: input.expected_remaining,
      attestations: {
        bank: input.bank_attested,
        delivery: input.delivery_attested,
        imported: input.imported_attested,
        response: input.response_attested,
      },
      dryRun,
    })
    if (!outcome.ok) return failure(ctx, outcome)
    if (outcome.dryRun) return { ok: true, dryRun: true, preview: outcome.preview }
    const events = await loadCaseEvents(deps.db, outcome.case.id)
    return {
      ok: true,
      data: { case: caseOut(caseView(outcome.case, events)), registered: 'registered' in outcome ? outcome.registered : true },
    }
  },
})

// ---------------------------------------------------------------------------
// collections.cases.action
// ---------------------------------------------------------------------------

/** The staged operation's title per action (pending operations are listed in Swedish). */
const ACTION_TITLES_SV: Record<CollectionsAction, string> = {
  start: 'Inkassoärende: starta påminnelser',
  approve_step: 'Inkassoärende: godkänn nästa steg',
  pause: 'Inkassoärende: pausa',
  resume: 'Inkassoärende: återuppta',
  withdraw: 'Inkassoärende: återkalla',
  dispute: 'Inkassoärende: markera som bestridd',
  contest_dispute: 'Inkassoärende: driv vidare trots bestridandet',
  already_paid: 'Inkassoärende: registrera betalningen',
  confirm_not_paid: 'Inkassoärende: fakturan är inte betald',
  approve_legal_action: 'Inkassoärende: godkänn Kronofogden',
  decline_legal_action: 'Inkassoärende: avstå från Kronofogden',
}

export const collectionsCasesAction = defineOperation({
  id: 'collections.cases.action',
  kind: 'write',
  scope: 'invoices:write',
  // Tells the provider what to do with a customer's claim: pause, withdraw,
  // dispute, approve the next step or legal action. External, not undone by
  // a later call.
  risk: 'high',
  reversible: false,
  docs: {
    summary: 'Act on an invoice\'s open collection case: pause, resume, withdraw, mark disputed, or answer what the provider waits for.',
    description:
      'Only the actions the case offers right now are accepted (gnubok_get_collection_case lists them). Pausing, resuming, withdrawing and disputing serve the open case and always run. Approving the next step, contesting a dispute, overriding the customer\'s "already paid" and approving legal action escalate against the customer: they re-run the bank check and only a person can approve them in Accounted.',
    useWhen: 'The case waits for a decision (stage awaiting_decision), the customer disputes the claim, or the company wants to pause or withdraw it.',
    doNotUseFor: 'Recording a payment (mark the invoice paid; it is reported to the provider).',
    pitfalls: [
      'dispute and confirm_not_paid need a message of at least ten characters.',
      'withdraw can cost a fee at the provider once its free period has passed (gnubok_get_collection_case withdraw_fee.may_apply): show the user, then pass fee_acknowledged=true.',
      'already_paid is never sent: record the payment on the invoice instead (409 COLLECTION_REGISTER_PAYMENT); it is reported to the provider.',
      'start is not taken here: starting a delivered invoice is a handover, through gnubok_send_invoice_to_collection (409 COLLECTION_START_VIA_HANDOVER).',
      '409 CONNECTOR_COLLECTIONS_ACTION_UNAVAILABLE: the case does not offer that action in its current stage.',
    ],
    example: {
      request: { invoice_id: '7d1e…', action: 'pause', until: '2026-11-01' },
      response: { data: { case: { case_id: '2b9c…', stage: 'paused' } }, meta: META },
    },
  },
  input: z.object({
    invoice_id: INVOICE_ID,
    action: collectionsActionSchema,
    step: z.enum(['reminder', 'collection']).nullable().optional().describe('For start: where the provider begins.'),
    message: z.string().max(2000).nullable().optional().describe('Required (at least ten characters) for dispute and confirm_not_paid.'),
    until: z.iso
      .date()
      .nullable()
      .optional()
      .describe(`For pause: paused until and including this date, after today and at most ${MAX_PAUSE_DAYS} days ahead.`),
    fee_acknowledged: z
      .boolean()
      .optional()
      .describe(
        'For withdraw: the user has seen that the provider may charge a fee for withdrawing once its free period has passed (gnubok_get_collection_case withdraw_fee). Without it such a withdrawal answers 409 COLLECTION_WITHDRAW_FEE_UNACKNOWLEDGED.',
      ),
  }),
  output: z.object({ case: CaseView }),
  errorCodes: [
    'COLLECTION_CASE_NOT_FOUND',
    'CONNECTOR_COLLECTIONS_ACTION_UNAVAILABLE',
    'COLLECTION_ACTION_MESSAGE_REQUIRED',
    'COLLECTION_START_STEP_UNAVAILABLE',
    'COLLECTION_PAUSE_UNTIL_INVALID',
    'COLLECTION_WITHDRAW_FEE_UNACKNOWLEDGED',
    'COLLECTION_REGISTER_PAYMENT',
    'COLLECTION_START_VIA_HANDOVER',
    'COLLECTION_NOT_ELIGIBLE',
    'COLLECTION_PAYMENT_NOT_REPORTED',
    'COLLECTION_BANK_CANDIDATES',
    'COLLECTION_BANK_STALE',
    'COLLECTION_ATTESTATION_WEB_ONLY',
    'COLLECTIONS_CONNECTION_NOT_FOUND',
    'INVOICE_NOT_FOUND',
    'COLLECTIONS_DISABLED',
    'COLLECTIONS_CAPABILITY_BLOCKED',
  ],
  mcp: {
    name: 'gnubok_collection_case_action',
    title: 'Collection Case Action',
    description:
      'Stage an action on an invoice\'s open collection case (pause, resume, withdraw, dispute, or a decision the provider waits for). Escalations re-run the bank check and need a person\'s approval in Accounted.',
    keywords: ['inkasso', 'pausa inkasso', 'återkalla inkasso', 'bestridd', 'kronofogden', 'godkänn inkassokrav'],
    stage: {
      pendingType: 'collection_case_action',
      title: (input) => ACTION_TITLES_SV[input.action as CollectionsAction] ?? 'Åtgärd i inkassoärende',
    },
  },
  run: async (ctx, input, { dryRun }) => {
    const deps = await serviceDeps(ctx)
    const outcome = await runCaseAction(deps, {
      invoiceId: input.invoice_id,
      action: input.action,
      step: input.step ?? null,
      message: input.message ?? null,
      until: input.until ?? null,
      feeAcknowledged: input.fee_acknowledged === true,
      dryRun,
    })
    if (!outcome.ok) return failure(ctx, outcome)
    if (outcome.dryRun) return { ok: true, dryRun: true, preview: outcome.preview }
    const events = await loadCaseEvents(deps.db, outcome.case.id)
    return { ok: true, data: { case: caseOut(caseView(outcome.case, events)) } }
  },
})

/** Every collections operation, registered only while the feature is switched on (registry.ts). */
export const COLLECTIONS_OPERATION_LIST = [
  collectionsCandidatesList,
  collectionsCasesGet,
  collectionsCasesOpen,
  collectionsCasesAction,
  ...COLLECTIONS_BOOKING_OPERATION_LIST,
] as const
