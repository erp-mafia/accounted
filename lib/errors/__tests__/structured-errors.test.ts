import { describe, it, expect } from 'vitest'
import { ZodError, z } from 'zod'
import {
  errorResponse,
  errorResponseFromCode,
  type ErrorEnvelope,
} from '../get-structured-error'
import { getErrorEntry, listErrorCodes } from '../structured-errors'
import {
  AccountsNotInChartError,
  EntryDateOutsideFiscalPeriodError,
  JournalEntryNotBalancedError,
} from '@/lib/bookkeeping/errors'

const noopLogger = {
  error: () => {},
}

async function readEnvelope(res: Response): Promise<ErrorEnvelope> {
  return (await res.json()) as ErrorEnvelope
}

describe('structured-errors registry', () => {
  it('has entries for the canonical generic codes', () => {
    for (const code of [
      'INTERNAL_ERROR',
      'VALIDATION_ERROR',
      'UNAUTHORIZED',
      'FORBIDDEN',
      'NOT_FOUND',
      'CONFLICT',
      'RATE_LIMITED',
      'COMPANY_CONTEXT_MISSING',
    ]) {
      const entry = getErrorEntry(code)
      expect(entry, `missing entry for ${code}`).toBeDefined()
      expect(entry?.message_sv).toBeTruthy()
      expect(entry?.message_en).toBeTruthy()
    }
  })

  it('has an entry for every code the link-transaction service can emit', () => {
    for (const code of [
      'LINK_TX_JE_NOT_FOUND',
      'LINK_TX_JE_NOT_POSTED',
      'LINK_TX_TX_ALREADY_LINKED',
      'LINK_TX_INVOICE_NOT_FOUND',
      'LINK_TX_INVOICE_NOT_OPEN',
      'LINK_TX_INVOICE_CREDIT_NOTE',
      'LINK_TX_INVOICE_RACE',
      'LINK_TX_INVOICE_CURRENCY_MISMATCH',
      'LINK_TX_DB_ERROR',
    ]) {
      const entry = getErrorEntry(code)
      expect(entry, `missing entry for ${code}`).toBeDefined()
      expect(entry?.message_sv).toBeTruthy()
      expect(entry?.message_en).toBeTruthy()
    }
  })

  it('registers PERSONNUMMER_ENCRYPTION_NOT_CONFIGURED as a 503 configuration gap (#1996)', () => {
    const entry = getErrorEntry('PERSONNUMMER_ENCRYPTION_NOT_CONFIGURED')
    expect(entry).toBeDefined()
    expect(entry?.httpStatus).toBe(503)
    expect(entry?.message_sv).toContain('PERSONNUMMER_ENCRYPTION_KEY')
    expect(entry?.message_sv).toMatch(/Kontakta supporten/)
    expect(entry?.message_en).toContain('PERSONNUMMER_ENCRYPTION_KEY')
    expect(entry?.remediation?.description).toContain('PERSONNUMMER_ENCRYPTION_KEY')
    // Retrying without the variable fails identically: never mark it transient.
    expect(entry?.retryable).toBeFalsy()
  })

  it('listErrorCodes returns at least the bookkeeping + generic + provider codes', () => {
    const codes = listErrorCodes()
    expect(codes.length).toBeGreaterThan(20)
    expect(codes).toContain('JOURNAL_ENTRY_NOT_BALANCED')
    expect(codes).toContain('PROVIDER_AUTH_EXPIRED')
    expect(codes).toContain('BOKIO_COMPANY_NOT_FOUND')
    expect(codes).toContain('CANNOT_EDIT_NON_DRAFT')
    expect(codes).toContain('MANDATORY_DIMENSION_MISSING')
    // Node network system codes registered as retryable transients (#337).
    expect(codes).toContain('ECONNREFUSED')
    expect(getErrorEntry('ECONNREFUSED')?.retryable).toBe(true)
  })
})

describe('errorResponse', () => {
  it('maps a plain Error carrying a registry code to that code, status and requestId', async () => {
    // The shape lib/salary/personnummer.ts throws when the key is unset in
    // production: an Error with a `code` own-property, no class hierarchy.
    const err = Object.assign(new Error('PERSONNUMMER_ENCRYPTION_KEY is required in production'), {
      code: 'PERSONNUMMER_ENCRYPTION_NOT_CONFIGURED',
    })
    const res = errorResponse(err, noopLogger, { requestId: 'req_1996' })
    expect(res.status).toBe(503)
    expect(res.headers.get('X-Request-Id')).toBe('req_1996')
    const body = await readEnvelope(res)
    expect(body.error.code).toBe('PERSONNUMMER_ENCRYPTION_NOT_CONFIGURED')
    expect(body.error.message).toMatch(/PERSONNUMMER_ENCRYPTION_KEY/)
    expect(body.error.requestId).toBe('req_1996')
    // The raw English Error.message must not replace the registry message.
    expect(body.error.message).not.toBe(err.message)
  })

  it('maps BookkeepingError to its code + structured details + Swedish message', async () => {
    const err = new JournalEntryNotBalancedError(100, 90)
    const res = errorResponse(err, noopLogger, { requestId: 'req_1' })
    expect(res.status).toBe(400)
    expect(res.headers.get('X-Request-Id')).toBe('req_1')
    const body = await readEnvelope(res)
    expect(body.error.code).toBe('JOURNAL_ENTRY_NOT_BALANCED')
    expect(body.error.message).toMatch(/balanserar inte/i)
    expect(body.error.requestId).toBe('req_1')
    expect(body.error.details).toMatchObject({ totalDebit: 100, totalCredit: 90 })
  })

  it('preserves AccountsNotInChartError details', async () => {
    const err = new AccountsNotInChartError(['1930', '2641'])
    const res = errorResponse(err, noopLogger, { requestId: 'req_2' })
    const body = await readEnvelope(res)
    expect(body.error.code).toBe('ACCOUNTS_NOT_IN_CHART')
    expect(body.error.details).toMatchObject({ account_numbers: ['1930', '2641'] })
  })

  it('maps ZodError to VALIDATION_ERROR with field issues', async () => {
    let zodErr: ZodError
    try {
      z.object({ name: z.string().min(1) }).parse({ name: '' })
      throw new Error('should have thrown')
    } catch (e) {
      zodErr = e as ZodError
    }
    const res = errorResponse(zodErr, noopLogger, { requestId: 'req_3' })
    expect(res.status).toBe(400)
    const body = await readEnvelope(res)
    expect(body.error.code).toBe('VALIDATION_ERROR')
    expect(body.error.details).toMatchObject({
      issues: expect.arrayContaining([
        expect.objectContaining({ field: 'name' }),
      ]),
    })
  })

  it('maps Postgres unique violation to VALIDATION_ERROR with pgCode', async () => {
    const pgErr = Object.assign(new Error('duplicate key'), { code: '23505' })
    const res = errorResponse(pgErr, noopLogger, { requestId: 'req_4' })
    expect(res.status).toBe(400)
    const body = await readEnvelope(res)
    expect(body.error.code).toBe('VALIDATION_ERROR')
    expect(body.error.details).toMatchObject({ pgCode: '23505' })
  })

  it('maps the ignored-transaction journal constraint to a typed conflict', async () => {
    const pgErr = Object.assign(
      new Error(
        'new row for relation "transactions" violates check constraint "transactions_is_ignored_no_journal_entry"',
      ),
      { code: '23514' },
    )
    const res = errorResponse(pgErr, noopLogger, { requestId: 'req_ignored_tx' })

    expect(res.status).toBe(409)
    const body = await readEnvelope(res)
    expect(body.error.code).toBe('TX_CATEGORIZE_IGNORED_CONFLICT')
    expect(body.error.message).not.toContain('check constraint')
    expect(body.error.details).toMatchObject({ pgCode: '23514' })
  })

  it('does not apply unrelated message heuristics to Postgres errors', async () => {
    const pgErr = Object.assign(new Error('Invoice not found'), { code: 'P0001' })
    const res = errorResponse(pgErr, noopLogger, { requestId: 'req_pg_unrelated' })

    expect(res.status).toBe(500)
    const body = await readEnvelope(res)
    expect(body.error.code).toBe('INTERNAL_ERROR')
  })

  it('maps Postgres no-data-found to NOT_FOUND with pgCode', async () => {
    const pgErr = Object.assign(new Error('invoice not found'), { code: 'P0002' })
    const res = errorResponse(pgErr, noopLogger, { requestId: 'req_pg_not_found' })
    expect(res.status).toBe(404)
    const body = await readEnvelope(res)
    expect(body.error.code).toBe('NOT_FOUND')
    expect(body.error.details).toMatchObject({ pgCode: 'P0002' })
  })

  it('falls back to INTERNAL_ERROR for unknown shapes', async () => {
    const res = errorResponse(new Error('boom'), noopLogger, { requestId: 'req_5' })
    expect(res.status).toBe(500)
    const body = await readEnvelope(res)
    expect(body.error.code).toBe('INTERNAL_ERROR')
    expect(body.error.requestId).toBe('req_5')
  })

  it('passes through entries with remediation hints', async () => {
    const res = errorResponseFromCode('PROVIDER_AUTH_EXPIRED', noopLogger, { requestId: 'req_6' })
    const body = await readEnvelope(res)
    expect(body.error.code).toBe('PROVIDER_AUTH_EXPIRED')
    expect(res.status).toBe(401)
  })

  it('errorResponseFromCode emits requestId in header', () => {
    const res = errorResponseFromCode('NOT_FOUND', noopLogger, { requestId: 'req_7' })
    expect(res.headers.get('X-Request-Id')).toBe('req_7')
  })

  it('preserves EntryDateOutsideFiscalPeriodError fields', async () => {
    const err = new EntryDateOutsideFiscalPeriodError(
      '2026-01-01',
      'FY2025',
      '2025-01-01',
      '2025-12-31',
    )
    const body = await readEnvelope(errorResponse(err, noopLogger, { requestId: 'req_8' }))
    expect(body.error.code).toBe('ENTRY_DATE_OUTSIDE_FISCAL_PERIOD')
    expect(body.error.details).toMatchObject({
      entryDate: '2026-01-01',
      periodName: 'FY2025',
      periodStart: '2025-01-01',
      periodEnd: '2025-12-31',
    })
  })
})
