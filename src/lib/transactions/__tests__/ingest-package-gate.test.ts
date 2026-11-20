import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { PackageId } from '@/lib/modules/packages'

const readPackagesOff = vi.hoisted(() => vi.fn<(...args: unknown[]) => Promise<ReadonlySet<PackageId> | null>>())
vi.mock('@/lib/modules/packages-off', () => ({ readPackagesOff }))

import { INGEST_MATCHERS } from '@/lib/composition/ingest-matchers'
import { INGEST_POOL_OWNERS } from '../ingest-matcher'
import {
  gateIngestMatchers,
  ingestPackageGatingEnabled,
  readIngestPackageGate,
  RUN_EVERY_MATCHER,
} from '../ingest-package-gate'

const supabase = {} as SupabaseClient
const COMPANY_ID = 'company-1'

describe('ingestPackageGatingEnabled', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('is off unless INGEST_PACKAGE_GATING is true or 1', () => {
    vi.stubEnv('INGEST_PACKAGE_GATING', '')
    expect(ingestPackageGatingEnabled()).toBe(false)
    for (const value of ['false', '0', 'yes', 'on']) {
      vi.stubEnv('INGEST_PACKAGE_GATING', value)
      expect(ingestPackageGatingEnabled(), value).toBe(false)
    }
    for (const value of ['true', 'TRUE', '1', ' true ']) {
      vi.stubEnv('INGEST_PACKAGE_GATING', value)
      expect(ingestPackageGatingEnabled(), value).toBe(true)
    }
  })
})

describe('readIngestPackageGate', () => {
  beforeEach(() => {
    readPackagesOff.mockReset()
  })

  it('asks about the packages that own a matcher, once', async () => {
    readPackagesOff.mockResolvedValue(new Set())
    await readIngestPackageGate(supabase, COMPANY_ID, INGEST_MATCHERS)
    expect(readPackagesOff).toHaveBeenCalledTimes(1)
    expect(readPackagesOff).toHaveBeenCalledWith(supabase, COMPANY_ID, ['customer-invoices', 'supplier-invoices-and-payments'])
  })

  it('skips nothing when every package is on or the switch read failed', async () => {
    readPackagesOff.mockResolvedValueOnce(new Set())
    expect(await readIngestPackageGate(supabase, COMPANY_ID, INGEST_MATCHERS)).toBe(RUN_EVERY_MATCHER)
    readPackagesOff.mockResolvedValueOnce(null)
    expect(await readIngestPackageGate(supabase, COMPANY_ID, INGEST_MATCHERS)).toBe(RUN_EVERY_MATCHER)
  })

  it('skips the modules of a package that is fully off, and their pools', async () => {
    readPackagesOff.mockResolvedValueOnce(new Set<PackageId>(['customer-invoices']))
    const gate = await readIngestPackageGate(supabase, COMPANY_ID, INGEST_MATCHERS)
    expect([...gate.off]).toEqual(['customer-invoices'])
    expect(gate.skips('invoicing')).toBe(true)
    expect(gate.skips('collections')).toBe(true)
    expect(gate.skips(INGEST_POOL_OWNERS.customerInvoices)).toBe(true)
    expect(gate.skips(INGEST_POOL_OWNERS.supplierInvoices)).toBe(false)
    expect(gate.skips('payments')).toBe(false)
    // Bokföring and the modules outside every package are never skipped.
    expect(gate.skips('transactions')).toBe(false)
    expect(gate.skips('platform')).toBe(false)
  })
})

describe('gateIngestMatchers', () => {
  const ids = (matchers: readonly { id: string }[]) => matchers.map((m) => m.id)

  it('keeps the list itself when nothing is skipped', () => {
    expect(gateIngestMatchers(INGEST_MATCHERS, RUN_EVERY_MATCHER)).toBe(INGEST_MATCHERS)
  })

  it('drops the matchers of a skipped package and keeps the rest in their order', async () => {
    readPackagesOff.mockResolvedValueOnce(new Set<PackageId>(['customer-invoices']))
    const customerOff = await readIngestPackageGate(supabase, COMPANY_ID, INGEST_MATCHERS)
    expect(ids(gateIngestMatchers(INGEST_MATCHERS, customerOff))).toEqual(['payment-order', 'supplier-invoice'])

    readPackagesOff.mockResolvedValueOnce(new Set<PackageId>(['supplier-invoices-and-payments']))
    const supplierOff = await readIngestPackageGate(supabase, COMPANY_ID, INGEST_MATCHERS)
    expect(ids(gateIngestMatchers(INGEST_MATCHERS, supplierOff))).toEqual([
      'customer-invoice',
      'rot-rut-payout',
      'rot-rut-payout-set',
      'collections-sweep',
    ])
    expect(supplierOff.skips(INGEST_POOL_OWNERS.supplierInvoices)).toBe(true)
  })
})
