import { describe, it, expect } from 'vitest'
import { buildMigrateRequests, mergeMigrationResults, migrationProvedGrant } from '../migrate-plan'
import type { MigrationResults } from '../../types'

/**
 * #2469: the wizard drives /migrate one step per request so each step gets
 * the function's whole 300 s. These lock the shape the route relies on:
 * exactly one import flag per request, run order preserved, and the
 * finishing work (reconciliation, party suggestions) only on the last one.
 */

describe('buildMigrateRequests', () => {
  it('emits one request per selected step, in run order, with one flag on each', () => {
    const requests = buildMigrateRequests('consent-1', {
      importSalesInvoices: true,
      importCustomers: true,
      importSupplierInvoices: true,
    })

    expect(requests.map((r) => r.step)).toEqual([
      'importCustomers', 'importSalesInvoices', 'importSupplierInvoices',
    ])
    for (const request of requests) {
      const on = Object.entries(request.body)
        .filter(([key, value]) => key.startsWith('import') && value === true)
        .map(([key]) => key)
      expect(on).toEqual([request.step])
      expect(request.body.consentId).toBe('consent-1')
    }
  })

  it('runs reconciliation and party suggestions only in the last request', () => {
    const requests = buildMigrateRequests('consent-1', {
      importCustomers: true,
      importSuppliers: true,
      importSupplierInvoices: true,
    })

    expect(requests.map((r) => r.body.reconcileVouchers)).toEqual([false, false, true])
    expect(requests.map((r) => r.body.suggestParties)).toEqual([false, false, true])
  })

  it('a single selected step is also the last one', () => {
    const [only, ...rest] = buildMigrateRequests('consent-1', { importSalesInvoices: true })
    expect(rest).toHaveLength(0)
    expect(only.body.reconcileVouchers).toBe(true)
    expect(only.body.suggestParties).toBe(true)
  })

  it('emits nothing when no step is selected', () => {
    expect(buildMigrateRequests('consent-1', {})).toEqual([])
    expect(buildMigrateRequests('consent-1', { importAssets: false })).toEqual([])
  })

  it('carries a Swedish label per step for the progress line', () => {
    const [request] = buildMigrateRequests('consent-1', { importSalesInvoices: true })
    expect(request.label).toBe('Importerar kundfakturor...')
  })
})

describe('mergeMigrationResults', () => {
  it('keeps every step result and unions the step errors', () => {
    const first: MigrationResults = {
      customers: { total: 10, imported: 8, skipped: 2 },
      stepErrors: [{ step: 'suppliers', code: null, message: 'nope' }],
    }
    const second: MigrationResults = {
      salesInvoices: { total: 5, imported: 5, skipped: 0 },
      stepErrors: [{ step: 'salesInvoices', code: null, message: 'later' }],
    }

    const merged = mergeMigrationResults(first, second)

    expect(merged.customers).toEqual(first.customers)
    expect(merged.salesInvoices).toEqual(second.salesInvoices)
    expect(merged.stepErrors?.map((e) => e.step)).toEqual(['suppliers', 'salesInvoices'])
  })

  it('leaves stepErrors absent when neither side had any', () => {
    const merged = mergeMigrationResults(
      { customers: { total: 1, imported: 1, skipped: 0 } },
      { suppliers: { total: 1, imported: 1, skipped: 0 } },
    )
    expect(merged.stepErrors).toBeUndefined()
  })

  it('tolerates a request that returned no results', () => {
    const into: MigrationResults = { customers: { total: 1, imported: 1, skipped: 0 } }
    expect(mergeMigrationResults(into, undefined)).toEqual(into)
    expect(mergeMigrationResults(into, null)).toEqual(into)
  })
})

describe('migrationProvedGrant', () => {
  it('is false until some register returned rows', () => {
    expect(migrationProvedGrant({})).toBe(false)
    expect(migrationProvedGrant({ customers: { total: 0, imported: 0, skipped: 0 } })).toBe(false)
    expect(migrationProvedGrant({ companyInfo: { imported: false } })).toBe(false)
  })

  it('is true once any register answered with rows, imported or skipped', () => {
    expect(migrationProvedGrant({ customers: { total: 3, imported: 0, skipped: 3 } })).toBe(true)
    expect(migrationProvedGrant({ suppliers: { total: 1, imported: 1, skipped: 0 } })).toBe(true)
    expect(migrationProvedGrant({ companyInfo: { imported: true } })).toBe(true)
  })
})
