/**
 * Systemdokumentation generator: the pure builder against a facts fixture,
 * and the loader against a table-keyed mock (the loader issues its reads in
 * parallel, so a queued mock would pin an order that is not part of the
 * contract).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { buildSystemdokumentation, loadSystemdokumentationFacts, type SystemdokumentationFacts } from '../systemdokumentation'
import { SUPPLIER_INVOICE_ROUNDING_RULES, VOUCHER_SERIES_RULES } from '../system-rules'

vi.mock('@/lib/branding/service', () => ({
  getBranding: () => ({ appName: 'Accounted', appUrl: 'https://app.accounted.se' }),
}))

function facts(overrides: Partial<SystemdokumentationFacts> = {}): SystemdokumentationFacts {
  return {
    company: { name: 'Test AB', org_number: '5560000000', accounting_framework: 'k2' },
    settings: {
      entity_type: 'aktiebolag',
      accounting_method: 'accrual',
      moms_period: 'quarterly',
      vat_registered: true,
      pays_salaries: false,
      fiscal_year_start_month: 1,
      bookkeeping_locked_through: '2026-03-31',
      auto_lock_period_days: null,
      default_voucher_series: 'A',
      default_voucher_series_per_source_type: { invoice_created: 'B', salary_payment: 'K' },
      voucher_series_labels: { K: 'Löner' },
      ore_rounding: false,
      dimensions_enabled: true,
      recurring_invoices_enabled: false,
      invoice_payment_links_enabled: false,
    },
    period: { id: 'p1', name: 'Räkenskapsår 2026', period_start: '2026-01-01', period_end: '2026-12-31', is_closed: false, locked_at: null },
    accounts: [
      { account_number: '1930', account_name: 'Företagskonto', account_class: 1, sru_code: '7281' },
      { account_number: '2440', account_name: 'Leverantörsskulder', account_class: 2, sru_code: null },
      { account_number: '2641', account_name: 'Ingående moms', account_class: 2, sru_code: null },
      { account_number: '3001', account_name: 'Försäljning 25%', account_class: 3, sru_code: '7410' },
    ],
    sequences: [
      { voucher_series: 'B', last_number: 12 },
      { voucher_series: 'A', last_number: 340 },
    ],
    cashAccounts: [
      { name: 'Företagskonto', ledger_account: '1930', voucher_series: null, source: 'enable_banking', enabled: true },
      { name: 'Sparkonto', ledger_account: '1940', voucher_series: 'F', source: 'manual', enabled: true },
      { name: 'Gammalt konto', ledger_account: '1950', voucher_series: 'G', source: 'manual', enabled: false },
    ],
    members: [
      { user_id: 'u-member', role: 'member', joined_at: '2026-02-01T00:00:00Z' },
      { user_id: 'u-owner', role: 'owner', joined_at: '2026-01-01T00:00:00Z' },
    ],
    apiKeys: [
      { name: 'Byråns assistent', key_prefix: 'gnubok_sk_ab12', user_id: 'u-owner', scopes: ['bookkeeping:write', 'reports:read'], created_at: '2026-03-01T00:00:00Z', last_used_at: null, unattended_commit_limit: '5000.00' },
    ],
    dimensions: [{ name: 'Kostnadsställe' }, { name: 'Projekt' }],
    connections: { bank: true, skatteverket: true, peppol: false, stripe: true, shopify: false, woocommerce: false, zettle: false, whatsapp: false, email_inbox: false, cloud_backup: false },
    labels: new Map([
      ['u-owner', 'anna@example.se'],
      ['u-member', 'Bo Bokförare'],
    ]),
    env: { appName: 'Accounted', appUrl: 'https://app.accounted.se', hosted: true, mfaRequired: true, appVersion: 'abc1234', generatedAt: '2026-09-25T10:00:00.000Z' },
    ...overrides,
  }
}

describe('buildSystemdokumentation', () => {
  it('describes company, period and kontoplan from the facts', () => {
    const r = buildSystemdokumentation(facts())
    expect(r.company).toMatchObject({ name: 'Test AB', entity_type: 'aktiebolag', accounting_method: 'accrual', accounting_framework: 'k2', vat_registered: true })
    expect(r.period).toEqual({ id: 'p1', name: 'Räkenskapsår 2026', start: '2026-01-01', end: '2026-12-31', is_closed: false, locked_at: null })
    expect(r.kontoplan.accounts).toHaveLength(4)
    expect(r.kontoplan.class_summary).toEqual([
      { account_class: 1, count: 1 },
      { account_class: 2, count: 2 },
      { account_class: 3, count: 1 },
    ])
    expect(r.app_version).toBe('abc1234')
    expect(r.system).toEqual({ name: 'Accounted', url: 'https://app.accounted.se', hosted: true })
  })

  it('resolves the series per source type through the company map and names custom letters with the company label', () => {
    const r = buildSystemdokumentation(facts())
    const byType = Object.fromEntries(r.verifikationsserier.per_source_type.map((row) => [row.source_type, row]))
    expect(byType.invoice_created).toMatchObject({ series: 'B', series_label: 'Kundfakturor', label: 'Kundfaktura' })
    expect(byType.salary_payment).toMatchObject({ series: 'K', series_label: 'Löner' })
    expect(byType.manual).toMatchObject({ series: 'A', series_label: 'Redovisning' })
    expect(byType.supplier_invoice_registered.series).toBe('A')
  })

  it('lists cash account series overrides for enabled accounts only, and the sequences of the year in series order', () => {
    const r = buildSystemdokumentation(facts())
    expect(r.verifikationsserier.cash_account_overrides).toEqual([{ account_name: 'Sparkonto', ledger_account: '1940', series: 'F', series_label: 'Kassa' }])
    expect(r.verifikationsserier.sequences).toEqual([
      { series: 'A', series_label: 'Redovisning', last_number: 340 },
      { series: 'B', series_label: 'Kundfakturor', last_number: 12 },
    ])
    expect(r.verifikationsserier.ordning).toEqual([...VOUCHER_SERIES_RULES.ordning])
  })

  it('marks delsystem and integrations active from connections and settings', () => {
    const r = buildSystemdokumentation(facts())
    const active = Object.fromEntries(r.delsystem.map((d) => [d.key, d.active]))
    expect(active).toMatchObject({ bank: true, stripe: true, webbutik: false, loner: false, moms: true, dimensioner: true, kundfakturering: true })
    expect(r.delsystem.find((d) => d.key === 'dimensioner')?.description).toContain('Kostnadsställe, Projekt')
    const integrations = Object.fromEntries(r.integrationer.map((i) => [i.key, i.active]))
    expect(integrations).toMatchObject({ enable_banking: true, skatteverket: true, stripe: true, peppol: false, shopify: false, ai: true })
  })

  it('carries the shared behandlingsregler and the per-company rounding and lock settings', () => {
    const r = buildSystemdokumentation(facts())
    const byTitle = Object.fromEntries(r.behandlingsregler.map((x) => [x.rubrik, x.text]))
    expect(byTitle['Öresavrundning på leverantörsfakturor']).toBe(SUPPLIER_INVOICE_ROUNDING_RULES.val)
    expect(byTitle['Öresavrundning på kundfakturor']).toContain('avstängd')
    expect(byTitle['Automatisk låsning']).toBeUndefined()
    expect(r.rattelse_och_las.lock_date).toBe('2026-03-31')

    const withAutoLock = buildSystemdokumentation(facts({ settings: { ...facts().settings!, ore_rounding: true, auto_lock_period_days: 45 } }))
    const t2 = Object.fromEntries(withAutoLock.behandlingsregler.map((x) => [x.rubrik, x.text]))
    expect(t2['Öresavrundning på kundfakturor']).toContain('3740')
    expect(t2['Automatisk låsning']).toContain('45 dagar')
  })

  it('lists members by role with labels and API keys with scope labels and the numeric cap', () => {
    const r = buildSystemdokumentation(facts())
    expect(r.behorigheter.mfa_required).toBe(true)
    expect(r.behorigheter.members.map((m) => [m.role, m.label])).toEqual([
      ['owner', 'anna@example.se'],
      ['member', 'Bo Bokförare'],
    ])
    expect(r.behorigheter.api_keys).toEqual([
      expect.objectContaining({ name: 'Byråns assistent', owner_label: 'anna@example.se', unattended_commit_limit: 5000, scopes: ['Bokföring: skriv', 'Rapporter: läs'] }),
    ])
  })

  it('falls back to defaults when the company has no settings row', () => {
    const r = buildSystemdokumentation(facts({ settings: null, apiKeys: [], members: [], labels: new Map() }))
    expect(r.company.accounting_method).toBeNull()
    expect(r.verifikationsserier.per_source_type.every((row) => row.series === 'A')).toBe(true)
    expect(r.rattelse_och_las.lock_date).toBeNull()
    expect(r.behorigheter.api_keys).toEqual([])
  })
})

/**
 * Table-keyed mock: every builder chain on `table` resolves to its configured
 * result whatever methods are chained. `calls` records (table, method, args).
 */
function tableMock(results: Record<string, { data?: unknown; error?: { message: string } | null }>) {
  const calls: { table: string; method: string; args: unknown[] }[] = []
  const chain = (table: string): unknown => {
    const result = results[table] ?? { data: [], error: null }
    const handler: ProxyHandler<object> = {
      get(_t, prop) {
        if (prop === 'then') return (resolve: (v: unknown) => void) => resolve({ data: result.data ?? null, error: result.error ?? null })
        return (...args: unknown[]) => {
          calls.push({ table, method: String(prop), args })
          return new Proxy({}, handler)
        }
      },
    }
    return new Proxy({}, handler)
  }
  const from = vi.fn((table: string) => chain(table))
  return { client: { from } as unknown as SupabaseClient, calls, from }
}

const PERIOD = { id: 'p1', name: 'Räkenskapsår 2026', period_start: '2026-01-01', period_end: '2026-12-31', is_closed: false, locked_at: null }

describe('loadSystemdokumentationFacts', () => {
  beforeEach(() => {
    vi.unstubAllEnvs()
  })

  it('returns null when the period does not belong to the company', async () => {
    const db = tableMock({ fiscal_periods: { data: null }, companies: { data: { name: 'Test AB', org_number: null } } })
    await expect(loadSystemdokumentationFacts(db.client, 'company-1', 'p-other')).resolves.toBeNull()
    expect(db.calls.find((c) => c.table === 'fiscal_periods' && c.method === 'eq')?.args).toEqual(['id', 'p-other'])
  })

  it('derives connections from the side tables and tolerates one that fails', async () => {
    const db = tableMock({
      fiscal_periods: { data: PERIOD },
      companies: { data: { name: 'Test AB', org_number: '5560000000', accounting_framework: 'k3' } },
      company_settings: { data: { entity_type: 'aktiebolag', pays_salaries: true } },
      chart_of_accounts: { data: [{ account_number: '1930', account_name: 'Företagskonto', account_class: 1, sru_code: null }] },
      voucher_sequences: { data: [{ voucher_series: 'A', last_number: 3 }] },
      cash_accounts: { data: [{ name: 'Bank', ledger_account: '1930', voucher_series: null, source: 'enable_banking', enabled: true }] },
      company_members: { data: [{ user_id: 'u1', role: 'owner', joined_at: '2026-01-01T00:00:00Z' }] },
      stripe_connections: { data: [{ id: 's1' }] },
      peppol_registrations: { data: [] },
      skatteverket_company_connections: { error: { message: 'relation does not exist' } },
      extension_data: { data: [{ id: 'cb' }] },
    })
    const service = tableMock({ api_keys: { data: [{ name: 'k', key_prefix: 'gnubok_sk_x', user_id: 'u1', scopes: null, created_at: '2026-01-02T00:00:00Z', last_used_at: null, unattended_commit_limit: null }] } })
    const resolveUserLabels = vi.fn().mockResolvedValue(new Map([['u1', 'anna@example.se']]))

    const f = await loadSystemdokumentationFacts(db.client, 'company-1', 'p1', {
      serviceClient: service.client as unknown as Pick<SupabaseClient, 'from'>,
      resolveUserLabels,
      appVersion: 'v1',
      now: new Date('2026-09-25T10:00:00Z'),
    })
    expect(f).not.toBeNull()
    expect(f!.company.accounting_framework).toBe('k3')
    expect(f!.connections).toEqual({ bank: true, skatteverket: false, peppol: false, stripe: true, shopify: false, woocommerce: false, zettle: false, whatsapp: false, email_inbox: false, cloud_backup: true })
    expect(f!.accounts).toHaveLength(1)
    expect(f!.sequences).toEqual([{ voucher_series: 'A', last_number: 3 }])
    expect(f!.apiKeys).toHaveLength(1)
    expect(service.calls.find((c) => c.table === 'api_keys' && c.method === 'in')?.args).toEqual(['user_id', ['u1']])
    // Keys bound to another company never enter this company's document.
    expect(service.calls.find((c) => c.table === 'api_keys' && c.method === 'eq')?.args).toEqual(['company_id', 'company-1'])
    expect(resolveUserLabels).toHaveBeenCalledWith(['u1'])
    expect(f!.labels.get('u1')).toBe('anna@example.se')
    expect(f!.env).toMatchObject({ appVersion: 'v1', generatedAt: '2026-09-25T10:00:00.000Z', appName: 'Accounted' })
    // Every company-scoped read filters by company_id (defense in depth beside RLS).
    for (const table of ['chart_of_accounts', 'voucher_sequences', 'cash_accounts', 'company_members', 'stripe_connections', 'extension_data']) {
      expect(db.calls.some((c) => c.table === table && c.method === 'eq' && c.args[0] === 'company_id' && c.args[1] === 'company-1')).toBe(true)
    }
  })

  it('refuses the document when the member read fails: an empty access section would be wrong, not degraded', async () => {
    const db = tableMock({
      fiscal_periods: { data: PERIOD },
      companies: { data: { name: 'Test AB', org_number: null } },
      company_members: { error: { message: 'permission denied' } },
    })
    await expect(loadSystemdokumentationFacts(db.client, 'company-1', 'p1')).rejects.toThrow('medlemmar')
  })

  it('skips the API key lookup without a service client and reads mfa/self-hosted from the flags', async () => {
    vi.stubEnv('NEXT_PUBLIC_REQUIRE_MFA', 'true')
    vi.stubEnv('NEXT_PUBLIC_SELF_HOSTED', 'true')
    const db = tableMock({
      fiscal_periods: { data: PERIOD },
      companies: { data: { name: 'Test AB', org_number: null } },
      company_settings: { data: null },
      company_members: { data: [{ user_id: 'u1', role: 'owner', joined_at: '2026-01-01T00:00:00Z' }] },
    })
    const f = await loadSystemdokumentationFacts(db.client, 'company-1', 'p1')
    expect(f!.apiKeys).toEqual([])
    expect(f!.env.mfaRequired).toBe(true)
    expect(f!.env.hosted).toBe(false)
    expect(db.calls.some((c) => c.table === 'api_keys')).toBe(false)
  })
})
