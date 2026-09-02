import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withConnectorAuth, type ConnectorContext } from '@/lib/connect/hosted/with-connector-auth'
import { reserveUpstream } from '@/lib/connect/hosted/upstream-budget'
import {
  activateByPendingState,
  countHeldConnections,
  createPendingConnection,
  deletePendingConnectionById,
  findByAccountUid,
  revokeByHandle,
  touchConnection,
} from '@/lib/connect/hosted/ledger'
import {
  countActiveConnectorPeppolRegistrations,
  describePeppolUpstreamFailure,
  findOwnedPeppolSubmission,
  isHostedPeppolParticipantLive,
  isPeppolParticipantHeld,
  listActivePeppolParticipants,
  peppolHandle,
  recordPeppolSubmission,
} from '@/lib/connect/hosted/peppol-ledger'
import type { PeppolInboundMessage, PeppolTransport } from '@/lib/invoices/peppol-transport'
import { countLivePeppolRegistrations, getPeppolReceivingCap } from '@/lib/invoices/peppol-registration'
import { QVALIA_PROVIDER, createQvaliaTransport, readQvaliaConfigFromEnv } from '@/lib/invoices/transports/qvalia'

/**
 * Peppol proxy for self-hosted instances (WS3, Peppol upstream).
 *
 * Unlike the bank proxy this is not a path passthrough: the instance speaks
 * the PeppolTransport operations and the hosted side talks to Qvalia with
 * Arcim's partner keys. Reasons: Qvalia URLs embed Arcim's partner and
 * account numbers, the account is shared by every hosted company and every
 * instance (so reads must be scoped to what the caller owns), and the
 * inbound "read" endpoint is destructive (it marks documents read for the
 * whole account, which the hosted inbound cron already does).
 *
 * Ownership model:
 *   - a receiving registration is a ledger row (service 'peppol') whose
 *     account_uids holds the participant id; one participant, one key;
 *   - an outbound submission is a connector_peppol_submissions row; status
 *     polls and evidence reads require it;
 *   - inbound documents are served from the hosted archive
 *     (peppol_inbound_documents, filled by /api/peppol/inbound/cron) filtered
 *     by the participants this key holds, never by calling Qvalia's read
 *     endpoint on the instance's behalf.
 *
 * Switch-on for third-party instances is gated on the Qvalia brokering-terms
 * check (see the migration note): without the `peppol` scope on the key every
 * operation answers 403.
 */

const MAX_DOCUMENT_CHARS = 5_000_000
const COMPANY_HEADER = 'x-connector-company'
const PENDING_STATE_PREFIX = 'peppol:'

const participantSchema = z.object({
  // Peppol participant scheme (ISO 6523 ICD), four digits; not a BAS account.
  scheme: z.string().length(4).regex(/^\d+$/),
  identifier: z.string().trim().min(1).max(64),
})
const documentTypeSchema = z.enum(['Invoice', 'CreditNote'])

const lookupSchema = z.object({ participant: participantSchema })
const submissionSchema = z.object({
  idempotencyKey: z.string().trim().min(1).max(128),
  tenantReference: z.string().trim().min(1).max(128),
  sender: participantSchema,
  recipient: participantSchema,
  documentTypeId: z.string().trim().min(1).max(512),
  processId: z.string().trim().min(1).max(512),
  filename: z.string().trim().min(1).max(255),
  contentType: z.literal('application/xml'),
  document: z.string().min(1).max(MAX_DOCUMENT_CHARS),
  documentSha256: z.string().regex(/^[0-9a-f]{64}$/),
})
const submissionRefSchema = z.object({ providerSubmissionId: z.string().trim().min(1).max(128) })
const registrationSchema = z.object({
  participant: participantSchema,
  businessCard: z.object({
    companyName: z.string().trim().min(1).max(200),
    countryCode: z.string().trim().length(2),
    geographicalInformation: z.string().max(500).nullish(),
    vatNumber: z.string().max(64).nullish(),
    orgNumber: z.string().max(64).nullish(),
  }),
  documentTypes: z.array(z.object({ processId: z.string().min(1).max(512), documentTypeId: z.string().min(1).max(512) })).min(1).max(20),
  description: z.string().max(200).nullish(),
  tenantReference: z.string().max(128).nullish(),
})
const inboundListSchema = z.object({
  documentType: documentTypeSchema,
  limit: z.number().int().min(1).max(100).optional(),
  includeRead: z.boolean().optional(),
})
const inboundXmlSchema = z.object({
  providerDocumentId: z.string().trim().min(1).max(128),
  documentType: documentTypeSchema,
})

function hostedTransport(): PeppolTransport | null {
  const config = readQvaliaConfigFromEnv()
  return config ? createQvaliaTransport(config) : null
}

function pathOf(request: Request): string {
  const idx = request.url.indexOf('/api/connect/peppol')
  const rest = idx === -1 ? '' : request.url.slice(idx + '/api/connect/peppol'.length)
  return rest.split('?')[0].replace(/\/+$/, '') || '/'
}

function companyRef(request: Request): string | null {
  return request.headers.get(COMPANY_HEADER)?.trim() || null
}

function requireScope(ctx: ConnectorContext): NextResponse | null {
  if (ctx.key.scopes.includes('peppol')) return null
  return NextResponse.json(
    { error: 'This connector key does not include Peppol', code: 'CONNECTOR_SCOPE_MISSING' },
    { status: 403 },
  )
}

async function budgetOr429(ctx: ConnectorContext): Promise<NextResponse | null> {
  const budget = await reserveUpstream(ctx.supabase, 'peppol')
  if (budget.ok) return null
  ctx.log.warn('peppol connector budget exhausted', { scope: budget.scope })
  return NextResponse.json(
    { error: 'Peppol connector is busy, try again shortly', code: 'CONNECTOR_RATE_LIMITED', scope: budget.scope },
    { status: 429, headers: { 'Retry-After': String(budget.retryAfterSec) } },
  )
}

async function parseBody<T>(request: Request, schema: z.ZodType<T>): Promise<{ ok: true; value: T } | { ok: false; response: NextResponse }> {
  let raw: unknown
  try {
    raw = await request.json()
  } catch {
    return { ok: false, response: NextResponse.json({ error: 'Invalid JSON', code: 'BAD_REQUEST' }, { status: 400 }) }
  }
  const parsed = schema.safeParse(raw)
  if (!parsed.success) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: 'Invalid request body', code: 'BAD_REQUEST', detail: parsed.error.issues.slice(0, 5).map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') },
        { status: 400 },
      ),
    }
  }
  return { ok: true, value: parsed.data }
}

/**
 * A provider failure is answered with the transport's retryable flag so the
 * instance rethrows an equivalent PeppolTransportError. Anything else is a
 * hosted bug and falls through to the wrapper's 500.
 */
function upstreamFailure(err: unknown, ctx: ConnectorContext, op: string): NextResponse {
  const failure = describePeppolUpstreamFailure(err)
  if (!failure) throw err
  ctx.log.warn(`peppol upstream failed: ${op}`, { text: failure.text, retryable: failure.retryable })
  return NextResponse.json(
    { error: failure.text, code: 'CONNECTOR_UPSTREAM_ERROR', retryable: failure.retryable, detail: failure.hint },
    { status: failure.retryable ? 502 : 422 },
  )
}

function unconfigured(): NextResponse {
  return NextResponse.json(
    { error: 'Peppol access point is not configured on the hosted service', code: 'CONNECTOR_UPSTREAM_UNCONFIGURED', retryable: true },
    { status: 503 },
  )
}
function notAllowed(): NextResponse {
  return NextResponse.json({ error: 'Not allowed', code: 'CONNECTOR_PATH_NOT_ALLOWED' }, { status: 403 })
}
function notOwned(): NextResponse {
  return NextResponse.json({ error: 'Unknown registration or submission for this key', code: 'CONNECTOR_NOT_OWNED' }, { status: 404 })
}
function missingCompany(): NextResponse {
  return NextResponse.json({ error: 'Missing X-Connector-Company header', code: 'CONNECTOR_COMPANY_MISSING' }, { status: 400 })
}
function participantTaken(): NextResponse {
  return NextResponse.json(
    { error: 'That Peppol participant is already registered through another account', code: 'CONNECTOR_PEPPOL_PARTICIPANT_TAKEN', retryable: false },
    { status: 409 },
  )
}

function isUniqueViolation(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err)
  return /23505|idx_connector_connections_handle|duplicate key/i.test(message)
}

export const POST = withConnectorAuth('connect.peppol', async (request, ctx) => {
  const scopeError = requireScope(ctx)
  if (scopeError) return scopeError
  const path = pathOf(request)
  const transport = hostedTransport()
  if (!transport) return unconfigured()

  if (path === '/lookup') {
    const body = await parseBody(request, lookupSchema)
    if (!body.ok) return body.response
    const blocked = await budgetOr429(ctx)
    if (blocked) return blocked
    try {
      return NextResponse.json(await transport.lookupRecipient(body.value.participant))
    } catch (err) {
      return upstreamFailure(err, ctx, 'lookup')
    }
  }

  if (path === '/submit') {
    const cref = companyRef(request)
    if (!cref) return missingCompany()
    const body = await parseBody(request, submissionSchema)
    if (!body.ok) return body.response
    const blocked = await budgetOr429(ctx)
    if (blocked) return blocked
    // The tenant reference the instance signs its delivery with must be the
    // company the request is scoped to; otherwise a key could stage under
    // one company and record ownership under another.
    const submission = { ...body.value, tenantReference: cref }
    let receipt
    try {
      receipt = await transport.submit(submission)
    } catch (err) {
      return upstreamFailure(err, ctx, 'submit')
    }
    await recordPeppolSubmission(ctx.supabase, {
      keyId: ctx.key.id,
      companyRef: cref,
      provider: QVALIA_PROVIDER,
      providerSubmissionId: receipt.providerSubmissionId,
      idempotencyKey: submission.idempotencyKey,
    })
    return NextResponse.json(receipt)
  }

  if (path === '/status' || path === '/evidence') {
    const body = await parseBody(request, submissionRefSchema)
    if (!body.ok) return body.response
    const owned = await findOwnedPeppolSubmission(ctx.supabase, {
      keyId: ctx.key.id,
      provider: QVALIA_PROVIDER,
      providerSubmissionId: body.value.providerSubmissionId,
    })
    if (!owned) return notOwned()
    const blocked = await budgetOr429(ctx)
    if (blocked) return blocked
    try {
      if (path === '/status') {
        const events = transport.pollDeliveryStatus
          ? await transport.pollDeliveryStatus(body.value.providerSubmissionId)
          : []
        return NextResponse.json(events)
      }
      return NextResponse.json(await transport.retrieveEvidence(body.value.providerSubmissionId))
    } catch (err) {
      return upstreamFailure(err, ctx, path.slice(1))
    }
  }

  if (path === '/inbound/list') {
    const body = await parseBody(request, inboundListSchema)
    if (!body.ok) return body.response
    const participants = await listActivePeppolParticipants(ctx.supabase, ctx.key.id)
    if (participants.length === 0) return NextResponse.json([])
    const identifiers = [...new Set(participants.map((p) => p.identifier))]
    const limit = Math.min(Math.max(body.value.limit ?? 25, 1), 100)
    const { data, error } = await ctx.supabase
      .from('peppol_inbound_documents')
      .select('provider_document_id, document_type, ubl_json, received_at, recipient_scheme, recipient_identifier')
      .eq('provider', QVALIA_PROVIDER)
      .eq('document_type', body.value.documentType)
      .in('recipient_identifier', identifiers)
      .order('received_at', { ascending: false })
      .limit(limit)
    if (error) throw new Error(`inbound archive read failed: ${error.message}`)
    const owned = new Set(participants.map(peppolHandle))
    const messages: PeppolInboundMessage[] = []
    for (const row of (data ?? []) as Array<{
      provider_document_id: string
      document_type: 'Invoice' | 'CreditNote'
      ubl_json: Record<string, unknown>
      received_at: string | null
      recipient_scheme: string | null
      recipient_identifier: string | null
    }>) {
      if (!row.recipient_scheme || !row.recipient_identifier) continue
      if (!owned.has(peppolHandle({ scheme: row.recipient_scheme, identifier: row.recipient_identifier }))) continue
      messages.push({
        provider: QVALIA_PROVIDER,
        providerDocumentId: row.provider_document_id,
        documentType: row.document_type,
        payload: row.ubl_json ?? {},
        receivedAt: row.received_at,
      })
    }
    return NextResponse.json(messages)
  }

  if (path === '/inbound/xml') {
    const body = await parseBody(request, inboundXmlSchema)
    if (!body.ok) return body.response
    const participants = await listActivePeppolParticipants(ctx.supabase, ctx.key.id)
    const owned = new Set(participants.map(peppolHandle))
    const { data, error } = await ctx.supabase
      .from('peppol_inbound_documents')
      .select('xml_payload, recipient_scheme, recipient_identifier')
      .eq('provider', QVALIA_PROVIDER)
      .eq('provider_document_id', body.value.providerDocumentId)
      .eq('document_type', body.value.documentType)
      .maybeSingle()
    if (error) throw new Error(`inbound archive read failed: ${error.message}`)
    const row = data as { xml_payload: string | null; recipient_scheme: string | null; recipient_identifier: string | null } | null
    if (!row || !row.recipient_scheme || !row.recipient_identifier) return notOwned()
    if (!owned.has(peppolHandle({ scheme: row.recipient_scheme, identifier: row.recipient_identifier }))) return notOwned()
    if (row.xml_payload) return NextResponse.json({ xml: row.xml_payload })
    // The archive kept JSON but the XML fetch failed at cron time: retry live.
    if (!transport.fetchInboundDocumentXml) return NextResponse.json({ xml: null })
    const blocked = await budgetOr429(ctx)
    if (blocked) return blocked
    try {
      return NextResponse.json({ xml: await transport.fetchInboundDocumentXml(body.value.providerDocumentId, body.value.documentType) })
    } catch (err) {
      return upstreamFailure(err, ctx, 'inbound.xml')
    }
  }

  return notAllowed()
})

export const PUT = withConnectorAuth('connect.peppol', async (request, ctx) => {
  const scopeError = requireScope(ctx)
  if (scopeError) return scopeError
  if (pathOf(request) !== '/recipient') return notAllowed()
  const cref = companyRef(request)
  if (!cref) return missingCompany()
  const body = await parseBody(request, registrationSchema)
  if (!body.ok) return body.response
  const transport = hostedTransport()
  if (!transport) return unconfigured()
  if (!transport.registerRecipient) {
    return NextResponse.json({ error: 'Receiving is not supported by the hosted access point', code: 'PEPPOL_RECEIVING_UNSUPPORTED', retryable: false }, { status: 422 })
  }

  const participant = { scheme: body.value.participant.scheme, identifier: body.value.participant.identifier.replace(/\s/g, '') }
  const handle = peppolHandle(participant)
  const owned = await findByAccountUid(ctx.supabase, { keyId: ctx.key.id, accountUid: handle })

  let pendingId: string | null = null
  let pendingState: string | null = null
  if (!owned) {
    if (await isPeppolParticipantHeld(ctx.supabase, handle)) return participantTaken()
    if (await isHostedPeppolParticipantLive(ctx.supabase, { provider: QVALIA_PROVIDER, participant })) return participantTaken()

    const limit = ctx.key.limits.peppol_connections_per_company
    const quotaExceeded = () =>
      NextResponse.json(
        { error: 'Peppol registration quota reached for this company', code: 'CONNECTOR_QUOTA_EXCEEDED', limit, retryable: false },
        { status: 403 },
      )
    const held = await countHeldConnections(ctx.supabase, ctx.key.id, 'peppol', cref)
    if (held >= limit) return quotaExceeded()

    // The provider account is priced per registered tenant: hosted companies
    // and connector instances share that cap.
    const cap = getPeppolReceivingCap()
    if (cap !== null) {
      const [hosted, connector] = await Promise.all([
        countLivePeppolRegistrations({ supabase: ctx.supabase, provider: QVALIA_PROVIDER }),
        countActiveConnectorPeppolRegistrations(ctx.supabase),
      ])
      if (hosted + connector >= cap) {
        return NextResponse.json(
          { error: 'The access point has no free receiving slot right now', code: 'PEPPOL_REGISTRATION_CAP_REACHED', retryable: false },
          { status: 403 },
        )
      }
    }

    pendingState = `${PENDING_STATE_PREFIX}${crypto.randomUUID()}`
    pendingId = await createPendingConnection(ctx.supabase, {
      keyId: ctx.key.id,
      service: 'peppol',
      companyRef: cref,
      provider: QVALIA_PROVIDER,
      pendingState,
    })
    const heldAfter = await countHeldConnections(ctx.supabase, ctx.key.id, 'peppol', cref)
    if (heldAfter > limit) {
      await deletePendingConnectionById(ctx.supabase, pendingId)
      return quotaExceeded()
    }
  }

  const blocked = await budgetOr429(ctx)
  if (blocked) {
    if (pendingId) await deletePendingConnectionById(ctx.supabase, pendingId)
    return blocked
  }

  let result
  try {
    result = await transport.registerRecipient({
      participant,
      businessCard: body.value.businessCard,
      documentTypes: body.value.documentTypes,
      description: body.value.description ?? null,
    })
  } catch (err) {
    if (pendingId) await deletePendingConnectionById(ctx.supabase, pendingId)
    return upstreamFailure(err, ctx, 'register')
  }

  if (owned) {
    await touchConnection(ctx.supabase, owned.id)
  } else {
    let activated = null
    let activationError: unknown = null
    try {
      activated = await activateByPendingState(ctx.supabase, {
        keyId: ctx.key.id,
        pendingState: pendingState as string,
        handle,
        accountUids: [handle],
      })
    } catch (err) {
      activationError = err
    }
    if (!activated) {
      // Lost a race for the participant (or the row vanished): the upstream
      // registration must not outlive its ledger row.
      if (pendingId) await deletePendingConnectionById(ctx.supabase, pendingId)
      try {
        await transport.unregisterRecipient?.(participant)
      } catch (err) {
        ctx.log.warn('could not roll back upstream peppol registration', { err: err instanceof Error ? err.message : String(err) })
      }
      if (activationError && !isUniqueViolation(activationError)) {
        ctx.log.error('peppol ledger activation failed', activationError as Error)
        return NextResponse.json({ error: 'Could not record the registration', code: 'CONNECTOR_LEDGER_FAILED', retryable: true }, { status: 502 })
      }
      return participantTaken()
    }
  }

  return NextResponse.json({
    status: result.status,
    participant,
    // Arcim's provider account reference stays hosted-side.
    providerAccountReference: 'accounted-connector',
    raw: {},
  })
})

export const DELETE = withConnectorAuth('connect.peppol', async (request, ctx) => {
  const scopeError = requireScope(ctx)
  if (scopeError) return scopeError
  if (pathOf(request) !== '/recipient') return notAllowed()
  const url = new URL(request.url)
  const parsed = participantSchema.safeParse({
    scheme: url.searchParams.get('scheme') ?? '',
    identifier: url.searchParams.get('identifier') ?? '',
  })
  if (!parsed.success) {
    return NextResponse.json({ error: 'scheme and identifier query parameters are required', code: 'BAD_REQUEST' }, { status: 400 })
  }
  const participant = { scheme: parsed.data.scheme, identifier: parsed.data.identifier.replace(/\s/g, '') }
  const handle = peppolHandle(participant)
  const owned = await findByAccountUid(ctx.supabase, { keyId: ctx.key.id, accountUid: handle })
  if (!owned) return notOwned()
  const transport = hostedTransport()
  if (!transport) return unconfigured()
  const blocked = await budgetOr429(ctx)
  if (blocked) return blocked
  try {
    await transport.unregisterRecipient?.(participant)
  } catch (err) {
    return upstreamFailure(err, ctx, 'unregister')
  }
  await revokeByHandle(ctx.supabase, { keyId: ctx.key.id, service: 'peppol', handle })
  return new NextResponse(null, { status: 204 })
})
