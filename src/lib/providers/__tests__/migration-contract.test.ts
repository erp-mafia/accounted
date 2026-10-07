import { describe, expect, it } from 'vitest'
import { isTransientIssueCode, migrationIssueKind, migrationIssueReason } from '../migration-contract'
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
    expect(migrationIssueKind('40001')).toBe('retry')
    expect(migrationIssueKind(null)).toBe('retry')
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
