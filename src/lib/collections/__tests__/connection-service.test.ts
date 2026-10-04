import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { CollectionsFeatures } from '@accounted/connect-contract'
import type { OnboardingBody } from '../activation-form'
import {
  createFakeCollectionsAdapter,
  createFakeCollectionsStore,
  FAKE_COLLECTIONS_FEATURES,
  FAKE_PROVIDER_PROFILE,
} from '../adapters/fake'
import type { CatalogueCapabilityEntry } from '../catalogue'
import {
  acceptTerms,
  ActivationValidationError,
  buildOnboardingRequest,
  connectionIdempotencyKey,
  endConnection,
  loadActivationContext,
  recordConsent,
  refreshConnection,
  startSignature,
  submitOnboarding,
  updateConnectionSettings,
  type ConnectionServiceDeps,
} from '../connection-service'
import { CollectionsError } from '../errors'
import { readCollectionsEnv } from '../flags'
import type { CollectionsAdapter } from '../port'
import { ADMIN_ID, CASH_ACCOUNT_ID, COMPANY_ID, createMemorySupabase, seedCompany, type MemorySupabase } from './memory-supabase'

const NOW = new Date('2026-10-04T08:00:00Z')
const ENTRY: CatalogueCapabilityEntry<CollectionsFeatures> = { provider: FAKE_PROVIDER_PROFILE, features: FAKE_COLLECTIONS_FEATURES }

let db: MemorySupabase
let adapter: CollectionsAdapter

function deps(overrides: Partial<ConnectionServiceDeps> = {}): ConnectionServiceDeps {
  return {
    db: db.client,
    companyId: COMPANY_ID,
    actor: { userId: ADMIN_ID, name: 'Ada Admin', email: 'ada@test.se' },
    env: readCollectionsEnv({ COLLECTIONS_ENABLED: '1', COLLECTIONS_PILOT_COMPANIES: '*', COLLECTIONS_FAKE_ADAPTER: '1', NODE_ENV: 'test' }),
    adapterFor: () => adapter,
    provider: async () => ENTRY,
    isSandbox: async () => false,
    now: () => NOW,
    ...overrides,
  }
}

function onboardingBody(overrides: { company?: Partial<OnboardingBody['company']>; rules?: Partial<OnboardingBody['rules']> } = {}): OnboardingBody {
  return {
    company: {
      name: 'Test AB',
      addressLine1: 'Storgatan 1',
      addressLine2: null,
      postalCode: '111 22',
      city: 'Stockholm',
      email: 'faktura@test.se',
      phone: null,
      vatRegistered: true,
      vatNumber: 'SE556012579001',
      ownerPersonalNumber: null,
      payout: { cashAccountId: CASH_ACCOUNT_ID, kind: 'bankgiro' },
      ...overrides.company,
    },
    kyc: {
      businessDescription: 'Konsulttjänster inom IT',
      invoicesAbroad: false,
      invoicesAbroadDescription: null,
      pep: false,
      pepDescription: null,
      sanctions: false,
      sanctionsDescription: null,
    },
    rules: {
      minimumAmount: 250,
      defaultStartStep: 'reminder',
      reminderFeeTermsSince: '2025-01-01',
      lateInterest: null,
      ladderMode: 'off',
      ...overrides.rules,
    },
  }
}

const consent = () => recordConsent(deps(), { termsVersion: 'fake-2026-10', dpaVersion: null, acceptTerms: true, acceptDataSharing: true })

function liveRow() {
  return db.rows('collection_connections').find((r) => r.state !== 'disconnected')!
}

async function expectCode(promise: Promise<unknown>, code: string) {
  await expect(promise).rejects.toMatchObject({ code })
}

beforeEach(() => {
  db = createMemorySupabase()
  seedCompany(db)
  adapter = createFakeCollectionsAdapter({ store: createFakeCollectionsStore(), now: () => NOW })
})

describe('recordConsent', () => {
  it('creates the row with the consent and calls no provider', async () => {
    const calls = (Object.keys(adapter) as (keyof CollectionsAdapter)[])
      .filter((k) => typeof adapter[k] === 'function')
      .map((k) => vi.spyOn(adapter, k as 'onboard'))
    const spy = vi.spyOn(adapter, 'onboard')
    const row = await consent()
    for (const call of calls) expect(call).not.toHaveBeenCalled()
    expect(row).toMatchObject({
      company_id: COMPANY_ID,
      route: 'fake',
      provider_ref: 'acme-inkasso',
      display_name: 'Acme Inkasso',
      state: 'connecting',
      sub_status: 'not_started',
      catalogue_terms_version: 'fake-2026-10',
      dpa_version: null,
      consented_by: ADMIN_ID,
      consented_at: NOW.toISOString(),
      user_id: ADMIN_ID,
    })
    expect(spy).not.toHaveBeenCalled()
  })

  it('routes a real company to Connect and a sandbox to the fake', async () => {
    const real = await recordConsent(deps({ env: readCollectionsEnv({ COLLECTIONS_ENABLED: '1' }) }), {
      termsVersion: 'fake-2026-10',
      dpaVersion: null,
      acceptTerms: true,
      acceptDataSharing: true,
    })
    expect(real.route).toBe('connect')
    db = createMemorySupabase()
    seedCompany(db)
    const sandbox = await recordConsent(deps({ env: readCollectionsEnv({ COLLECTIONS_ENABLED: '1' }), isSandbox: async () => true }), {
      termsVersion: 'fake-2026-10',
      dpaVersion: null,
      acceptTerms: true,
      acceptDataSharing: true,
    })
    expect(sandbox.route).toBe('fake')
  })

  it('refuses a second live connection, other terms, a missing catalogue and a provider that cannot approve steps', async () => {
    await consent()
    await expectCode(consent(), 'COLLECTIONS_CONNECTION_EXISTS')

    db = createMemorySupabase()
    seedCompany(db)
    await expectCode(
      recordConsent(deps(), { termsVersion: 'older', dpaVersion: null, acceptTerms: true, acceptDataSharing: true }),
      'COLLECTIONS_TERMS_CHANGED',
    )
    await expectCode(recordConsent(deps({ provider: async () => null }), { termsVersion: 'x', dpaVersion: null, acceptTerms: true, acceptDataSharing: true }), 'COLLECTIONS_PROVIDER_UNAVAILABLE')
    await expectCode(
      recordConsent(deps({ provider: async () => ({ ...ENTRY, features: { ...ENTRY.features, stepApprovalAction: false } }) }), {
        termsVersion: 'fake-2026-10',
        dpaVersion: null,
        acceptTerms: true,
        acceptDataSharing: true,
      }),
      'COLLECTIONS_DISABLED',
    )
    await expectCode(
      recordConsent(deps({ adapterFor: () => null }), { termsVersion: 'fake-2026-10', dpaVersion: null, acceptTerms: true, acceptDataSharing: true }),
      'COLLECTIONS_UNAVAILABLE',
    )
  })
})

describe('the activation, step by step against the fake', () => {
  it('reaches active: application, the consented terms accepted with it, signature, status read', async () => {
    const onboard = vi.spyOn(adapter, 'onboard')
    const terms = vi.spyOn(adapter, 'acceptTerms')
    await consent()

    const submitted = await submitOnboarding(deps(), onboardingBody())
    // The provider asked for the very version consented to: accepted with that consent.
    expect(terms).toHaveBeenCalledTimes(1)
    expect(terms.mock.calls[0]![1]).toMatchObject({ termsVersion: 'fake-2026-10', acceptedByName: 'Ada Admin', acceptedAt: NOW.toISOString() })
    expect(submitted).toMatchObject({
      state: 'connecting',
      sub_status: 'awaiting_signature',
      terms_version: 'fake-2026-10',
      terms_accepted_by: ADMIN_ID,
      minimum_amount: 250,
      reminder_fee_terms_since: '2025-01-01',
      ladder_mode: 'off',
      payout_account: '1930',
      submitted_at: NOW.toISOString(),
      health: 'ok',
    })
    expect(submitted.connection_handle).toBeTruthy()

    const request = onboard.mock.calls[0]![1]
    expect(request.creditor).toMatchObject({
      kind: 'company',
      orgNumber: '5560125790',
      personalNumber: null,
      vatNumber: 'SE556012579001',
      address: { line1: 'Storgatan 1', postalCode: '11122', city: 'Stockholm', countryCode: 'SE' },
      payout: { kind: 'bankgiro', number: '1234567' },
    })
    expect(request.settings).toEqual({ approveBeforeLegalAction: true, approveBeforeCollectionNotice: true, minimumAmount: 250, deliveryEnabled: false })
    expect(request.consent).toMatchObject({ termsVersion: 'fake-2026-10', consentedByName: 'Ada Admin' })
    expect(request.idempotencyKey).toMatch(new RegExp(`^${submitted.id}:onboard:[0-9a-f]{16}$`))

    const signed = await startSignature(deps(), { sendToSigner: false, signerEmail: null, language: 'sv' }, { redirectUrl: 'https://app.test/settings/collections?signed=1', language: 'sv' })
    expect(signed.signUrl).toBeNull()
    expect(signed.connection).toMatchObject({ state: 'active', sub_status: null, activated_at: NOW.toISOString() })
  })

  it('leaves another terms version for the admin to accept, and accepts only the version presented', async () => {
    const terms = vi.spyOn(adapter, 'acceptTerms')
    await recordConsent(deps({ provider: async () => ({ ...ENTRY, provider: { ...ENTRY.provider, termsVersion: 'catalogue-v0' } }) }), {
      termsVersion: 'catalogue-v0',
      dpaVersion: null,
      acceptTerms: true,
      acceptDataSharing: true,
    })
    const row = await submitOnboarding(deps(), onboardingBody())
    expect(row.sub_status).toBe('awaiting_terms')
    expect(row.provider_terms).toMatchObject({ version: 'fake-2026-10', accepted: false })
    expect(terms).not.toHaveBeenCalled()

    await expectCode(acceptTerms(deps(), { termsVersion: 'catalogue-v0', accept: true }), 'COLLECTIONS_TERMS_CHANGED')
    const accepted = await acceptTerms(deps(), { termsVersion: 'fake-2026-10', accept: true })
    expect(accepted).toMatchObject({ sub_status: 'awaiting_signature', terms_version: 'fake-2026-10', terms_accepted_by: ADMIN_ID })
  })

  it('refuses a step out of order', async () => {
    await expectCode(submitOnboarding(deps(), onboardingBody()), 'COLLECTIONS_CONNECTION_NOT_FOUND')
    await consent()
    await expectCode(acceptTerms(deps(), { termsVersion: 'fake-2026-10', accept: true }), 'COLLECTIONS_CONNECTION_STEP')
    await expectCode(
      startSignature(deps(), { sendToSigner: false, signerEmail: null, language: 'sv' }, { redirectUrl: 'https://app.test/x', language: 'sv' }),
      'COLLECTIONS_CONNECTION_STEP',
    )
    await submitOnboarding(deps(), onboardingBody())
    await expectCode(submitOnboarding(deps(), onboardingBody()), 'COLLECTIONS_CONNECTION_STEP')
  })

  it('answers the form errors by field, with keys', async () => {
    await consent()
    const error = await submitOnboarding(
      deps(),
      onboardingBody({ company: { postalCode: '1234', email: 'nope', vatNumber: 'SE1' }, rules: { minimumAmount: 1.005, reminderFeeTermsSince: '2027-01-01' } }),
    ).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ActivationValidationError)
    expect((error as ActivationValidationError).errors).toEqual({
      'company.postalCode': 'invalid_postal_code',
      'company.email': 'invalid_email',
      'company.vatNumber': 'invalid_vat_number',
      'rules.minimumAmount': 'invalid_amount',
      'rules.reminderFeeTermsSince': 'date_in_future',
    })
    expect(liveRow().submitted_at).toBeNull()
  })

  it('refuses a payout account that is not one of the company\'s bank accounts with that number', async () => {
    await consent()
    await expectCode(
      submitOnboarding(deps(), onboardingBody({ company: { payout: { cashAccountId: CASH_ACCOUNT_ID, kind: 'plusgiro' } } })),
      'COLLECTIONS_PAYOUT_ACCOUNT_INVALID',
    )
  })

  it('offers the reminder batch only where its flag is on', async () => {
    await consent()
    await expectCode(submitOnboarding(deps(), onboardingBody({ rules: { ladderMode: 'staged' } })), 'COLLECTIONS_DISABLED')
    const withLadder = deps({ env: readCollectionsEnv({ COLLECTIONS_ENABLED: '1', COLLECTIONS_LADDER_ENABLED: '1', COLLECTIONS_FAKE_ADAPTER: '1', NODE_ENV: 'test' }) })
    const row = await submitOnboarding(withLadder, onboardingBody({ rules: { ladderMode: 'staged' } }))
    expect(row).toMatchObject({ ladder_mode: 'staged', ladder_enabled_by: ADMIN_ID, ladder_enabled_at: NOW.toISOString() })
  })

  it('requires the reminder choice when the batch is offered', async () => {
    await consent()
    const withLadder = deps({ env: readCollectionsEnv({ COLLECTIONS_ENABLED: '1', COLLECTIONS_LADDER_ENABLED: '1', COLLECTIONS_FAKE_ADAPTER: '1', NODE_ENV: 'test' }) })
    const error = await submitOnboarding(withLadder, onboardingBody({ rules: { ladderMode: null } })).catch((e: unknown) => e)
    expect((error as ActivationValidationError).errors).toEqual({ 'rules.ladderMode': 'required' })
    // Where the batch is not offered, no choice means "I send from each invoice".
    const row = await submitOnboarding(deps(), onboardingBody({ rules: { ladderMode: null } }))
    expect(row.ladder_mode).toBe('off')
  })
})

describe('a sole trader', () => {
  beforeEach(() => {
    db = createMemorySupabase()
    // 811218-9876: a valid personnummer, the firm's org number.
    seedCompany(db, { entityType: 'enskild_firma', orgNumber: '8112189876' })
  })

  it('prefills the owner from the org number and sends it as twelve digits', async () => {
    const context = await loadActivationContext(db.client, COMPANY_ID, NOW)
    expect(context.company).toMatchObject({ soleTrader: true, orgNumber: '8112189876', ownerPersonalNumber: '198112189876' })
    const onboard = vi.spyOn(adapter, 'onboard')
    await consent()
    await submitOnboarding(deps(), onboardingBody({ company: { ownerPersonalNumber: '19811218-9876' } }))
    expect(onboard.mock.calls[0]![1].creditor).toMatchObject({ kind: 'sole_trader', orgNumber: '8112189876', personalNumber: '198112189876' })
  })

  it('refuses a missing, invalid or other person\'s number', async () => {
    await consent()
    const missing = await submitOnboarding(deps(), onboardingBody()).catch((e: unknown) => e)
    expect((missing as ActivationValidationError).errors).toEqual({ 'company.ownerPersonalNumber': 'required' })
    const invalid = await submitOnboarding(deps(), onboardingBody({ company: { ownerPersonalNumber: '198112189877' } })).catch((e: unknown) => e)
    expect((invalid as ActivationValidationError).errors).toEqual({ 'company.ownerPersonalNumber': 'invalid_personal_number' })
    // 19900101-0017 is valid but not the firm's.
    await expectCode(submitOnboarding(deps(), onboardingBody({ company: { ownerPersonalNumber: '199001010017' } })), 'COLLECTIONS_OWNER_NUMBER_MISMATCH')
  })
})

describe('failures at the provider', () => {
  it('keeps a timed-out application submitted for the status poll, and lets a refused one be corrected', async () => {
    await consent()
    vi.spyOn(adapter, 'onboard').mockRejectedValueOnce(new CollectionsError('timeout', { code: 'CONNECTOR_UNREACHABLE', retryable: true }))
    await expectCode(submitOnboarding(deps(), onboardingBody()), 'CONNECTOR_UNREACHABLE')
    expect(liveRow()).toMatchObject({ submitted_at: NOW.toISOString(), health: 'degraded', health_cause: 'CONNECTOR_UNREACHABLE', health_action: 'retry_later', failures_in_row: 1 })

    db = createMemorySupabase()
    seedCompany(db)
    await consent()
    vi.spyOn(adapter, 'onboard').mockRejectedValueOnce(new CollectionsError('bad', { code: 'CONNECTOR_REQUEST_INVALID', retryable: false }))
    await expectCode(submitOnboarding(deps(), onboardingBody()), 'CONNECTOR_REQUEST_INVALID')
    expect(liveRow()).toMatchObject({ submitted_at: null, health: 'action_required', health_action: 'contact_support' })
    // Corrected and sent again: a new body is a new request.
    const row = await submitOnboarding(deps(), onboardingBody({ rules: { minimumAmount: 300 } }))
    expect(row.sub_status).toBe('awaiting_signature')
  })

  it('never lets the provider end a connection: a vanished one asks a person to look', async () => {
    await consent()
    await submitOnboarding(deps(), onboardingBody())
    vi.spyOn(adapter, 'connection').mockResolvedValueOnce({
      state: 'disconnected',
      subStatus: null,
      providerStatus: 'gone',
      connectionHandle: null,
      terms: null,
      signers: [],
      settings: null,
      updatedAt: NOW.toISOString(),
    })
    const row = await refreshConnection(deps())
    expect(row).toMatchObject({ state: 'connecting', sub_status: 'awaiting_signature', health: 'action_required', health_cause: 'PROVIDER_DISCONNECTED' })
    expect(row.connection_handle).toBeTruthy()
  })

  it('stores a status read as the system, whoever asked for it', async () => {
    await consent()
    await submitOnboarding(deps(), onboardingBody())
    await refreshConnection(deps())
    expect(liveRow().user_id).toBeNull()
  })
})

describe('ending a connection', () => {
  it('cancels an activation at the provider, then locally', async () => {
    const cancel = vi.spyOn(adapter, 'cancelOnboarding')
    const row = await consent()
    // Nothing reached the provider yet: ended locally only.
    const ended = await endConnection(deps(), 'cancel')
    expect(cancel).not.toHaveBeenCalled()
    expect(ended).toMatchObject({ state: 'disconnected', sub_status: null, ended_by: ADMIN_ID, ended_at: NOW.toISOString() })

    await consent()
    await submitOnboarding(deps(), onboardingBody())
    await endConnection(deps(), 'cancel')
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(cancel.mock.calls[0]![1]).toEqual({ idempotencyKey: `${liveRowOrLast().id}:cancel` })
    expect(row.id).not.toBe(liveRowOrLast().id)
  })

  it('starts over after a cancel: a new row, a new consent, the same company at the provider', async () => {
    const first = await consent()
    await submitOnboarding(deps(), onboardingBody())
    await endConnection(deps(), 'cancel')
    const second = await consent()
    expect(second.id).not.toBe(first.id)
    expect(second).toMatchObject({ state: 'connecting', sub_status: 'not_started', connection_handle: null })
    const again = await submitOnboarding(deps(), onboardingBody())
    expect(again.sub_status).toBe('awaiting_signature')
    expect(db.rows('collection_connections').map((r) => r.state)).toEqual(['disconnected', 'connecting'])
  })

  it('refuses to cancel an active connection and to disconnect with open work', async () => {
    await consent()
    await submitOnboarding(deps(), onboardingBody())
    await startSignature(deps(), { sendToSigner: false, signerEmail: null, language: 'sv' }, { redirectUrl: 'https://app.test/x', language: 'sv' })
    await expectCode(endConnection(deps(), 'cancel'), 'COLLECTIONS_CONNECTION_STEP')
    db.rpcs.set('collection_obligation_counts', () => [{ open_cases: 1, unbooked_collected_payments: 0, unbooked_settlements: 0 }])
    const disconnect = vi.spyOn(adapter, 'disconnect')
    await expectCode(endConnection(deps(), 'disconnect'), 'COLLECTIONS_DISCONNECT_BLOCKED')
    expect(disconnect).not.toHaveBeenCalled()
    db.rpcs.set('collection_obligation_counts', () => [{ open_cases: 0, unbooked_collected_payments: 0, unbooked_settlements: 0 }])
    const ended = await endConnection(deps(), 'disconnect')
    expect(ended.state).toBe('disconnected')
    expect(disconnect).toHaveBeenCalledTimes(1)
  })

  it('cancels locally when this installation can no longer reach the provider, but never disconnects blind', async () => {
    await consent()
    await submitOnboarding(deps(), onboardingBody())
    await expectCode(endConnection(deps({ adapterFor: () => null }), 'disconnect'), 'COLLECTIONS_UNAVAILABLE')
    const ended = await endConnection(deps({ adapterFor: () => null }), 'cancel')
    expect(ended.state).toBe('disconnected')
  })
})

function liveRowOrLast() {
  const all = db.rows('collection_connections')
  return all[all.length - 1]!
}

describe('settings', () => {
  it('tells the provider only what it holds, with both approvals locked on', async () => {
    const update = vi.spyOn(adapter, 'updateSettings')
    await consent()
    await submitOnboarding(deps(), onboardingBody())

    const local = await updateConnectionSettings(deps(), { defaultStartStep: 'collection', lateInterest: { percent: 12, agreedSince: '2025-06-01' } })
    expect(update).not.toHaveBeenCalled()
    expect(local).toMatchObject({ default_start_step: 'collection', late_interest_percent: 12, late_interest_agreed_since: '2025-06-01' })

    const sent = await updateConnectionSettings(deps(), { minimumAmount: 500 })
    expect(update).toHaveBeenCalledTimes(1)
    expect(update.mock.calls[0]![1]).toMatchObject({ approveBeforeLegalAction: true, approveBeforeCollectionNotice: true, minimumAmount: 500, deliveryEnabled: false })
    expect(sent.minimum_amount).toBe(500)

    await updateConnectionSettings(deps(), { lateInterest: null, reminderFeeTermsSince: null })
    expect(liveRow()).toMatchObject({ late_interest_percent: null, late_interest_agreed_since: null, reminder_fee_terms_since: null })
  })

  it('refuses a date in the future and an interest rate out of range', async () => {
    await consent()
    const error = await updateConnectionSettings(deps(), { reminderFeeTermsSince: '2030-01-01', lateInterest: { percent: 0, agreedSince: '2025-01-01' } }).catch(
      (e: unknown) => e,
    )
    expect((error as ActivationValidationError).errors).toEqual({ reminderFeeTermsSince: 'date_in_future', lateInterestPercent: 'invalid_percent' })
  })
})

describe('idempotency keys', () => {
  it('are the row id and operation, plus a digest of the body where content may change', () => {
    expect(connectionIdempotencyKey('row', 'cancel')).toBe('row:cancel')
    const a = connectionIdempotencyKey('row', 'settings', { b: 1, a: 2 })
    expect(a).toBe(connectionIdempotencyKey('row', 'settings', { a: 2, b: 1 }))
    expect(a).not.toBe(connectionIdempotencyKey('row', 'settings', { a: 3, b: 1 }))
    expect(a.length).toBeLessThanOrEqual(128)
  })

  it('builds the same application request for the same form', async () => {
    const row = await consent()
    const context = await loadActivationContext(db.client, COMPANY_ID, NOW)
    const input = { row, body: onboardingBody(), context, consentedByName: 'Ada Admin', requireLadderChoice: true, now: NOW }
    expect(buildOnboardingRequest(input).request).toEqual(buildOnboardingRequest(input).request)
  })
})
