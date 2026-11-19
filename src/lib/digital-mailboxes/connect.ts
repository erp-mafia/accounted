/**
 * Connecting a company's mailbox (receiving) and the company as a sender,
 * for both providers. The routes gate on the company admin and call these
 * with the service-role client.
 *
 * Kivra: the company activates Accounted at Kivra (partner-adapted
 * onboarding, a Kivra-hosted page), so connecting here records the intent
 * (pending) and hands back the link; the activation arrives as the
 * integration.created webhook, or the sync finds the company by its
 * organisationsnummer.
 *
 * Billo: Accounted creates the company's Billo business mailbox itself,
 * with the company's details and the admin as its representative. Billo
 * requires the representative's personnummer; it is read from the admin's
 * own BankID login, never typed, so only a BankID-verified admin can create
 * one.
 *
 * Neither provider has a business mailbox for an enskild firma (its
 * organisationsnummer is the owner's personnummer), so receiving is offered
 * to legal persons only.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { signerPersonalNumberFromBankIdLogin } from '@/lib/auth/bankid-signer'
import { isLegalPersonOrgNumber, normalizeOrgNumber } from '@/lib/invariants/org-number'
import type { Logger } from '@/lib/logger'
import { BILLO_ALREADY_ENROLLED, type BilloProvider } from './billo'
import { isDigitalMailboxApiError } from './http'
import {
  SENDER_REQUEST_KEY,
  connectionError,
  getConnection,
  listPendingSenderConnections,
  receiveSinceFrom,
  senderRequestOf,
  updateConnection,
  upsertConnection,
  withoutSenderRequest,
  updateConnectionIfUnchanged,
  type ConnectionPatch,
  type DigitalMailboxConnection,
  type SenderRequest,
} from './connections'
import { orgNumberFromVatNumber } from './identifiers'
import { KIVRA_SENDER_ELSEWHERE, type KivraProvider } from './kivra'
import { getDigitalMailboxProviders, isDigitalMailboxEnabled } from './providers'
import { DIGITAL_MAILBOX_PROVIDERS, type DigitalMailboxProviderId, type MailboxSender, type SenderRegistration } from './types'

/** Why connecting cannot start; each maps to a structured error code in the route. */
export type ConnectRefusal =
  | 'DIGITAL_MAILBOX_NOT_CONFIGURED'
  | 'DIGITAL_MAILBOX_SANDBOX'
  | 'DIGITAL_MAILBOX_ORG_NUMBER_MISSING'
  | 'DIGITAL_MAILBOX_SOLE_TRADER_UNSUPPORTED'
  | 'DIGITAL_MAILBOX_ADDRESS_MISSING'
  | 'DIGITAL_MAILBOX_BANKID_REQUIRED'
  | 'DIGITAL_MAILBOX_ALREADY_CONNECTED'
  | 'DIGITAL_MAILBOX_PROVIDER_FAILED'
  | 'DIGITAL_MAILBOX_ALREADY_ENROLLED_ELSEWHERE'
  | 'DIGITAL_MAILBOX_SENDER_ELSEWHERE'
  | 'DIGITAL_MAILBOX_SENDER_REQUEST_REJECTED'

export type ConnectOutcome<T> = { ok: true; data: T } | { ok: false; code: ConnectRefusal; reason?: string }

export interface CompanyIdentity {
  companyId: string
  name: string
  /** Ten digits. */
  orgNumber: string | null
  addressLine1: string | null
  postalCode: string | null
  city: string | null
  isSandbox: boolean
}

export async function loadCompanyIdentity(service: SupabaseClient, companyId: string): Promise<CompanyIdentity | null> {
  const { data, error } = await service
    .from('company_settings')
    .select('company_name, org_number, address_line1, postal_code, city, is_sandbox')
    .eq('company_id', companyId)
    .maybeSingle()
  if (error) throw new Error(`company settings read failed: ${error.message}`)
  if (!data) return null
  const row = data as {
    company_name: string | null
    org_number: string | null
    address_line1: string | null
    postal_code: string | null
    city: string | null
    is_sandbox: boolean | null
  }
  return {
    companyId,
    name: row.company_name?.trim() || '',
    orgNumber: normalizeOrgNumber(row.org_number),
    addressLine1: row.address_line1?.trim() || null,
    postalCode: row.postal_code?.replace(/\s/g, '') || null,
    city: row.city?.trim() || null,
    isSandbox: row.is_sandbox === true,
  }
}

function receivingGate(identity: CompanyIdentity | null): ConnectRefusal | null {
  if (!identity) return 'DIGITAL_MAILBOX_ORG_NUMBER_MISSING'
  // The demo company never reaches a provider: it would open a real mailbox.
  if (identity.isSandbox) return 'DIGITAL_MAILBOX_SANDBOX'
  if (!identity.orgNumber || !identity.name) return 'DIGITAL_MAILBOX_ORG_NUMBER_MISSING'
  // Neither Kivra Företag nor Billo's business mailbox takes an enskild firma's personnummer.
  if (!isLegalPersonOrgNumber(identity.orgNumber)) return 'DIGITAL_MAILBOX_SOLE_TRADER_UNSUPPORTED'
  return null
}

function errorReason(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

// ---------------------------------------------------------------------------
// Kivra
// ---------------------------------------------------------------------------

export interface KivraConnectResult {
  connection: DigitalMailboxConnection
  /** Where the admin activates Accounted at Kivra; null once the activation is seen. */
  onboardingUrl: string | null
}

/**
 * Start (or resume) reading the company's Kivra Företag inbox. Looks the
 * company up at once: a company that already activated Accounted at Kivra
 * is active without a round trip through the onboarding page.
 */
export async function connectKivraReceive(
  service: SupabaseClient,
  args: { companyId: string; userId: string; log: Logger },
): Promise<ConnectOutcome<KivraConnectResult>> {
  const kivra = getDigitalMailboxProviders().kivra
  if (!kivra?.receiver || !isDigitalMailboxEnabled(args.companyId)) return { ok: false, code: 'DIGITAL_MAILBOX_NOT_CONFIGURED' }
  const identity = await loadCompanyIdentity(service, args.companyId)
  const refusal = receivingGate(identity)
  if (refusal) return { ok: false, code: refusal }

  const existing = await getConnection(service, args.companyId, 'kivra')
  if (existing?.receive_state === 'active') {
    return { ok: true, data: { connection: existing, onboardingUrl: null } }
  }

  let connection = await upsertConnection(service, args.companyId, 'kivra', {
    receive_state: 'pending',
    account_ref: null,
    receive_connected_by: args.userId,
    receive_connected_at: new Date().toISOString(),
    receive_since: receiveSinceFrom(),
    receive_ended_at: null,
    last_error: null,
    last_error_at: null,
  })

  const activated = await activatePendingKivra(service, kivra, connection, identity!.orgNumber!, args.log)
  if (activated) connection = activated
  return {
    ok: true,
    data: { connection, onboardingUrl: connection.receive_state === 'active' ? null : kivra.config.onboardingUrl },
  }
}

/**
 * A pending Kivra row becomes active once Kivra lists the company for
 * Accounted. Answers the updated row, or null while Kivra does not list it
 * yet (or the lookup failed, which is recorded on the row).
 */
export async function activatePendingKivra(
  service: SupabaseClient,
  kivra: KivraProvider,
  connection: DigitalMailboxConnection,
  orgNumber: string,
  log: Logger,
): Promise<DigitalMailboxConnection | null> {
  if (!kivra.receiver) return null
  let companyKey: string | null
  try {
    companyKey = await kivra.receiver.findCompanyKey(orgNumber)
  } catch (err) {
    log.warn('kivra company lookup failed', { companyId: connection.company_id, reason: errorReason(err) })
    await updateConnection(service, connection, connectionError(errorReason(err)))
    return null
  }
  if (!companyKey) return null
  return activateKivraConnection(service, connection, companyKey, log)
}

async function activateKivraConnection(
  service: SupabaseClient,
  connection: DigitalMailboxConnection,
  companyKey: string,
  log: Logger,
): Promise<DigitalMailboxConnection | null> {
  try {
    return await upsertConnection(service, connection.company_id, 'kivra', {
      receive_state: 'active',
      account_ref: companyKey,
      receive_since: connection.receive_since ?? receiveSinceFrom(),
      receive_connected_at: connection.receive_connected_at ?? new Date().toISOString(),
      last_error: null,
      last_error_at: null,
    })
  } catch (err) {
    // The one-reader index: another company already reads this Kivra inbox.
    log.warn('kivra activation refused', { companyId: connection.company_id, reason: errorReason(err) })
    await updateConnection(service, connection, connectionError('Kivra-brevlådan läses redan av ett annat företag i Accounted.'))
    return null
  }
}

/**
 * Kivra's integration.created: the company activated Accounted. The company
 * that started connecting wins; otherwise the one live company with that
 * organisationsnummer (activation started from Kivra's own partner list).
 * Answers the company id it bound, or null when it could not tell which.
 */
export async function onKivraIntegrationCreated(
  service: SupabaseClient,
  event: { companyKey: string; vatNumber: string | null },
  log: Logger,
): Promise<string | null> {
  const orgNumber = orgNumberFromVatNumber(event.vatNumber)
  if (!orgNumber) {
    log.warn('kivra integration.created without a usable vat_number')
    return null
  }

  const { data: pending } = await service
    .from('digital_mailbox_connections')
    .select('id, company_id, receive_state, receive_since, receive_connected_at, receive_connected_by')
    .eq('provider', 'kivra')
    .in('receive_state', ['pending', 'active'])
  const rows = (pending as DigitalMailboxConnection[] | null) ?? []

  const candidates = await companiesWithOrgNumber(service, orgNumber)
  const started = rows.filter((r) => candidates.includes(r.company_id))
  const already = started.find((r) => r.receive_state === 'active')
  if (already) return already.company_id

  let target: DigitalMailboxConnection | null = started.find((r) => r.receive_state === 'pending') ?? null
  if (!target) {
    if (candidates.length !== 1) {
      log.warn('kivra integration.created matches no single company', { candidates: candidates.length })
      return null
    }
    target = await upsertConnection(service, candidates[0]!, 'kivra', {
      receive_state: 'pending',
      receive_since: receiveSinceFrom(),
      receive_connected_at: new Date().toISOString(),
    })
  }
  const activated = await activateKivraConnection(service, target, event.companyKey, log)
  return activated?.company_id ?? null
}

/** Kivra's integration.deleted: the company switched Accounted off at Kivra. */
export async function onKivraIntegrationDeleted(service: SupabaseClient, companyKey: string): Promise<number> {
  const { data, error } = await service
    .from('digital_mailbox_connections')
    .update({ receive_state: 'ended', receive_ended_at: new Date().toISOString() })
    .eq('provider', 'kivra')
    .eq('account_ref', companyKey)
    .in('receive_state', ['pending', 'active'])
    .select('id')
  if (error) throw new Error(`kivra deactivation failed: ${error.message}`)
  return (data as unknown[] | null)?.length ?? 0
}

/** Live (not archived, not sandbox) companies whose organisationsnummer is `orgNumber`. */
async function companiesWithOrgNumber(service: SupabaseClient, orgNumber: string): Promise<string[]> {
  const dashed = `${orgNumber.slice(0, 6)}-${orgNumber.slice(6)}`
  const { data, error } = await service
    .from('company_settings')
    .select('company_id, is_sandbox, companies!inner(archived_at)')
    .in('org_number', [orgNumber, dashed])
    .is('companies.archived_at', null)
  if (error) throw new Error(`company lookup failed: ${error.message}`)
  return ((data as Array<{ company_id: string; is_sandbox: boolean | null }> | null) ?? [])
    .filter((row) => row.is_sandbox !== true)
    .map((row) => row.company_id)
}

// ---------------------------------------------------------------------------
// Billo
// ---------------------------------------------------------------------------

export interface BilloRepresentativeInput {
  email: string
  /** E.164, +46... */
  phone: string
}

/** What the create dialog shows before anything leaves Accounted. */
export interface BilloRepresentativePreview {
  name: string | null
  /** Masked: only that a BankID personnummer is on file, never the number. */
  hasBankIdPersonnummer: boolean
}

export async function billoRepresentativePreview(service: SupabaseClient, userId: string): Promise<BilloRepresentativePreview> {
  const { data } = await service.from('bankid_identities').select('given_name, surname').eq('user_id', userId).maybeSingle()
  const row = data as { given_name: string | null; surname: string | null } | null
  const name = row ? [row.given_name, row.surname].filter(Boolean).join(' ').trim() || null : null
  return { name, hasBankIdPersonnummer: !!row && !!(await signerPersonalNumberFromBankIdLogin(userId)) }
}

/** Create the company's Billo business mailbox and start reading it. */
export async function connectBilloReceive(
  service: SupabaseClient,
  args: { companyId: string; userId: string; representative: BilloRepresentativeInput; log: Logger },
): Promise<ConnectOutcome<DigitalMailboxConnection>> {
  const billo: BilloProvider | null = getDigitalMailboxProviders().billo
  if (!billo?.receiver || !isDigitalMailboxEnabled(args.companyId)) return { ok: false, code: 'DIGITAL_MAILBOX_NOT_CONFIGURED' }
  const identity = await loadCompanyIdentity(service, args.companyId)
  const refusal = receivingGate(identity)
  if (refusal) return { ok: false, code: refusal }
  if (!identity!.addressLine1 || !identity!.postalCode || !identity!.city) {
    return { ok: false, code: 'DIGITAL_MAILBOX_ADDRESS_MISSING' }
  }

  const existing = await getConnection(service, args.companyId, 'billo')
  if (existing?.receive_state === 'active') return { ok: false, code: 'DIGITAL_MAILBOX_ALREADY_CONNECTED' }

  const personnummer = await signerPersonalNumberFromBankIdLogin(args.userId)
  const preview = await billoRepresentativePreview(service, args.userId)
  if (!personnummer || !preview.name) return { ok: false, code: 'DIGITAL_MAILBOX_BANKID_REQUIRED' }

  let enrolment
  try {
    enrolment = await billo.receiver.createBusinessMailbox({
      orgNumber: identity!.orgNumber!,
      companyName: identity!.name,
      addressLine1: identity!.addressLine1!,
      postalCode: identity!.postalCode!,
      city: identity!.city!,
      representative: {
        name: preview.name,
        personnummer,
        email: args.representative.email,
        phone: args.representative.phone,
      },
    })
  } catch (err) {
    const reason = errorReason(err)
    args.log.warn('billo mailbox creation failed', { companyId: args.companyId, reason })
    // createBusinessMailbox already took over our own earlier enrolment, so
    // a conflict left standing is another partner's.
    const elsewhere = isDigitalMailboxApiError(err) && err.kind === 'conflict' && err.providerCode === BILLO_ALREADY_ENROLLED
    return { ok: false, code: elsewhere ? 'DIGITAL_MAILBOX_ALREADY_ENROLLED_ELSEWHERE' : 'DIGITAL_MAILBOX_PROVIDER_FAILED', reason }
  }

  await ensureBilloWebhook(billo, args.log)

  const now = new Date().toISOString()
  const connection = await upsertConnection(service, args.companyId, 'billo', {
    receive_state: 'active',
    account_ref: enrolment.partnerCustomerId,
    mailbox_ref: enrolment.enrollmentId,
    receive_connected_by: args.userId,
    receive_connected_at: now,
    // Billo shows only what arrives after the enrolment.
    receive_since: now,
    receive_ended_at: null,
    last_error: null,
    last_error_at: null,
    provider_meta: {
      ...(existing?.provider_meta ?? {}),
      enrolment_status: enrolment.status,
      customer_number: enrolment.customerNumber,
      billo_address: enrolment.billoAddress,
      mandate: 'not_required',
      consented_by: args.userId,
      consented_at: now,
    },
  })
  return { ok: true, data: connection }
}

let billoWebhookRegistered = false

/**
 * Billo delivers new-document events to one webhook on Accounted's partner
 * customer, for every company enrolled under it, registered with
 * BILLO_WEBHOOK_URL and BILLO_WEBHOOK_SECRET (an upsert, so repeating it
 * is harmless). Done once per process when a mailbox is created; without the
 * two settings the cron sweep alone reads the mailboxes. Never fails the
 * connection.
 */
async function ensureBilloWebhook(billo: BilloProvider, log: Logger): Promise<void> {
  const url = process.env.BILLO_WEBHOOK_URL?.trim()
  const secret = billo.config.webhookSecret
  if (billoWebhookRegistered || !billo.receiver || !url || !secret || !/^https:\/\//i.test(url)) return
  try {
    await billo.receiver.registerWebhook(url, secret)
    billoWebhookRegistered = true
  } catch (err) {
    log.warn('billo webhook registration failed; the sweep reads the mailboxes', { reason: errorReason(err) })
  }
}

// ---------------------------------------------------------------------------
// Both providers
// ---------------------------------------------------------------------------

/** Stop reading the mailbox. Billo's enrolment is ended at Billo too; Kivra's is the company's own to switch off at Kivra. */
export async function disconnectReceive(
  service: SupabaseClient,
  args: { companyId: string; provider: DigitalMailboxProviderId; log: Logger },
): Promise<DigitalMailboxConnection | null> {
  const connection = await getConnection(service, args.companyId, args.provider)
  if (!connection || connection.receive_state === 'off' || connection.receive_state === 'ended') return connection

  if (args.provider === 'billo' && connection.account_ref && connection.mailbox_ref) {
    const billo = getDigitalMailboxProviders().billo
    if (billo?.receiver) {
      await billo.receiver.disconnect({ accountRef: connection.account_ref, mailboxRef: connection.mailbox_ref })
    }
  }
  return upsertConnection(service, args.companyId, args.provider, {
    receive_state: 'ended',
    receive_ended_at: new Date().toISOString(),
  })
}

/**
 * Register the company as a sender (tenant) at the provider, so its invoices
 * and payslips can go to recipients' mailboxes. Idempotent: an active
 * sender is answered as it is.
 */
export async function activateSending(
  service: SupabaseClient,
  args: { companyId: string; userId: string; provider: DigitalMailboxProviderId; log: Logger },
): Promise<ConnectOutcome<DigitalMailboxConnection>> {
  const provider = getDigitalMailboxProviders()[args.provider]
  if (!provider?.sender || !isDigitalMailboxEnabled(args.companyId)) return { ok: false, code: 'DIGITAL_MAILBOX_NOT_CONFIGURED' }
  const identity = await loadCompanyIdentity(service, args.companyId)
  if (!identity || !identity.orgNumber || !identity.name) return { ok: false, code: 'DIGITAL_MAILBOX_ORG_NUMBER_MISSING' }
  if (identity.isSandbox) return { ok: false, code: 'DIGITAL_MAILBOX_SANDBOX' }

  const existing = await getConnection(service, args.companyId, args.provider)
  if (existing?.send_state === 'active' && existing.tenant_ref) return { ok: true, data: existing }

  // A request already waiting is asked about, not made again.
  const waiting = senderRequestOf(existing)
  const sender: MailboxSender = provider.sender
  let registration: SenderRegistration
  try {
    registration =
      waiting?.status === 'pending' && sender.checkSenderRequest
        ? await sender.checkSenderRequest(waiting.ref)
        : await sender.registerSender({ orgNumber: identity.orgNumber, name: identity.name })
  } catch (err) {
    const reason = errorReason(err)
    args.log.warn('digital mailbox sender registration failed', { companyId: args.companyId, provider: args.provider, reason })
    // The company sends through another service and the provider would not take the access request: retrying will not help.
    const elsewhere = isDigitalMailboxApiError(err) && err.kind === 'conflict' && err.providerCode === KIVRA_SENDER_ELSEWHERE
    return { ok: false, code: elsewhere ? 'DIGITAL_MAILBOX_SENDER_ELSEWHERE' : 'DIGITAL_MAILBOX_PROVIDER_FAILED', reason }
  }
  const connection = await recordSenderRegistration(service, {
    companyId: args.companyId,
    provider: args.provider,
    existing,
    registration,
    requestedBy: args.userId,
  })
  if (registration.status === 'rejected') return { ok: false, code: 'DIGITAL_MAILBOX_SENDER_REQUEST_REJECTED' }
  return { ok: true, data: connection! }
}

/**
 * Write where the sender registration stands. Active switches sending on and
 * drops any access request; pending and rejected keep send_state as it was
 * and record the request in provider_meta, the rest of which is kept.
 */
async function recordSenderRegistration(
  service: SupabaseClient,
  args: {
    companyId: string
    provider: DigitalMailboxProviderId
    existing: DigitalMailboxConnection | null
    registration: SenderRegistration
    /** Who asked for sending: the admin, or for the cron the admin who made the request. */
    requestedBy: string | null
    /**
     * Write only onto the row as `existing` was read (the cron): an admin who
     * switched sending off while Kivra answered has dropped the request, and
     * an acceptance must not switch it back on. Null when the row moved on.
     */
    onlyIfUnchanged?: boolean
  },
): Promise<DigitalMailboxConnection | null> {
  const { registration, existing } = args
  const meta = existing?.provider_meta ?? {}
  const write = (patch: ConnectionPatch) =>
    args.onlyIfUnchanged && existing
      ? updateConnectionIfUnchanged(service, existing, patch)
      : upsertConnection(service, args.companyId, args.provider, patch)
  if (registration.status === 'active') {
    return write({
      send_state: 'active',
      tenant_ref: registration.tenantRef,
      send_activated_by: args.requestedBy,
      send_activated_at: new Date().toISOString(),
      provider_meta: withoutSenderRequest(meta),
    })
  }
  const earlier = senderRequestOf(existing)
  const ref = registration.requestRef
  const request: SenderRequest = {
    ref,
    status: registration.status,
    // The same request keeps the time it was first made.
    requested_at: earlier?.ref === ref && earlier.requested_at ? earlier.requested_at : new Date().toISOString(),
    requested_by: args.requestedBy,
  }
  return write({ provider_meta: { ...meta, [SENDER_REQUEST_KEY]: request } })
}

export interface SenderRequestSweep {
  checked: number
  activated: number
  rejected: number
  errors: Array<{ companyId: string; provider: string; reason: string }>
}

/**
 * The cron's follow-up of access requests that wait for the provider: an
 * accepted one switches sending on, as if the admin had switched it on then.
 * Kivra has no webhook for these, so asking is the only way to learn.
 */
export async function checkPendingSenderRequests(service: SupabaseClient, args: { log: Logger }): Promise<SenderRequestSweep> {
  const summary: SenderRequestSweep = { checked: 0, activated: 0, rejected: 0, errors: [] }
  const providers = getDigitalMailboxProviders()
  const senderOf = (id: DigitalMailboxProviderId): MailboxSender | null => providers[id]?.sender ?? null
  if (!DIGITAL_MAILBOX_PROVIDERS.some((id) => senderOf(id)?.checkSenderRequest)) return summary
  const rows = await listPendingSenderConnections(service)
  for (const row of rows) {
    const sender = senderOf(row.provider)
    const request = senderRequestOf(row)
    if (!sender?.checkSenderRequest || request?.status !== 'pending' || !isDigitalMailboxEnabled(row.company_id)) continue
    summary.checked++
    try {
      const registration = await sender.checkSenderRequest(request.ref)
      if (registration.status === 'pending') continue
      const written = await recordSenderRegistration(service, {
        companyId: row.company_id,
        provider: row.provider,
        existing: row,
        registration,
        requestedBy: request.requested_by,
        onlyIfUnchanged: true,
      })
      // The row changed while Kivra answered (switched off, or written by another run): the next run asks again.
      if (!written) continue
      if (registration.status === 'active') summary.activated++
      else summary.rejected++
      args.log.info('digital mailbox sender access request decided', {
        companyId: row.company_id,
        provider: row.provider,
        status: registration.status,
      })
    } catch (err) {
      summary.errors.push({ companyId: row.company_id, provider: row.provider, reason: errorReason(err) })
    }
  }
  return summary
}

/**
 * Stop sending through the provider. The tenant stays at the provider;
 * nothing more goes through it from Accounted. An access request still
 * waiting is dropped, so an acceptance later does not switch sending on.
 */
export async function deactivateSending(
  service: SupabaseClient,
  args: { companyId: string; provider: DigitalMailboxProviderId },
): Promise<DigitalMailboxConnection | null> {
  const connection = await getConnection(service, args.companyId, args.provider)
  if (connection && senderRequestOf(connection)) {
    return upsertConnection(service, args.companyId, args.provider, { provider_meta: withoutSenderRequest(connection.provider_meta) })
  }
  if (!connection || connection.send_state !== 'active') return connection
  return upsertConnection(service, args.companyId, args.provider, { send_state: 'ended' })
}
