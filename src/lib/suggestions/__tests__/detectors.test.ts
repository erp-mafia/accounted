import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTableMockSupabase } from '@/tests/helpers'
import { createLogger } from '@/lib/logger'
import type { CompanyCapabilities } from '@/lib/modules/capabilities'
import type { CoreEvent } from '@/lib/events/types'
import { DETECTORS, EVENT_DETECTORS, SCHEDULED_DETECTORS } from '../detectors'
import { firstEmployeeDetector } from '../detectors/first-employee'
import { salesChannelConnectedDetector } from '../detectors/sales-channel-connected'
import { hideUnusedDetector, hideUnusedSuggestionsEnabled, unusedSince } from '../detectors/hide-unused'
import { createDetectorContext } from '../run'
import type { DetectorContext } from '../types'

const COMPANY = 'c0000000-0000-4000-8000-000000000001'
const USER = 'u0000000-0000-4000-8000-000000000001'
const NOW = new Date('2026-10-16T10:00:00.000Z')

function capabilitiesWith(availability: Record<string, string>): CompanyCapabilities {
  const ids = ['bookkeeping', 'bank', 'customer-invoices', 'supplier-invoices-and-payments', 'receipts-and-documents', 'expenses', 'payroll', 'assets', 'pos-and-webshop']
  return {
    jurisdiction: 'SE',
    ledger_currency: 'SEK',
    profile: { id: 'standard', version: 1, name: 'Standard', name_sv: 'Standard (allt på)', source: 'implicit' },
    packages: ids.map((id) => ({
      id,
      name: id,
      name_sv: id,
      switchable: id !== 'bookkeeping',
      modules: [],
      availability: availability[id] ?? 'on',
      reasons: [],
    })),
    modules: [],
  } as unknown as CompanyCapabilities
}

function contextWith(caps: CompanyCapabilities | null, tables: Parameters<typeof createTableMockSupabase>[0] = {}) {
  const mock = createTableMockSupabase(tables)
  const base = createDetectorContext({ supabase: mock.supabase as never, companyId: COMPANY, userId: USER, log: createLogger('test'), now: NOW })
  const ctx: DetectorContext = { ...base, capabilities: async () => caps }
  return { ctx, mock }
}

const employeeCreated: CoreEvent = { type: 'employee.created', payload: { employeeId: 'e1', userId: USER, companyId: COMPANY } }

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('the detector registry', () => {
  it('splits the four detectors into event and scheduled ones', () => {
    expect(DETECTORS.map((d) => d.id)).toEqual(['first-employee', 'sales-channel-connected', 'hide-unused', 'grant-candidate'])
    expect(EVENT_DETECTORS.map((d) => d.id)).toEqual(['first-employee', 'sales-channel-connected', 'grant-candidate'])
    expect(SCHEDULED_DETECTORS.map((d) => d.id)).toEqual(['hide-unused'])
  })
})

describe('first-employee: Slå på Lön?', () => {
  it('wakes on employee.created and on nothing else', async () => {
    const { ctx } = contextWith(capabilitiesWith({ payroll: 'off' }))
    expect(await firstEmployeeDetector.subjects(ctx, employeeCreated)).toEqual([{ packageId: 'payroll' }])
    expect(
      await firstEmployeeDetector.subjects(ctx, { type: 'customer.created', payload: {} } as unknown as CoreEvent),
    ).toEqual([])
    expect(firstEmployeeDetector.trigger).toEqual({ kind: 'event', eventTypes: ['employee.created'] })
  })

  it('holds only while Lön is switched off (never for a Standard company)', async () => {
    expect(await firstEmployeeDetector.condition(contextWith(capabilitiesWith({ payroll: 'off' })).ctx, { packageId: 'payroll' })).toBe(true)
    expect(await firstEmployeeDetector.condition(contextWith(capabilitiesWith({})).ctx, { packageId: 'payroll' })).toBe(false)
    expect(
      await firstEmployeeDetector.condition(contextWith(capabilitiesWith({ payroll: 'not_in_plan' })).ctx, { packageId: 'payroll' }),
    ).toBe(false)
    expect(await firstEmployeeDetector.condition(contextWith(null).ctx, { packageId: 'payroll' })).toBe(false)
  })

  it('proposes enable_package for payroll in plain Swedish', () => {
    const proposal = firstEmployeeDetector.propose({ packageId: 'payroll' })
    expect(proposal).toMatchObject({
      key: 'enable_package:payroll',
      operationType: 'enable_package',
      params: { package_id: 'payroll', source: 'suggestion' },
      title: 'Slå på Lön?',
      rank: 30,
      preview: { package: 'Lön', change: 'Slå på' },
    })
    expect(proposal.reason).toMatch(/^Du har registrerat en anställd\./)
  })
})

describe('sales-channel-connected: Slå på Kassa och webbshop?', () => {
  it('wakes on a till or a webshop connection, with one key for both', async () => {
    const { ctx } = contextWith(capabilitiesWith({ 'pos-and-webshop': 'off' }))
    const event = (type: string) => ({ type, payload: { companyId: COMPANY, userId: USER } }) as unknown as CoreEvent
    expect(await salesChannelConnectedDetector.subjects(ctx, event('pos.connected'))).toEqual([{ packageId: 'pos-and-webshop', channel: 'pos' }])
    expect(await salesChannelConnectedDetector.subjects(ctx, event('zettle.connected'))).toEqual([{ packageId: 'pos-and-webshop', channel: 'pos' }])
    expect(await salesChannelConnectedDetector.subjects(ctx, event('shopify.connected'))).toEqual([
      { packageId: 'pos-and-webshop', channel: 'webshop' },
    ])
    expect(await salesChannelConnectedDetector.subjects(ctx, event('woocommerce.connected'))).toEqual([
      { packageId: 'pos-and-webshop', channel: 'webshop' },
    ])
    expect(await salesChannelConnectedDetector.subjects(ctx, event('stripe.connected'))).toEqual([])
    const pos = salesChannelConnectedDetector.propose({ packageId: 'pos-and-webshop', channel: 'pos' })
    const webshop = salesChannelConnectedDetector.propose({ packageId: 'pos-and-webshop', channel: 'webshop' })
    expect(pos.key).toBe('enable_package:pos-and-webshop')
    expect(webshop.key).toBe(pos.key)
    expect(pos.title).toBe('Slå på Kassa och webbshop?')
    expect(pos.reason).toMatch(/^Du har kopplat ett kassasystem\./)
    expect(webshop.reason).toMatch(/^Du har kopplat en webbshop\./)
  })

  it('holds only while Kassa och webbshop is switched off', async () => {
    const subject = { packageId: 'pos-and-webshop' as const, channel: 'pos' as const }
    expect(await salesChannelConnectedDetector.condition(contextWith(capabilitiesWith({ 'pos-and-webshop': 'off' })).ctx, subject)).toBe(true)
    expect(await salesChannelConnectedDetector.condition(contextWith(capabilitiesWith({})).ctx, subject)).toBe(false)
  })
})

describe('hide-unused: Dölj <paket>?', () => {
  it('is off unless SUGGESTIONS_HIDE_UNUSED is true or 1', () => {
    vi.stubEnv('SUGGESTIONS_HIDE_UNUSED', '')
    expect(hideUnusedSuggestionsEnabled()).toBe(false)
    expect(hideUnusedDetector.enabled?.()).toBe(false)
    vi.stubEnv('SUGGESTIONS_HIDE_UNUSED', 'yes')
    expect(hideUnusedSuggestionsEnabled()).toBe(false)
    vi.stubEnv('SUGGESTIONS_HIDE_UNUSED', 'TRUE')
    expect(hideUnusedSuggestionsEnabled()).toBe(true)
    vi.stubEnv('SUGGESTIONS_HIDE_UNUSED', '1')
    expect(hideUnusedSuggestionsEnabled()).toBe(true)
  })

  it('looks back six months', () => {
    expect(unusedSince(NOW).toISOString()).toBe('2026-04-16T10:00:00.000Z')
  })

  it('offers the switched-on packages of a company older than the window', async () => {
    const { ctx } = contextWith(capabilitiesWith({ payroll: 'off', bank: 'not_in_plan' }), {
      companies: { data: { created_at: '2025-01-01T00:00:00.000Z' } },
    })
    const subjects = await hideUnusedDetector.subjects(ctx, null)
    expect(subjects.map((s) => s.packageId)).toEqual([
      'customer-invoices',
      'supplier-invoices-and-payments',
      'receipts-and-documents',
      'expenses',
      'assets',
      'pos-and-webshop',
    ])
  })

  it('offers nothing for a company younger than the window', async () => {
    const { ctx } = contextWith(capabilitiesWith({}), { companies: { data: { created_at: '2026-09-01T00:00:00.000Z' } } })
    expect(await hideUnusedDetector.subjects(ctx, null)).toEqual([])
  })

  it('holds for an unused package with nothing open, reading usage once', async () => {
    const { ctx, mock } = contextWith(capabilitiesWith({}), {
      'rpc:package_usage': {
        data: [
          { package_id: 'assets', used_since: false, open_obligations: [] },
          { package_id: 'payroll', used_since: false, open_obligations: ['active_employees'] },
          { package_id: 'customer-invoices', used_since: true, open_obligations: [] },
        ],
      },
    })
    expect(await hideUnusedDetector.condition(ctx, { packageId: 'assets' })).toBe(true)
    expect(await hideUnusedDetector.condition(ctx, { packageId: 'payroll' })).toBe(false)
    expect(await hideUnusedDetector.condition(ctx, { packageId: 'customer-invoices' })).toBe(false)
    expect(await hideUnusedDetector.condition(ctx, { packageId: 'expenses' })).toBe(false)
    expect(mock.findCalls('rpc:package_usage', 'rpc')).toEqual([
      [{ p_company_id: COMPANY, p_since: '2026-04-16T10:00:00.000Z' }],
    ])
  })

  it('holds for nothing when usage cannot be read', async () => {
    const { ctx } = contextWith(capabilitiesWith({}), { 'rpc:package_usage': { error: { message: 'boom' } } })
    expect(await hideUnusedDetector.condition(ctx, { packageId: 'assets' })).toBe(false)
  })

  it('proposes disable_package in plain Swedish', () => {
    expect(hideUnusedDetector.propose({ packageId: 'assets' })).toMatchObject({
      key: 'disable_package:assets',
      operationType: 'disable_package',
      params: { package_id: 'assets', source: 'suggestion' },
      title: 'Dölj Inventarier?',
      reason: 'Du har inte använt Inventarier på sex månader, och inget är öppet där. Du kan slå på det igen när du vill.',
      rank: 10,
    })
  })
})
