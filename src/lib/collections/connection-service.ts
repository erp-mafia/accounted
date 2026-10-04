import { createHash } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import type {
  CollectionsConnection,
  CollectionsFeatures,
  CollectionsOnboardingRequest,
  CollectionsSettings,
} from '@accounted/connect-contract'
import { resolveCompanyEntityType, usesPersonnummerAsOrgNumber } from '@/lib/company/entity-type'
import { todayIsoStockholm } from '@/lib/dates/iso'
import { normalizeOrgNumber } from '@/lib/invariants/org-number'
import { createLogger } from '@/lib/logger'
import { roundOre } from '@/lib/money'
import { isSandboxCompany } from '@/lib/sandbox/guard'
import type { EntityType } from '@/types'
import {
  findPayoutOption,
  isEmail,
  normalizeOwnerPersonalNumber,
  normalizeVatNumber,
  ownerPersonalNumberFromOrgNumber,
  payoutOptions,
  validateCompanyStep,
  validateKycStep,
  validateRulesStep,
  type ActivationErrorKey,
  type ConsentBody,
  type OnboardingBody,
  type PayoutOption,
  type PayoutSourceAccount,
  type SettingsPatch,
  type SignatureBody,
  type TermsBody,
} from './activation-form'
import { collectionsAdapterFor } from './adapters'
import { getCollectionsProvider, type CatalogueCapabilityEntry } from './catalogue'
import {
  failurePatch,
  loadCollectionObligations,
  loadLiveConnection,
  normalizeConnectionRow,
  snapshotPatch,
  type CollectionConnectionRow,
} from './connection'
import {
  COLLECTIONS_CONNECTION_EXISTS,
  COLLECTIONS_CONNECTION_NOT_FOUND,
  COLLECTIONS_CONNECTION_STEP,
  COLLECTIONS_DISABLED,
  COLLECTIONS_DISCONNECT_BLOCKED,
  COLLECTIONS_ORG_NUMBER_MISSING,
  COLLECTIONS_OWNER_NUMBER_MISMATCH,
  COLLECTIONS_PAYOUT_ACCOUNT_INVALID,
  COLLECTIONS_PROVIDER_UNAVAILABLE,
  COLLECTIONS_TERMS_CHANGED,
  COLLECTIONS_UNAVAILABLE,
  CollectionsError,
} from './errors'
import { hasCollectionObligations, readCollectionsEnv, type CollectionsEnv } from './flags'
import type { CollectionsAdapter, CollectionsCallContext, CollectionsRoute } from './port'
import { chooseCollectionsRoute } from './registry'

const log = createLogger('collections/connection')

/**
 * The company's collections connection: consent, onboarding, the provider's
 * terms, signature, status, settings and ending it (build spec 1.7, 3.2).
 *
 * Order of events, so nothing about the company leaves the app before an
 * admin has read the terms and agreed:
 *   1. recordConsent: a row in connecting / not_started, no provider call.
 *   2. submitOnboarding: the company, know-your-customer answers and rules go
 *      to the provider; when its terms are the version the admin consented
 *      to, they are accepted at once with that consent.
 *   3. acceptTerms: only when the provider presents another version.
 *   4. startSignature: a firmatecknare signs at the provider.
 *   5. the status poll (refreshConnection, also the sync cron) follows the
 *      provider's review until the connection is active.
 *
 * Writes go through the service-role client the caller passes, always
 * filtered by company. Gating (kill switch, pilot, capability, admin) is the
 * caller's: flags.ts and the route. Every provider call carries an
 * idempotency key built from the row id, so a retry after a timeout replays
 * instead of repeating; a write whose body changes gets a new key.
 */

export interface ConnectionActor {
  userId: string
  /** Name or e-mail, sent to the provider as who consented or accepted. */
  name: string
  email: string | null
}

export interface ConnectionServiceDeps {
  /** Service-role client: reads and writes, always filtered by company. */
  db: SupabaseClient
  companyId: string
  /** null: the system (the sync cron). */
  actor: ConnectionActor | null
  env?: CollectionsEnv
  adapterFor?: (connection: { route: CollectionsRoute }) => CollectionsAdapter | null
  provider?: (route: CollectionsRoute) => Promise<CatalogueCapabilityEntry<CollectionsFeatures> | null>
  isSandbox?: (db: SupabaseClient, companyId: string) => Promise<boolean>
  now?: () => Date
}

/** Field errors the route answers as a validation error (keys, worded by the browser). */
export class ActivationValidationError extends Error {
  constructor(readonly errors: Record<string, ActivationErrorKey>) {
    super('Activation form invalid')
    this.name = 'ActivationValidationError'
  }
}

function fail(code: string, message?: string): never {
  throw new CollectionsError(message ?? code, { code, retryable: false })
}

function nowOf(deps: ConnectionServiceDeps): Date {
  return deps.now ? deps.now() : new Date()
}

/** A JSON form with sorted keys, so the same body always hashes the same. */
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableJson((value as Record<string, unknown>)[k])}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

/**
 * `<row id>:<operation>`, plus a digest of the body when the same operation
 * may legitimately be sent again with other content (a corrected
 * application, other settings): the same content replays, new content is a
 * new request instead of an idempotency mismatch.
 */
export function connectionIdempotencyKey(rowId: string, operation: string, body?: unknown): string {
  if (body === undefined) return `${rowId}:${operation}`
  const digest = createHash('sha256').update(stableJson(body)).digest('hex').slice(0, 16)
  return `${rowId}:${operation}:${digest}`
}

function callContext(row: CollectionConnectionRow): CollectionsCallContext {
  return { companyId: row.company_id, connectionHandle: row.connection_handle }
}

function adapterFor(deps: ConnectionServiceDeps, route: CollectionsRoute): CollectionsAdapter | null {
  return (deps.adapterFor ?? collectionsAdapterFor)({ route })
}

function requireAdapter(deps: ConnectionServiceDeps, row: CollectionConnectionRow): CollectionsAdapter {
  const adapter = adapterFor(deps, row.route)
  if (!adapter) fail(COLLECTIONS_UNAVAILABLE)
  return adapter
}

async function requireLive(deps: ConnectionServiceDeps): Promise<CollectionConnectionRow> {
  const row = await loadLiveConnection(deps.db, deps.companyId)
  if (!row) fail(COLLECTIONS_CONNECTION_NOT_FOUND)
  return row
}

/** Update the row and read it back. Every write names its actor (NULL = the system), which the audit trigger records. */
async function writeRow(
  deps: ConnectionServiceDeps,
  row: CollectionConnectionRow,
  patch: Partial<CollectionConnectionRow>,
): Promise<CollectionConnectionRow> {
  const payload: Partial<CollectionConnectionRow> = { ...patch, user_id: deps.actor?.userId ?? null }
  const { data, error } = await deps.db
    .from('collection_connections')
    .update(payload)
    .eq('id', row.id)
    .eq('company_id', deps.companyId)
    .select('*')
    .single()
  if (error) {
    if (/COLLECTIONS_DISCONNECT_BLOCKED/.test(error.message)) fail(COLLECTIONS_DISCONNECT_BLOCKED)
    if (/cannot be reopened/.test(error.message)) fail(COLLECTIONS_CONNECTION_STEP)
    throw new Error(`collection_connections update failed: ${error.message}`)
  }
  return normalizeConnectionRow(data as Record<string, unknown>)
}

/** Record the outcome of a provider call on the row's run record, then rethrow a failure. */
async function withProvider<T>(
  deps: ConnectionServiceDeps,
  row: CollectionConnectionRow,
  call: () => Promise<T>,
): Promise<T> {
  try {
    return await call()
  } catch (error) {
    if (error instanceof CollectionsError) {
      try {
        await writeRow(deps, row, failurePatch(row, error, nowOf(deps)))
      } catch (writeError) {
        log.error('failed to record a provider failure on the connection', writeError as Error, { connectionId: row.id })
      }
    }
    throw error
  }
}

async function applySnapshot(
  deps: ConnectionServiceDeps,
  row: CollectionConnectionRow,
  snapshot: CollectionsConnection,
  extra: Partial<CollectionConnectionRow> = {},
): Promise<CollectionConnectionRow> {
  return writeRow(deps, row, { ...snapshotPatch(row, snapshot, nowOf(deps)), ...extra })
}

async function personName(db: SupabaseClient, userId: string): Promise<string> {
  const { data } = await db.from('profiles').select('full_name, email').eq('id', userId).maybeSingle()
  const profile = data as { full_name: string | null; email: string | null } | null
  return profile?.full_name?.trim() || profile?.email?.trim() || userId
}

// ---------------------------------------------------------------------------
// What the company brings to an application
// ---------------------------------------------------------------------------

export interface ActivationCompany {
  name: string
  orgNumber: string | null
  entityType: EntityType
  /** Enskild firma: the owner's personnummer goes with the application. */
  soleTrader: boolean
  ownerPersonalNumber: string | null
  addressLine1: string | null
  addressLine2: string | null
  postalCode: string | null
  city: string | null
  email: string | null
  phone: string | null
  vatRegistered: boolean
  vatNumber: string | null
}

export interface ActivationContext {
  company: ActivationCompany
  payoutOptions: PayoutOption[]
  /** The bank account customer invoices in SEK pay to, preselected. */
  defaultPayoutCashAccountId: string | null
}

export async function loadActivationContext(
  db: Pick<SupabaseClient, 'from'>,
  companyId: string,
  now: Date = new Date(),
): Promise<ActivationContext> {
  const [companyRes, settingsRes, accountsRes, defaultRes] = await Promise.all([
    db.from('companies').select('name, org_number, entity_type').eq('id', companyId).maybeSingle(),
    db
      .from('company_settings')
      .select('entity_type, company_name, org_number, address_line1, address_line2, postal_code, city, email, phone, vat_registered, vat_number')
      .eq('company_id', companyId)
      .maybeSingle(),
    db
      .from('cash_accounts')
      .select('id, name, ledger_account, enabled, bankgiro, plusgiro, clearing_number, account_number')
      .eq('company_id', companyId)
      .order('is_primary', { ascending: false })
      .order('ledger_account', { ascending: true }),
    db.from('invoice_payee_defaults').select('cash_account_id').eq('company_id', companyId).eq('currency', 'SEK').maybeSingle(),
  ])
  if (companyRes.error) throw new Error(`companies lookup failed: ${companyRes.error.message}`)
  if (accountsRes.error) throw new Error(`cash_accounts lookup failed: ${accountsRes.error.message}`)
  const company = companyRes.data as { name: string | null; org_number: string | null; entity_type: string } | null
  const settings = settingsRes.data as {
    entity_type: string | null
    company_name: string | null
    org_number: string | null
    address_line1: string | null
    address_line2: string | null
    postal_code: string | null
    city: string | null
    email: string | null
    phone: string | null
    vat_registered: boolean | null
    vat_number: string | null
  } | null
  const entityType = await resolveCompanyEntityType(db as SupabaseClient, companyId, company?.entity_type ?? settings?.entity_type)
  const orgNumber = normalizeOrgNumber(company?.org_number ?? settings?.org_number ?? null)
  const soleTrader = usesPersonnummerAsOrgNumber(entityType)
  const options = payoutOptions((accountsRes.data ?? []) as PayoutSourceAccount[])
  const defaultId = (defaultRes.data as { cash_account_id: string } | null)?.cash_account_id ?? null
  return {
    company: {
      name: (settings?.company_name || company?.name || '').trim(),
      orgNumber,
      entityType,
      soleTrader,
      ownerPersonalNumber: soleTrader ? ownerPersonalNumberFromOrgNumber(orgNumber, now) : null,
      addressLine1: settings?.address_line1 ?? null,
      addressLine2: settings?.address_line2 ?? null,
      postalCode: settings?.postal_code ?? null,
      city: settings?.city ?? null,
      email: settings?.email ?? null,
      phone: settings?.phone ?? null,
      vatRegistered: settings?.vat_registered === true,
      vatNumber: settings?.vat_number ?? null,
    },
    payoutOptions: options,
    defaultPayoutCashAccountId: options.some((o) => o.cashAccountId === defaultId) ? defaultId : (options[0]?.cashAccountId ?? null),
  }
}

// ---------------------------------------------------------------------------
// 1. Consent
// ---------------------------------------------------------------------------

/**
 * The admin has read the provider's terms (the catalogue's version) and
 * agreed to share customer data: create the connection row. No provider
 * call. The route has already passed the 'activation' start gate.
 */
export async function recordConsent(deps: ConnectionServiceDeps, body: ConsentBody): Promise<CollectionConnectionRow> {
  if (!deps.actor) throw new Error('recordConsent needs a person')
  if (await loadLiveConnection(deps.db, deps.companyId)) fail(COLLECTIONS_CONNECTION_EXISTS)

  const env = deps.env ?? readCollectionsEnv()
  const sandbox = await (deps.isSandbox ?? isSandboxCompany)(deps.db, deps.companyId)
  const route = chooseCollectionsRoute({ sandbox, fakeAdapterRequested: env.fakeAdapterRequested })
  if (!adapterFor(deps, route)) fail(COLLECTIONS_UNAVAILABLE)

  const entry = await (deps.provider ?? ((r: CollectionsRoute) => getCollectionsProvider(r)))(route)
  // Nothing to consent to without the provider's terms; a provider that
  // cannot approve steps is not offered at all (build spec 1.3).
  if (!entry || !entry.provider.termsVersion) fail(COLLECTIONS_PROVIDER_UNAVAILABLE)
  if (!entry.features.stepApprovalAction) fail(COLLECTIONS_DISABLED)
  if (body.termsVersion !== entry.provider.termsVersion || body.dpaVersion !== entry.provider.dpaVersion) {
    fail(COLLECTIONS_TERMS_CHANGED)
  }

  const now = nowOf(deps)
  const { data, error } = await deps.db
    .from('collection_connections')
    .insert({
      company_id: deps.companyId,
      user_id: deps.actor.userId,
      route,
      provider_ref: entry.provider.ref,
      display_name: entry.provider.displayName,
      state: 'connecting',
      sub_status: 'not_started',
      catalogue_terms_version: entry.provider.termsVersion,
      dpa_version: entry.provider.dpaVersion,
      consented_by: deps.actor.userId,
      consented_at: now.toISOString(),
    })
    .select('*')
    .single()
  if (error) {
    if (error.code === '23505') fail(COLLECTIONS_CONNECTION_EXISTS)
    throw new Error(`collection_connections insert failed: ${error.message}`)
  }
  return normalizeConnectionRow(data as Record<string, unknown>)
}

// ---------------------------------------------------------------------------
// 2. The application
// ---------------------------------------------------------------------------

/** Validate the form against the company and build the provider request. */
export function buildOnboardingRequest(input: {
  row: CollectionConnectionRow
  body: OnboardingBody
  context: ActivationContext
  consentedByName: string
  requireLadderChoice: boolean
  now: Date
}): { request: CollectionsOnboardingRequest; payout: PayoutOption } {
  const { row, body, context, now } = input
  const { company } = context
  if (!company.orgNumber) fail(COLLECTIONS_ORG_NUMBER_MISSING)

  const errors: Record<string, ActivationErrorKey> = {}
  for (const [field, key] of Object.entries(validateCompanyStep(body.company, { soleTrader: company.soleTrader, now }))) {
    if (key) errors[`company.${field}`] = key
  }
  for (const [field, key] of Object.entries(validateKycStep(body.kyc))) {
    if (key) errors[`kyc.${field}`] = key
  }
  for (const [field, key] of Object.entries(
    validateRulesStep(body.rules, { today: todayIsoStockholm(now), requireLadderChoice: input.requireLadderChoice }),
  )) {
    if (key) errors[`rules.${field}`] = key
  }
  if (Object.keys(errors).length > 0) throw new ActivationValidationError(errors)

  let personalNumber: string | null = null
  if (company.soleTrader) {
    personalNumber = normalizeOwnerPersonalNumber(body.company.ownerPersonalNumber ?? '', now)
    // The firm is registered under the owner's personnummer: the ten
    // significant digits must match, whatever century was typed.
    if (!personalNumber || personalNumber.slice(2) !== company.orgNumber) fail(COLLECTIONS_OWNER_NUMBER_MISMATCH)
  }

  const payout = body.company.payout ? findPayoutOption(context.payoutOptions, body.company.payout) : null
  if (!payout) fail(COLLECTIONS_PAYOUT_ACCOUNT_INVALID)

  const settings: CollectionsSettings = {
    approveBeforeLegalAction: true,
    approveBeforeCollectionNotice: true,
    minimumAmount: roundOre(body.rules.minimumAmount),
    deliveryEnabled: false,
  }
  const request: Omit<CollectionsOnboardingRequest, 'idempotencyKey'> = {
    consent: {
      termsVersion: row.catalogue_terms_version,
      dpaVersion: row.dpa_version,
      consentedByName: input.consentedByName.slice(0, 200),
      consentedAt: new Date(row.consented_at).toISOString(),
    },
    creditor: {
      kind: company.soleTrader ? 'sole_trader' : 'company',
      name: body.company.name.trim(),
      orgNumber: company.orgNumber,
      personalNumber,
      vatRegistered: body.company.vatRegistered,
      vatNumber: body.company.vatRegistered && body.company.vatNumber ? normalizeVatNumber(body.company.vatNumber) : null,
      email: body.company.email.trim(),
      phone: body.company.phone?.trim() || null,
      address: {
        line1: body.company.addressLine1.trim(),
        line2: body.company.addressLine2?.trim() || null,
        postalCode: body.company.postalCode.replace(/\s/g, ''),
        city: body.company.city.trim(),
        countryCode: 'SE',
      },
      payout: { kind: payout.kind, number: payout.number },
    },
    kyc: {
      businessDescription: body.kyc.businessDescription.trim(),
      invoicesAbroad: body.kyc.invoicesAbroad,
      invoicesAbroadDescription: body.kyc.invoicesAbroad ? body.kyc.invoicesAbroadDescription : null,
      pep: body.kyc.pep,
      pepDescription: body.kyc.pep ? body.kyc.pepDescription : null,
      sanctions: body.kyc.sanctions,
      sanctionsDescription: body.kyc.sanctions ? body.kyc.sanctionsDescription : null,
    },
    settings,
  }
  return {
    request: { ...request, idempotencyKey: connectionIdempotencyKey(row.id, 'onboard', request) },
    payout,
  }
}

/**
 * Send the application. The rules are stored on the row first (they are the
 * company's whatever the provider answers), then the provider is called.
 * A failure the provider may still finish (timeout, in flight) leaves the
 * row submitted and the status poll picks the result up; any other failure
 * clears submitted_at so the admin can correct and send again.
 */
export async function submitOnboarding(deps: ConnectionServiceDeps, body: OnboardingBody): Promise<CollectionConnectionRow> {
  if (!deps.actor) throw new Error('submitOnboarding needs a person')
  const env = deps.env ?? readCollectionsEnv()
  let row = await requireLive(deps)
  if (row.state !== 'connecting' || row.sub_status !== 'not_started' || row.connection_handle) fail(COLLECTIONS_CONNECTION_STEP)
  // The reminder batch exists only where its flag is on; elsewhere the
  // choice is "I send from each invoice" and the page does not offer it.
  if (body.rules.ladderMode === 'staged' && !env.ladderEnabled) fail(COLLECTIONS_DISABLED)
  const adapter = requireAdapter(deps, row)

  const now = nowOf(deps)
  const context = await loadActivationContext(deps.db, deps.companyId, now)
  const consentedByName = await personName(deps.db, row.consented_by)
  const { request, payout } = buildOnboardingRequest({
    row,
    body: { ...body, rules: { ...body.rules, ladderMode: body.rules.ladderMode ?? (env.ladderEnabled ? null : 'off') } },
    context,
    consentedByName,
    requireLadderChoice: true,
    now,
  })

  const ladderMode = body.rules.ladderMode ?? 'off'
  row = await writeRow(deps, row, {
    minimum_amount: roundOre(body.rules.minimumAmount),
    default_start_step: body.rules.defaultStartStep,
    reminder_fee_terms_since: body.rules.reminderFeeTermsSince,
    late_interest_percent: body.rules.lateInterest ? roundOre(body.rules.lateInterest.percent) : null,
    late_interest_agreed_since: body.rules.lateInterest?.agreedSince ?? null,
    ladder_mode: ladderMode,
    ladder_enabled_by: ladderMode === 'staged' ? deps.actor.userId : null,
    ladder_enabled_at: ladderMode === 'staged' ? now.toISOString() : null,
    payout_account: payout.ledgerAccount,
    submitted_at: now.toISOString(),
  })

  let snapshot: CollectionsConnection
  try {
    snapshot = await withProvider(deps, row, () => adapter.onboard(callContext(row), request))
  } catch (error) {
    if (error instanceof CollectionsError && !error.retryable) {
      await writeRow(deps, (await loadLiveConnection(deps.db, deps.companyId)) ?? row, { submitted_at: null })
    }
    throw error
  }
  row = await applySnapshot(deps, row, snapshot)
  return acceptConsentedTerms(deps, row)
}

/**
 * When the provider asks for the very terms version the admin consented to
 * before anything was sent, accept it with that consent, so the admin is not
 * asked twice for the same text. Another version waits for acceptTerms.
 */
async function acceptConsentedTerms(deps: ConnectionServiceDeps, row: CollectionConnectionRow): Promise<CollectionConnectionRow> {
  if (row.sub_status !== 'awaiting_terms' || row.provider_terms?.version !== row.catalogue_terms_version) return row
  return sendTermsAcceptance(deps, row, {
    version: row.catalogue_terms_version,
    acceptedBy: row.consented_by,
    acceptedAt: row.consented_at,
  })
}

async function sendTermsAcceptance(
  deps: ConnectionServiceDeps,
  row: CollectionConnectionRow,
  acceptance: { version: string; acceptedBy: string; acceptedAt: string },
): Promise<CollectionConnectionRow> {
  const adapter = requireAdapter(deps, row)
  // Stored first: the record of who accepted which version and when is the
  // company's, and a retry re-sends exactly these values under the same key.
  let current = row
  if (row.terms_version !== acceptance.version) {
    current = await writeRow(deps, row, {
      terms_version: acceptance.version,
      terms_accepted_by: acceptance.acceptedBy,
      terms_accepted_at: acceptance.acceptedAt,
    })
  }
  const acceptedByName = await personName(deps.db, current.terms_accepted_by ?? acceptance.acceptedBy)
  const snapshot = await withProvider(deps, current, () =>
    adapter.acceptTerms(callContext(current), {
      idempotencyKey: connectionIdempotencyKey(current.id, `terms:${acceptance.version}`),
      termsVersion: acceptance.version,
      acceptedByName: acceptedByName.slice(0, 200),
      acceptedAt: new Date(current.terms_accepted_at ?? acceptance.acceptedAt).toISOString(),
    }),
  )
  return applySnapshot(deps, current, snapshot)
}

// ---------------------------------------------------------------------------
// 3. Terms, 4. signature
// ---------------------------------------------------------------------------

/** Accept the version of the provider's terms it presents now (a version other than the one consented to). */
export async function acceptTerms(deps: ConnectionServiceDeps, body: TermsBody): Promise<CollectionConnectionRow> {
  if (!deps.actor) throw new Error('acceptTerms needs a person')
  const row = await requireLive(deps)
  if (!row.connection_handle || row.sub_status !== 'awaiting_terms') fail(COLLECTIONS_CONNECTION_STEP)
  if (row.provider_terms?.version !== body.termsVersion) fail(COLLECTIONS_TERMS_CHANGED)
  const retry = row.terms_version === body.termsVersion && row.terms_accepted_by && row.terms_accepted_at
  return sendTermsAcceptance(deps, row, {
    version: body.termsVersion,
    acceptedBy: retry ? row.terms_accepted_by! : deps.actor.userId,
    acceptedAt: retry ? row.terms_accepted_at! : nowOf(deps).toISOString(),
  })
}

export interface SignatureStarted {
  connection: CollectionConnectionRow
  /** Open in a new tab; null when the provider mailed the link to the signer. */
  signUrl: string | null
  signers: string[]
}

/**
 * Start the signature at the provider: the admin signs now (signUrl, opened
 * in a new tab) or the provider mails the link to a firmatecknare. The same
 * request on the same day replays the same signing session.
 */
export async function startSignature(
  deps: ConnectionServiceDeps,
  body: SignatureBody,
  options: { redirectUrl: string; language: 'sv' | 'en' },
): Promise<SignatureStarted> {
  if (!deps.actor) throw new Error('startSignature needs a person')
  const row = await requireLive(deps)
  if (!row.connection_handle || row.sub_status !== 'awaiting_signature') fail(COLLECTIONS_CONNECTION_STEP)
  const signerEmail = body.sendToSigner ? body.signerEmail : deps.actor.email
  if (!signerEmail || !isEmail(signerEmail)) fail(COLLECTIONS_CONNECTION_STEP, 'no signer e-mail')
  const adapter = requireAdapter(deps, row)
  const request = {
    signerEmail,
    sendToSigner: body.sendToSigner,
    redirectUrl: options.redirectUrl,
    language: options.language,
  }
  const started = await withProvider(deps, row, () =>
    adapter.startSignature(callContext(row), {
      ...request,
      idempotencyKey: connectionIdempotencyKey(row.id, 'signature', { ...request, day: todayIsoStockholm(nowOf(deps)) }),
    }),
  )
  // Read the status back: signing may already have moved the activation on.
  let connection = row
  try {
    connection = await refreshConnection(deps)
  } catch (error) {
    log.warn('status read after signature start failed', { connectionId: row.id, error: String(error) })
  }
  return { connection, signUrl: started.signUrl, signers: started.signers }
}

// ---------------------------------------------------------------------------
// 5. Status
// ---------------------------------------------------------------------------

/**
 * Read the connection at the provider and store what it says. Nothing to
 * read before the application was sent. Also the sync cron's poll.
 *
 * What a status read stores is the provider's doing, not the reader's: it
 * is written as the system (user_id NULL), whoever pressed "Uppdatera
 * status".
 */
export async function refreshConnection(deps: ConnectionServiceDeps): Promise<CollectionConnectionRow> {
  const row = await requireLive(deps)
  return refreshRow(deps, row)
}

export async function refreshRow(deps: ConnectionServiceDeps, row: CollectionConnectionRow): Promise<CollectionConnectionRow> {
  if (!row.connection_handle && !row.submitted_at) return row
  const system: ConnectionServiceDeps = { ...deps, actor: null }
  const adapter = requireAdapter(system, row)
  const snapshot = await withProvider(system, row, () => adapter.connection(callContext(row)))
  const refreshed = await applySnapshot(system, row, snapshot)
  // A status read that finds the consented terms waiting finishes that step
  // too (the acceptance was interrupted, or onboarding timed out before it).
  return acceptConsentedTerms(system, refreshed)
}

// ---------------------------------------------------------------------------
// Ending a connection
// ---------------------------------------------------------------------------

/**
 * cancel: stop an activation that is not active yet. disconnect: end a
 * connection, allowed only with no open cases, unbooked collected payments
 * or unbooked settlements (the database refuses it too). The provider is told
 * first; on an installation that cannot reach it any more (no connector key
 * for the row's route) an activation can still be cancelled locally, since
 * nothing was handed over.
 */
export async function endConnection(deps: ConnectionServiceDeps, kind: 'cancel' | 'disconnect'): Promise<CollectionConnectionRow> {
  if (!deps.actor) throw new Error('endConnection needs a person')
  const row = await requireLive(deps)
  if (kind === 'cancel' && row.state === 'active') fail(COLLECTIONS_CONNECTION_STEP)

  const obligations = await loadCollectionObligations(deps.db, deps.companyId)
  if (hasCollectionObligations(obligations)) fail(COLLECTIONS_DISCONNECT_BLOCKED)

  const reachedProvider = row.connection_handle !== null || row.submitted_at !== null
  if (reachedProvider) {
    const adapter = adapterFor(deps, row.route)
    if (!adapter && kind === 'disconnect') fail(COLLECTIONS_UNAVAILABLE)
    if (adapter) {
      const idempotencyKey = connectionIdempotencyKey(row.id, kind)
      await withProvider(deps, row, () =>
        kind === 'cancel'
          ? adapter.cancelOnboarding(callContext(row), { idempotencyKey })
          : adapter.disconnect(callContext(row), { idempotencyKey }),
      )
    }
  }
  return writeRow(deps, row, {
    state: 'disconnected',
    sub_status: null,
    ended_by: deps.actor.userId,
    ended_at: nowOf(deps).toISOString(),
  })
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

/**
 * Change the rules of a live connection. The provider is told only what it
 * holds itself (the minimum amount and whether delivery is on), and only
 * once onboarded; both approvals stay locked on in every write. The caller
 * gates turning delivery on (flags.ts 'delivery_settings').
 */
export async function updateConnectionSettings(deps: ConnectionServiceDeps, patch: SettingsPatch): Promise<CollectionConnectionRow> {
  if (!deps.actor) throw new Error('updateConnectionSettings needs a person')
  const row = await requireLive(deps)
  const now = nowOf(deps)
  const errors: Record<string, ActivationErrorKey> = {}
  const rules = validateRulesStep(
    {
      minimumAmount: patch.minimumAmount ?? row.minimum_amount,
      defaultStartStep: patch.defaultStartStep ?? row.default_start_step,
      reminderFeeTermsSince: patch.reminderFeeTermsSince === undefined ? null : patch.reminderFeeTermsSince,
      lateInterest: patch.lateInterest ?? null,
      ladderMode: row.ladder_mode,
    },
    { today: todayIsoStockholm(now), requireLadderChoice: false },
  )
  for (const [field, key] of Object.entries(rules)) if (key) errors[field] = key
  if (Object.keys(errors).length > 0) throw new ActivationValidationError(errors)

  const next: Partial<CollectionConnectionRow> = {}
  if (patch.minimumAmount !== undefined) next.minimum_amount = roundOre(patch.minimumAmount)
  if (patch.defaultStartStep !== undefined) next.default_start_step = patch.defaultStartStep
  if (patch.reminderFeeTermsSince !== undefined) next.reminder_fee_terms_since = patch.reminderFeeTermsSince
  if (patch.lateInterest !== undefined) {
    next.late_interest_percent = patch.lateInterest ? roundOre(patch.lateInterest.percent) : null
    next.late_interest_agreed_since = patch.lateInterest?.agreedSince ?? null
  }
  if (patch.distributionEnabled !== undefined) next.distribution_enabled = patch.distributionEnabled

  const minimumAmount = next.minimum_amount ?? row.minimum_amount
  const deliveryEnabled = next.distribution_enabled ?? row.distribution_enabled
  const providerChanged = minimumAmount !== row.minimum_amount || deliveryEnabled !== row.distribution_enabled
  let current = row
  if (providerChanged && row.connection_handle) {
    const adapter = requireAdapter(deps, row)
    const settings: CollectionsSettings = {
      approveBeforeLegalAction: true,
      approveBeforeCollectionNotice: true,
      minimumAmount,
      deliveryEnabled,
    }
    const snapshot = await withProvider(deps, row, () =>
      adapter.updateSettings(callContext(row), {
        ...settings,
        idempotencyKey: connectionIdempotencyKey(row.id, 'settings', settings),
      }),
    )
    current = await applySnapshot(deps, row, snapshot, next)
    return current
  }
  return writeRow(deps, current, next)
}
