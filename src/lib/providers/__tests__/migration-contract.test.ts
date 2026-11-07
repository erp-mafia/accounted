import { describe, expect, it } from 'vitest'
import { migrationIssueKind } from '../migration-contract'

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
    expect(migrationIssueKind('40001')).toBe('retry')
    expect(migrationIssueKind(null)).toBe('retry')
  })
})


it('distinguishes missing encryption configuration from a retryable error', () => {
  expect(migrationIssueKind('PERSONNUMMER_ENCRYPTION_NOT_CONFIGURED')).toBe('configuration')
})

it('distinguishes registration review from payment review on already imported invoices', () => {
  expect(migrationIssueKind('MIGRATION_REGISTRATION_REVIEW')).toBe('registration')
  expect(migrationIssueKind('MIGRATION_PAYMENT_REVIEW')).toBe('payment')
})

it('describes an overdue open balance separately from an uncertain payment match', () => {
  expect(migrationIssueKind('MIGRATION_UNPAID_OVERDUE')).toBe('overdue')
})
