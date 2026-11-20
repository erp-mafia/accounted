import { describe, expect, it } from 'vitest'
import {
  getModule,
  moduleForLibPath,
  moduleForOperationId,
  moduleForV1Path,
  modulesInDependencyOrder,
} from '../resolve'

describe('getModule', () => {
  it('returns the definition for a known id and undefined otherwise', () => {
    expect(getModule('ledger').kind).toBe('kernel')
    expect(getModule('invoicing').kind).toBe('block')
    expect(getModule('no-such-module')).toBeUndefined()
  })
})

describe('moduleForOperationId', () => {
  it('resolves by the prefix before the first dot', () => {
    expect(moduleForOperationId('journal-entries.correct-metadata')).toBe('ledger')
    expect(moduleForOperationId('invoices.send-peppol')).toBe('invoicing')
    expect(moduleForOperationId('supplier-invoices.attest-policy.get')).toBe('supplier-invoices')
    expect(moduleForOperationId('collections.cases.open')).toBe('collections')
    expect(moduleForOperationId('arsredovisning.validate-ixbrl')).toBe('year-end')
  })

  it('answers undefined for an unclaimed prefix or a malformed id', () => {
    expect(moduleForOperationId('nothing.here')).toBeUndefined()
    expect(moduleForOperationId('invoices')).toBeUndefined()
    expect(moduleForOperationId('.invoices')).toBeUndefined()
    expect(moduleForOperationId('')).toBeUndefined()
  })
})

describe('moduleForV1Path', () => {
  it('resolves a company-scoped pattern by its first segment', () => {
    expect(moduleForV1Path('/api/v1/companies/:companyId/invoices/:id/credit')).toBe('invoicing')
    expect(moduleForV1Path('/api/v1/companies/:companyId/journal-entries')).toBe('ledger')
    expect(moduleForV1Path('/api/v1/companies/:companyId/bank-feed/banks/:bic')).toBe('bank-feed')
  })

  it('accepts the OpenAPI spelling and a concrete request path with a query string', () => {
    expect(moduleForV1Path('/api/v1/companies/{companyId}/salary-runs/{id}')).toBe('payroll')
    expect(moduleForV1Path('/api/v1/companies/3f2a/supplier-invoices/9b?dry_run=true')).toBe('supplier-invoices')
  })

  it('resolves routes outside a company by their first segment, including the company list itself', () => {
    expect(moduleForV1Path('/api/v1/health')).toBe('platform')
    expect(moduleForV1Path('/api/v1/companies')).toBe('platform')
    expect(moduleForV1Path('/api/v1/operations/:id')).toBe('platform')
  })

  it('lets a longer claim carve a sub-path out of another module segment', () => {
    expect(moduleForV1Path('/api/v1/companies/:companyId/fiscal-periods/:id')).toBe('ledger')
    expect(moduleForV1Path('/api/v1/companies/:companyId/fiscal-periods/:id/lock')).toBe('ledger')
    expect(moduleForV1Path('/api/v1/companies/:companyId/fiscal-periods/:id/arsredovisning/pdf')).toBe('year-end')
    expect(moduleForV1Path('/api/v1/companies/c1/fiscal-periods/p1/arsredovisning/signatures/s1')).toBe('year-end')
  })

  it('answers undefined outside /api/v1 or for an unclaimed segment', () => {
    expect(moduleForV1Path('/api/invoices')).toBeUndefined()
    expect(moduleForV1Path('/api/v1/')).toBeUndefined()
    expect(moduleForV1Path('/api/v1/companies/:companyId/no-such-resource')).toBeUndefined()
  })
})

describe('moduleForLibPath', () => {
  it('accepts every spelling of a src/lib path', () => {
    expect(moduleForLibPath('src/lib/invoices/book-service.ts')).toBe('invoicing')
    expect(moduleForLibPath('/repo/src/lib/salary/book-run.ts')).toBe('payroll')
    expect(moduleForLibPath('@/lib/bookkeeping/engine')).toBe('ledger')
    expect(moduleForLibPath('lib/vat/gross-split')).toBe('vat')
    expect(moduleForLibPath('collections/forward-hook')).toBe('collections')
    expect(moduleForLibPath('C:\\repo\\src\\lib\\pos-sales\\book-day.ts')).toBe('pos')
  })

  it('lets a sub-folder claim win over its parent folder', () => {
    expect(moduleForLibPath('bokslut/assets/asset-service.ts')).toBe('assets')
    expect(moduleForLibPath('bokslut/assets')).toBe('assets')
    expect(moduleForLibPath('bokslut/arsredovisning/build-data.ts')).toBe('year-end')
    expect(moduleForLibPath('documents/read/pdf.ts')).toBe('inbox')
    expect(moduleForLibPath('documents/link-document.ts')).toBe('ledger')
  })

  it('does not let a folder claim match a sibling that merely shares its prefix', () => {
    // `agent` must not swallow `agent-skills`, nor `bokslut/assets` a file named `bokslut/assets-x`.
    expect(moduleForLibPath('agent-skills/catalog.ts')).toBe('agent')
    expect(moduleForLibPath('bokslut/assets-x.ts')).toBe('year-end')
  })

  it('answers undefined for infrastructure, root files and paths outside src/lib', () => {
    expect(moduleForLibPath('supabase/server.ts')).toBeUndefined()
    expect(moduleForLibPath('src/lib/logger.ts')).toBeUndefined()
    expect(moduleForLibPath('src/app/api/invoices/route.ts')).toBeUndefined()
    expect(moduleForLibPath('@/components/ui/button')).toBeUndefined()
    expect(moduleForLibPath('./relative/path')).toBeUndefined()
  })
})

describe('modulesInDependencyOrder', () => {
  it('puts the kernels first and every declared dependency before its dependent', () => {
    const order = modulesInDependencyOrder().map((m) => m.id)
    expect(order.slice(0, 2)).toEqual(['platform', 'ledger'])
    expect(order.indexOf('transactions')).toBeLessThan(order.indexOf('bank-feed'))
    expect(order.indexOf('bank-feed')).toBeLessThan(order.indexOf('payments'))
    expect(order.indexOf('payroll')).toBeLessThan(order.indexOf('expenses'))
    expect(order.indexOf('assets')).toBeLessThan(order.indexOf('year-end'))
  })
})
