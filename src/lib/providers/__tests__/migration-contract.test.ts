import { describe, expect, it } from 'vitest'
import {
  MIGRATION_RESOURCES, isTransientIssueCode, migrationIssueHref, migrationIssueKind, migrationIssueReason,
  emptyMigrationRegisters, migrationJobErrorMessageKey, migrationRefusalMessageKey, migrationRefusalMessageValues,
  migrationRefusals, USER_RIGHT_REFUSAL_MESSAGE_KEY,
} from '../migration-contract'
import sv from '@/messages/sv.json'
import en from '@/messages/en.json'

describe('migrationIssueKind', () => {
  it('maps an existing, differing record to "exists", never to a retry', () => {
    expect(migrationIssueKind('MIGRATION_INVOICE_NUMBER_TAKEN')).toBe('exists')
    // Chunks stored before the named code existed carry the bare SQLSTATE.
    expect(migrationIssueKind('23505')).toBe('exists')
  })

  it('keeps the existing groups unchanged', () => {
    expect(migrationIssueKind('PROVIDER_AUTH_EXPIRED')).toBe('connection')
    expect(migrationIssueKind('MIGRATION_WRITE_FORBIDDEN')).toBe('access')
    expect(migrationIssueKind('PROVIDER_LICENSE_MISSING')).toBe('access')
    expect(migrationIssueKind('MIGRATION_INVOICE_AMBIGUOUS')).toBe('review')
    expect(migrationIssueKind('MIGRATION_INVOICE_CHANGED')).toBe('review')
    expect(migrationIssueKind('MIGRATION_ROWS_MISMATCH')).toBe('lines')
    expect(migrationIssueKind('MIGRATION_INVOICE_TOO_LARGE')).toBe('size')
  })

  it('falls back to a retry for transient or unknown codes', () => {
    expect(migrationIssueKind('MIGRATION_DETAIL_RETRY')).toBe('retry')
    // A job parked after five claims that ran out of time with nothing saved (#115).
    expect(migrationIssueKind('MIGRATION_STALLED')).toBe('retry')
    expect(migrationIssueKind('40001')).toBe('retry')
    expect(migrationIssueKind(null)).toBe('retry')
  })

  it('never calls a refused register a record to retry', () => {
    // A job stopped on PROVIDER_RESOURCE_FORBIDDEN: the connection works and
    // lacks a permission, so a retry alone gets the same answer.
    expect(migrationIssueKind('PROVIDER_RESOURCE_FORBIDDEN')).toBe('refused')
  })
})

describe('migrationJobErrorMessageKey', () => {
  it('points a refusal on a working Bokio connection at the integration token, elsewhere at the user (crm#1081)', () => {
    expect(migrationJobErrorMessageKey({ error_code: 'PROVIDER_RESOURCE_FORBIDDEN', provider: 'bokio' })).toBe('ext_arcim_job_error_refused_token')
    for (const provider of ['fortnox', 'visma', 'briox', 'bjornlunden', 'wint']) {
      expect(migrationJobErrorMessageKey({ error_code: 'PROVIDER_RESOURCE_FORBIDDEN', provider })).toBe(USER_RIGHT_REFUSAL_MESSAGE_KEY)
    }
  })

  it('keeps the kind of every other code, the provider aside', () => {
    expect(migrationJobErrorMessageKey({ error_code: 'PROVIDER_AUTH_EXPIRED', provider: 'bokio' })).toBe('ext_arcim_job_error_connection')
    expect(migrationJobErrorMessageKey({ error_code: 'MIGRATION_WRITE_FORBIDDEN', provider: 'fortnox' })).toBe('ext_arcim_job_error_access')
    expect(migrationJobErrorMessageKey({ error_code: 'MIGRATION_RETRY' })).toBe('ext_arcim_job_error_retry')
  })

  // A subscription that shuts the API out stops the whole job. "Check the
  // provider's API subscription and your permission" named neither the
  // Visma API module nor the licence (crm#1081).
  it('names what to activate when the subscription shuts the API out', () => {
    expect(migrationJobErrorMessageKey({ error_code: 'PROVIDER_API_MODULE_INACTIVE', provider: 'visma' })).toBe('ext_arcim_job_error_api_module')
    expect(migrationJobErrorMessageKey({ error_code: 'BOKIO_PLAN_NO_API', provider: 'bokio' })).toBe('ext_arcim_job_error_bokio_plan')
    expect(migrationIssueKind('BOKIO_PLAN_NO_API')).toBe('access')
    expect(migrationJobErrorMessageKey({ error_code: 'PROVIDER_LICENSE_MISSING', provider: 'fortnox' })).toBe('ext_arcim_job_error_api_license')
    for (const key of ['ext_arcim_job_error_api_module', 'ext_arcim_job_error_api_license', 'ext_arcim_job_error_bokio_plan']) {
      for (const messages of [sv, en]) {
        const text = (messages as { extensions: Record<string, string> }).extensions[key]
        expect(text).toBeTruthy()
        expect(text).not.toMatch(/[\u2013\u2014]/)
      }
    }
    expect(sv.extensions.ext_arcim_job_error_api_module).toContain('API-modulen')
    expect(sv.extensions.ext_arcim_job_error_api_license).toContain('{provider}')
  })
})

describe('refused registers', () => {
  it('points a missing licence at the module the register needs, and a missing permission at the user', () => {
    expect(migrationRefusalMessageKey('customers', 'license')).toBe('ext_arcim_job_refused_license_sales')
    expect(migrationRefusalMessageKey('salesInvoices', 'license')).toBe('ext_arcim_job_refused_license_sales')
    expect(migrationRefusalMessageKey('suppliers', 'license')).toBe('ext_arcim_job_refused_license_purchase')
    expect(migrationRefusalMessageKey('supplierInvoices', 'license')).toBe('ext_arcim_job_refused_license_purchase')
    for (const resource of ['customers', 'suppliers', 'salesInvoices', 'supplierInvoices'] as const) {
      expect(migrationRefusalMessageKey(resource, 'permission')).toBe(USER_RIGHT_REFUSAL_MESSAGE_KEY)
      expect(migrationRefusalMessageKey(resource, 'permission', 'fortnox')).toBe(USER_RIGHT_REFUSAL_MESSAGE_KEY)
      // A Bokio integration token carries its own read permissions.
      expect(migrationRefusalMessageKey(resource, 'permission', 'bokio')).toBe('ext_arcim_job_refused_token')
    }
  })

  it('groups the registers one remedy covers, in register order', () => {
    expect(migrationRefusals({ refused_resources: { salesInvoices: 'license', suppliers: 'permission', customers: 'license' } })).toEqual([
      { messageKey: 'ext_arcim_job_refused_license_sales', resources: ['customers', 'salesInvoices'] },
      { messageKey: USER_RIGHT_REFUSAL_MESSAGE_KEY, resources: ['suppliers'] },
    ])
  })

  it('names the Bokio token for a register its integration may not read', () => {
    expect(migrationRefusals({ provider: 'bokio', refused_resources: { supplierInvoices: 'permission' } })).toEqual([
      { messageKey: 'ext_arcim_job_refused_token', resources: ['supplierInvoices'] },
    ])
  })

  it('reads a job with none, or one stored before the column existed, as none', () => {
    expect(migrationRefusals({ refused_resources: {} })).toEqual([])
    expect(migrationRefusals({})).toEqual([])
    expect(migrationRefusals({ refused_resources: { customers: 'timeout' } as never })).toEqual([])
  })

  it('names the refused registers in the user-right sentence, in lower case (crm#1014)', () => {
    const label = (resource: string) => (sv.extensions as Record<string, string>)[`ext_arcim_job_resource_${resource}`]
    expect(migrationRefusalMessageValues(['suppliers', 'supplierInvoices'], 'Fortnox', label))
      .toEqual({ provider: 'Fortnox', what: 'leverantörer, leverantörsfakturor' })
  })

  it('says in both languages that the connecting user decides, and the two ways out', () => {
    const svText = (sv.extensions as Record<string, string>)[USER_RIGHT_REFUSAL_MESSAGE_KEY]
    const enText = (en.extensions as Record<string, string>)[USER_RIGHT_REFUSAL_MESSAGE_KEY]
    for (const text of [svText, enText]) {
      expect(text).toContain('{provider}')
      expect(text).toContain('{what}')
    }
    expect(svText).toMatch(/användaren som kopplade \{provider\}/)
    expect(svText).toMatch(/redovisningsbyrå/)
    expect(svText).toMatch(/en stund/)
    expect(enText).toMatch(/accounting firm/)
    expect(enText).toMatch(/for a while/)
  })

  it('has every message it can point at in both languages', () => {
    const keys = ['ext_arcim_job_refused', 'ext_arcim_refused_what_part', 'ext_arcim_refused_what_bookkeeping',
      ...(['bokio', 'fortnox'] as const).flatMap(provider => [
      migrationJobErrorMessageKey({ error_code: 'PROVIDER_RESOURCE_FORBIDDEN', provider }),
      ...(['license', 'permission'] as const)
        .flatMap(reason => (['customers', 'suppliers'] as const).map(resource => migrationRefusalMessageKey(resource, reason, provider))),
    ])]
    for (const messages of [sv, en]) {
      const extensions = messages.extensions as Record<string, string>
      for (const key of keys) expect(extensions[key], key).toEqual(expect.any(String))
    }
  })
})

describe('migrationIssueReason', () => {
  const reason = (error_code: string, review: Parameters<typeof migrationIssueReason>[0]['review'] = null) =>
    migrationIssueReason({ error_code, review })

  it('explains the verdicts PH 143, PH 145 and PH 149 stopped on', () => {
    expect(reason('MIGRATION_INVOICE_NUMBER_TAKEN')).toBe('number_taken')
    expect(reason('MIGRATION_SUPPLIER_INVOICE_NUMBER_MISSING')).toBe('number_missing')
    // Records refused before the named code existed carry the bare SQLSTATE.
    expect(reason('23502')).toBe('missing_value')
    expect(reason('MIGRATION_SOURCE_LINES_MISSING')).toBe('lines_missing')
    expect(reason('MIGRATION_REGISTRATION_REVIEW', { kind: 'registration', outcome: 'amountMismatch' })).toBe('registration_amount')
    expect(reason('MIGRATION_REGISTRATION_REVIEW', { kind: 'registration', outcome: 'ambiguous' })).toBe('registration_ambiguous')
    // Reviewed before the review detail was stored.
    expect(reason('MIGRATION_REGISTRATION_REVIEW')).toBe('registration_review')
  })

  it('groups the other codes the worker and its RPCs store', () => {
    expect(reason('23505')).toBe('number_taken')
    expect(reason('23514')).toBe('invalid_value')
    expect(reason('MIGRATION_INVOICE_AMBIGUOUS')).toBe('ambiguous_match')
    expect(reason('MIGRATION_PARTY_AMBIGUOUS')).toBe('party_ambiguous')
    expect(reason('MIGRATION_PARTY_CHANGED')).toBe('party_changed')
    expect(reason('MIGRATION_SOURCE_ID_MISSING')).toBe('source_id_missing')
    expect(reason('MIGRATION_INVOICE_CHANGED')).toBe('changed')
    expect(reason('MIGRATION_ROWS_MISMATCH')).toBe('rows_mismatch')
    expect(reason('MIGRATION_INVOICE_TOO_LARGE')).toBe('too_large')
    expect(reason('MIGRATION_DETAIL_RETRY')).toBe('temporary')
    expect(reason('40001')).toBe('temporary')
    expect(reason('MIGRATION_VOUCHER_UNAVAILABLE')).toBe('voucher_unavailable')
    expect(reason('MIGRATION_PAYMENT_REVIEW', { kind: 'payment', reason: 'multiple_candidates' })).toBe('payment_review')
    expect(reason('MIGRATION_PAYMENT_AMBIGUOUS')).toBe('payment_review')
    expect(reason('BOKIO_SOURCE_IDENTITY_MISMATCH')).toBe('source_check')
    expect(reason('MIGRATION_BOKIO_COMPLETION_REJECTED')).toBe('source_check')
    expect(reason('PROVIDER_AUTH_EXPIRED')).toBe('connection')
    expect(reason('P0001')).toBe('unknown')
  })

  it('has a Swedish and an English sentence for every reason', () => {
    const codes = ['MIGRATION_INVOICE_NUMBER_TAKEN', 'MIGRATION_SUPPLIER_INVOICE_NUMBER_MISSING', '23502', '23514',
      'MIGRATION_INVOICE_AMBIGUOUS', 'MIGRATION_PARTY_AMBIGUOUS', 'MIGRATION_PARTY_CHANGED', 'MIGRATION_SOURCE_ID_MISSING',
      'MIGRATION_INVOICE_CHANGED', 'MIGRATION_ROWS_MISMATCH', 'MIGRATION_SOURCE_LINES_MISSING', 'MIGRATION_INVOICE_TOO_LARGE',
      'MIGRATION_DETAIL_RETRY', 'MIGRATION_REGISTRATION_AMBIGUOUS', 'MIGRATION_REGISTRATION_REVIEW',
      'MIGRATION_VOUCHER_UNAVAILABLE', 'MIGRATION_PAYMENT_REVIEW', 'BOKIO_X', 'PROVIDER_AUTH_EXPIRED', 'P0001']
    const reasons = new Set([...codes.map(code => reason(code)),
      reason('MIGRATION_REGISTRATION_REVIEW', { kind: 'registration', outcome: 'amountMismatch' })])
    for (const messages of [sv, en]) {
      for (const r of reasons) expect(messages.extensions[`ext_arcim_review_reason_${r}`], r).toEqual(expect.any(String))
    }
  })
})

describe('isTransientIssueCode', () => {
  it('treats only passing failures as retryable on their own', () => {
    expect(isTransientIssueCode('MIGRATION_DETAIL_RETRY')).toBe(true)
    expect(isTransientIssueCode('40P01')).toBe(true)
    expect(isTransientIssueCode('MIGRATION_INVOICE_NUMBER_TAKEN')).toBe(false)
    expect(isTransientIssueCode('23502')).toBe(false)
    expect(isTransientIssueCode(null)).toBe(false)
  })
})

describe('migrationIssueHref', () => {
  const id = '0b7f4f43-3a0a-4d0e-9d57-1f6c6a1f0e11'

  it('opens a record that reached Accounted on its own page', () => {
    expect(migrationIssueHref({ resource: 'salesInvoices', target_id: id })).toBe(`/invoices/${id}`)
    expect(migrationIssueHref({ resource: 'supplierInvoices', target_id: id })).toBe(`/supplier-invoices/${id}`)
    expect(migrationIssueHref({ resource: 'customers', target_id: id })).toBe(`/customers/${id}`)
    expect(migrationIssueHref({ resource: 'suppliers', target_id: id })).toBe(`/suppliers/${id}`)
  })

  it('has nothing to open for a record that was never imported', () => {
    for (const resource of MIGRATION_RESOURCES) expect(migrationIssueHref({ resource, target_id: null })).toBeNull()
  })

  it('has the texts the review names such a record with, in both languages', () => {
    for (const messages of [sv, en]) {
      for (const key of ['ext_arcim_review_open_record', 'ext_arcim_review_record_unnamed', 'ext_arcim_review_record_source_id'] as const) {
        expect(messages.extensions[key], key).toEqual(expect.any(String))
      }
    }
  })
})

// crm#1516: a supplier register that came back empty showed no line at all,
// so it read the same as one never asked for.
describe('emptyMigrationRegisters', () => {
  it('names a requested register with no records, and none that was counted', () => {
    expect(emptyMigrationRegisters(
      { resources: ['customers', 'suppliers', 'supplierInvoices'] },
      [{ resource: 'customers' }, { resource: 'supplierInvoices' }],
    )).toEqual(['suppliers'])
  })

  it('leaves out a register never asked for', () => {
    expect(emptyMigrationRegisters({ resources: ['customers'] }, [])).toEqual(['customers'])
  })

  it('leaves out a refused register: its refusal names it with the remedy', () => {
    expect(emptyMigrationRegisters(
      { resources: ['customers', 'suppliers'], refused_resources: { suppliers: 'permission' } },
      [],
    )).toEqual(['customers'])
  })

  it('has its line in both languages, with the provider and the register', () => {
    for (const messages of [sv, en]) {
      const ext = messages.extensions as Record<string, string>
      expect(ext.ext_arcim_register_empty_value).toEqual(expect.any(String))
      expect(ext.ext_arcim_register_empty_detail).toContain('{provider}')
      expect(ext.ext_arcim_register_empty_detail).toContain('{what}')
    }
  })
})
