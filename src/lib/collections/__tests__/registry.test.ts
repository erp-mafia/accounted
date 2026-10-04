import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { collectionsAdapterFor, ensureCollectionsAdapters } from '../adapters'
import { createFakeCollectionsAdapter } from '../adapters/fake'
import {
  __resetCollectionsAdaptersForTests,
  chooseCollectionsRoute,
  registerCollectionsAdapter,
  resolveCollectionsAdapter,
} from '../registry'

beforeEach(() => {
  __resetCollectionsAdaptersForTests()
  vi.stubEnv('GNUBOK_CONNECTOR_KEY', '')
  vi.stubEnv('GNUBOK_CONNECT_URL', '')
})
afterEach(() => {
  vi.unstubAllEnvs()
  __resetCollectionsAdaptersForTests()
})

describe('collections registry', () => {
  it('resolves by the connection row route, and nothing is registered by default', () => {
    expect(resolveCollectionsAdapter({ route: 'fake' })).toBeNull()
    const fake = createFakeCollectionsAdapter()
    registerCollectionsAdapter(fake)
    expect(resolveCollectionsAdapter({ route: 'fake' })).toBe(fake)
    expect(resolveCollectionsAdapter({ route: 'connect' })).toBeNull()
  })

  it('always offers the fake, and the Connect adapter only with a connector key', () => {
    expect(collectionsAdapterFor({ route: 'fake' })?.route).toBe('fake')
    // A 'connect' row on an installation without a key: unavailable, never the fake.
    expect(collectionsAdapterFor({ route: 'connect' })).toBeNull()

    __resetCollectionsAdaptersForTests()
    vi.stubEnv('GNUBOK_CONNECTOR_KEY', 'gnubok_ck_x')
    expect(collectionsAdapterFor({ route: 'connect' })?.route).toBe('connect')
    expect(collectionsAdapterFor({ route: 'fake' })?.route).toBe('fake')
  })

  it('keeps an adapter registered earlier (a test double)', () => {
    const double = { ...createFakeCollectionsAdapter(), route: 'connect' as const }
    registerCollectionsAdapter(double)
    vi.stubEnv('GNUBOK_CONNECTOR_KEY', 'gnubok_ck_x')
    ensureCollectionsAdapters()
    expect(resolveCollectionsAdapter({ route: 'connect' })).toBe(double)
  })

  it('gives a new connection the fake route only for a sandbox or a local opt-in', () => {
    expect(chooseCollectionsRoute({ sandbox: true, fakeAdapterRequested: false })).toBe('fake')
    expect(chooseCollectionsRoute({ sandbox: false, fakeAdapterRequested: true })).toBe('fake')
    expect(chooseCollectionsRoute({ sandbox: false, fakeAdapterRequested: false })).toBe('connect')
  })
})
