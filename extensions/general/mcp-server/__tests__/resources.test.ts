import { describe, it, expect } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { dataResources, findResource, parseResourceQuery } from '../resources'

describe('mcp resource registry', () => {
  it('exposes all data resources with required fields', () => {
    expect(dataResources).toHaveLength(10)
    const uris = dataResources.map((r) => r.uri).sort()
    expect(uris).toEqual([
      'Accounted://attention',
      'Accounted://booking-templates',
      'Accounted://capabilities',
      'Accounted://chart-of-accounts',
      'Accounted://company/current',
      'Accounted://ledger/context',
      'Accounted://period/active',
      'Accounted://recent-activity',
      'Accounted://reconciliation/summary',
      'Accounted://settings/vat-treatments',
    ])

    for (const r of dataResources) {
      expect(r.name).toBeTruthy()
      expect(r.description.length).toBeGreaterThan(20)
      expect(r.mimeType).toBe('application/json')
      expect(typeof r.read).toBe('function')
    }
  })

  it('matches base URI ignoring query string', () => {
    const r = findResource('Accounted://recent-activity?limit=5')
    expect(r?.uri).toBe('Accounted://recent-activity')
  })

  it('returns null for unknown URI', () => {
    expect(findResource('Accounted://does-not-exist')).toBeNull()
  })

  it('parses query params from URI', () => {
    const q = parseResourceQuery('Accounted://recent-activity?limit=5&offset=10')
    expect(q?.get('limit')).toBe('5')
    expect(q?.get('offset')).toBe('10')
  })

  it('returns undefined when no query', () => {
    expect(parseResourceQuery('Accounted://capabilities')).toBeUndefined()
  })
})

describe('chart-of-accounts resource', () => {
  it('pages past the PostgREST 1000-row cap and reports the full total', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    const makeAccount = (n: number) => ({
      account_number: String(n),
      account_name: `Konto ${n}`,
      account_class: Math.floor(n / 1000),
      account_type: 'asset',
      normal_balance: 'debit',
      is_active: true,
      default_vat_code: null,
    })
    // Page 1: exactly PAGE_SIZE class-1 rows; page 2: 290 class-2 rows.
    enqueue({ data: Array.from({ length: 1000 }, (_, i) => makeAccount(1000 + i)) })
    enqueue({ data: Array.from({ length: 290 }, (_, i) => makeAccount(2000 + i)) })

    const r = findResource('Accounted://chart-of-accounts')!
    const result = (await r.read({
      supabase: supabase as never,
      companyId: 'company-1',
      userId: 'user-1',
      scopes: [],
    })) as { total: number; classes: Record<string, { accounts: unknown[] }> }

    expect(result.total).toBe(1290)
    expect(result.classes['1'].accounts).toHaveLength(1000)
    expect(result.classes['2'].accounts).toHaveLength(290)
    // Paging invariant: ordered on the unique account_number, two ranges.
    expect(findCalls('chart_of_accounts', 'order')).toEqual([
      ['account_number', { ascending: true }],
      ['account_number', { ascending: true }],
    ])
    expect(findCalls('chart_of_accounts', 'range')).toEqual([
      [0, 999],
      [1000, 1999],
    ])
  })
})

describe('vat-treatments resource', () => {
  it('returns matrix for all customer types without DB access', async () => {
    const r = findResource('Accounted://settings/vat-treatments')!
    const result = (await r.read({
      // Pure-function resource: no DB calls
      supabase: undefined as never,
      companyId: 'irrelevant',
      userId: 'irrelevant',
      scopes: [],
    })) as { treatments: string[]; by_customer_type: Record<string, unknown> }

    expect(result.treatments).toContain('standard_25')
    expect(result.treatments).toContain('reverse_charge')
    expect(Object.keys(result.by_customer_type)).toEqual([
      'individual',
      'swedish_business',
      'eu_business',
      'non_eu_business',
    ])
  })
})
