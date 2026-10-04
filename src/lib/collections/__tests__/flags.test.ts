import { describe, it, expect } from 'vitest'
import {
  COLLECTIONS_START_ACTIONS,
  COLLECTIONS_START_OPERATIONS,
  COLLECTIONS_OPERATIONS,
  DELIVERY_OPERATIONS,
  DELIVERY_START_OPERATIONS,
  collectionsActionSchema,
  type CollectionsOperation,
  type DeliveryOperation,
} from '@accounted/connect-contract'
import {
  COLLECTIONS_OBLIGATION_PATHS,
  COLLECTIONS_START_PATHS,
  collectionsGate,
  collectionsStartState,
  hasCollectionObligations,
  isDeliveryStartOperation,
  isStartOperation,
  NO_COLLECTION_OBLIGATIONS,
  readCollectionsEnv,
  type CollectionsConnectionFacts,
  type CollectionsEnv,
  type CollectionsGateFacts,
} from '../flags'

const COMPANY = 'company-1'

function env(overrides: Partial<CollectionsEnv> = {}): CollectionsEnv {
  return { enabled: true, pilot: new Set([COMPANY]), ladderEnabled: true, deliveryEnabled: true, fakeAdapterRequested: false, ...overrides }
}

function connection(overrides: Partial<CollectionsConnectionFacts> = {}): CollectionsConnectionFacts {
  return { route: 'connect', state: 'active', subStatus: null, health: 'ok', distributionEnabled: true, ladderMode: 'staged', displayName: 'Acme Inkasso', ...overrides }
}

function facts(overrides: Partial<CollectionsGateFacts> = {}): CollectionsGateFacts {
  return { companyId: COMPANY, capability: true, connection: connection(), obligations: NO_COLLECTION_OBLIGATIONS, ...overrides }
}

describe('readCollectionsEnv', () => {
  it('is fully off with nothing set', () => {
    const e = readCollectionsEnv({})
    expect(e).toMatchObject({ enabled: false, ladderEnabled: false, deliveryEnabled: false, fakeAdapterRequested: false })
    expect(e.pilot).toEqual(new Set())
  })

  it('reads the switches, the pilot list and the star', () => {
    const e = readCollectionsEnv({
      COLLECTIONS_ENABLED: 'true',
      COLLECTIONS_PILOT_COMPANIES: ' a , b,,',
      COLLECTIONS_LADDER_ENABLED: '1',
      COLLECTIONS_DELIVERY_ENABLED: 'no',
    })
    expect(e).toMatchObject({ enabled: true, ladderEnabled: true, deliveryEnabled: false })
    expect(e.pilot).toEqual(new Set(['a', 'b']))
    expect(readCollectionsEnv({ COLLECTIONS_PILOT_COMPANIES: '*' }).pilot).toBe('*')
  })

  it('never asks for the fake adapter in production', () => {
    expect(readCollectionsEnv({ COLLECTIONS_FAKE_ADAPTER: '1', NODE_ENV: 'development' }).fakeAdapterRequested).toBe(true)
    expect(readCollectionsEnv({ COLLECTIONS_FAKE_ADAPTER: '1', NODE_ENV: 'production' }).fakeAdapterRequested).toBe(false)
  })
})

describe('collectionsGate: start paths', () => {
  it('answers 503 for every start path with no environment set', () => {
    for (const path of COLLECTIONS_START_PATHS) {
      expect(collectionsGate(path, facts(), readCollectionsEnv({})), path).toEqual({ allowed: false, code: 'COLLECTIONS_DISABLED', status: 503 })
    }
  })

  it('needs the company on the pilot list (or the star)', () => {
    expect(collectionsGate('handover', facts(), env({ pilot: new Set(['other']) }))).toMatchObject({ code: 'COLLECTIONS_DISABLED' })
    expect(collectionsGate('handover', facts(), env({ pilot: '*' }))).toEqual({ allowed: true })
  })

  it('checks the capability before anything touches Connect, activation included', () => {
    expect(collectionsGate('activation', facts({ capability: false, connection: null }), env())).toEqual({ allowed: false, code: 'CAPABILITY_REQUIRED', status: 403 })
    expect(collectionsGate('activation', facts({ connection: null }), env())).toEqual({ allowed: true })
  })

  it('needs an active connection for everything but activation and tool discovery', () => {
    const connecting = facts({ connection: connection({ state: 'connecting', subStatus: 'in_review' }) })
    expect(collectionsGate('handover', connecting, env())).toEqual({ allowed: false, code: 'COLLECTIONS_NOT_ACTIVE', status: 409 })
    expect(collectionsGate('tool_discovery', connecting, env())).toEqual({ allowed: true })
  })

  it('gates delivery on its flag and the company opt-in, the batch on its flag and a staged ladder', () => {
    expect(collectionsGate('delivery_send', facts(), env({ deliveryEnabled: false }))).toMatchObject({ code: 'COLLECTIONS_DISABLED' })
    expect(collectionsGate('delivery_methods', facts({ connection: connection({ distributionEnabled: false }) }), env())).toMatchObject({ code: 'COLLECTIONS_NOT_ACTIVE' })
    expect(collectionsGate('daily_batch', facts(), env({ ladderEnabled: false }))).toMatchObject({ code: 'COLLECTIONS_DISABLED' })
    expect(collectionsGate('daily_batch', facts({ connection: connection({ ladderMode: 'off' }) }), env())).toMatchObject({ code: 'COLLECTIONS_NOT_ACTIVE' })
    expect(collectionsGate('ladder_settings', facts({ connection: connection({ ladderMode: null }) }), env())).toEqual({ allowed: true })
  })

  it('lets an active company turn delivery on before it has opted in, only with the delivery flag', () => {
    const optedOut = facts({ connection: connection({ distributionEnabled: false }) })
    expect(collectionsGate('delivery_settings', optedOut, env())).toEqual({ allowed: true })
    expect(collectionsGate('delivery_settings', optedOut, env({ deliveryEnabled: false }))).toMatchObject({ code: 'COLLECTIONS_DISABLED' })
    expect(collectionsGate('delivery_settings', facts({ connection: connection({ state: 'connecting', subStatus: 'in_review' }) }), env())).toMatchObject({
      code: 'COLLECTIONS_NOT_ACTIVE',
    })
  })
})

describe('collectionsGate: the flags matrix', () => {
  const pilots: CollectionsEnv['pilot'][] = [new Set(), new Set([COMPANY]), '*']
  const connections: (CollectionsConnectionFacts | null)[] = [
    null,
    connection({ state: 'connecting', subStatus: 'awaiting_terms' }),
    connection({ state: 'disconnected' }),
    connection({ distributionEnabled: false, ladderMode: 'off' }),
    connection(),
  ]
  const bools = [false, true]

  it('never refuses an obligation path, for any combination of the ledger gates', () => {
    let combinations = 0
    for (const enabled of bools)
      for (const pilot of pilots)
        for (const ladderEnabled of bools)
          for (const deliveryEnabled of bools)
            for (const capability of bools)
              for (const conn of connections)
                for (const openCases of [0, 1]) {
                  const e = env({ enabled, pilot, ladderEnabled, deliveryEnabled })
                  const f = facts({ capability, connection: conn, obligations: { ...NO_COLLECTION_OBLIGATIONS, openCases } })
                  for (const path of COLLECTIONS_OBLIGATION_PATHS) {
                    expect(collectionsGate(path, f, e), `${path} ${JSON.stringify({ enabled, ladderEnabled, deliveryEnabled, capability, conn: conn?.state })}`).toEqual({ allowed: true })
                  }
                  combinations++
                }
    expect(combinations).toBe(2 * 3 * 2 * 2 * 2 * 5 * 2)
  })

  it('with every start gate off, a company with an open case still forwards, syncs, pauses and books', () => {
    const dark = readCollectionsEnv({})
    const lapsed = facts({ capability: false, connection: connection({ state: 'disconnected' }), obligations: { openCases: 1, unbookedCollectedPayments: 1, unbookedSettlements: 1 } })
    for (const path of ['payment_forwarding', 'case_sync', 'case_pause', 'settlement_booking', 'collected_payment_booking'] as const) {
      expect(collectionsGate(path, lapsed, dark), path).toEqual({ allowed: true })
    }
    for (const path of COLLECTIONS_START_PATHS) {
      expect(collectionsGate(path, lapsed, dark).allowed, path).toBe(false)
    }
  })

  it('allows a start path exactly when every gate says yes', () => {
    for (const path of COLLECTIONS_START_PATHS) {
      for (const enabled of bools)
        for (const pilot of pilots)
          for (const ladderEnabled of bools)
            for (const deliveryEnabled of bools)
              for (const capability of bools)
                for (const conn of connections) {
                  const e = env({ enabled, pilot, ladderEnabled, deliveryEnabled })
                  const inPilot = pilot === '*' || pilot.has(COMPANY)
                  const active = conn?.state === 'active'
                  const expected =
                    enabled &&
                    inPilot &&
                    capability &&
                    (!['daily_batch', 'ladder_settings'].includes(path) || ladderEnabled) &&
                    (path !== 'delivery_settings' || deliveryEnabled) &&
                    (!['delivery_send', 'delivery_methods'].includes(path) || (deliveryEnabled && active && conn?.distributionEnabled === true)) &&
                    (path !== 'daily_batch' || (active && conn?.ladderMode === 'staged')) &&
                    (['activation', 'tool_discovery'].includes(path) || active)
                  expect(collectionsGate(path, facts({ capability, connection: conn }), e).allowed, path).toBe(expected)
                }
    }
  })
})

describe('obligations and start state', () => {
  it('counts any open case, unbooked collected payment or unbooked settlement', () => {
    expect(hasCollectionObligations(NO_COLLECTION_OBLIGATIONS)).toBe(false)
    expect(hasCollectionObligations({ ...NO_COLLECTION_OBLIGATIONS, openCases: 1 })).toBe(true)
    expect(hasCollectionObligations({ ...NO_COLLECTION_OBLIGATIONS, unbookedCollectedPayments: 2 })).toBe(true)
    expect(hasCollectionObligations({ ...NO_COLLECTION_OBLIGATIONS, unbookedSettlements: 1 })).toBe(true)
  })

  it('renders hidden, upgrade, activate or ready', () => {
    expect(collectionsStartState(facts(), readCollectionsEnv({}))).toBe('hidden')
    expect(collectionsStartState(facts({ capability: false }), env())).toBe('upgrade')
    expect(collectionsStartState(facts({ connection: null }), env())).toBe('activate')
    expect(collectionsStartState(facts(), env())).toBe('ready')
  })
})

describe('start operations follow the contract', () => {
  it('classifies collections operations and actions', () => {
    for (const op of Object.keys(COLLECTIONS_OPERATIONS) as CollectionsOperation[]) {
      expect(isStartOperation(op), op).toBe((COLLECTIONS_START_OPERATIONS as readonly string[]).includes(op))
    }
    for (const action of collectionsActionSchema.options) {
      expect(isStartOperation('caseAction', action), action).toBe((COLLECTIONS_START_ACTIONS as readonly string[]).includes(action))
    }
    expect(isStartOperation('cancelOnboarding')).toBe(false)
  })

  it('classifies delivery operations', () => {
    for (const op of Object.keys(DELIVERY_OPERATIONS) as DeliveryOperation[]) {
      expect(isDeliveryStartOperation(op), op).toBe((DELIVERY_START_OPERATIONS as readonly string[]).includes(op))
    }
  })
})
