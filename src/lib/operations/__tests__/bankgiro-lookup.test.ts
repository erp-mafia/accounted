/**
 * The Bankgiro Lookup operations (../bankgiro-lookup.ts): the doors' shapes,
 * and the service's answers flattened for a client that cached the schema.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/payments/bankgiro-lookup', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/payments/bankgiro-lookup')>()),
  lookupCreditorName: vi.fn(),
  lookupCompanyGiroNumbers: vi.fn(),
}))

import { lookupCompanyGiroNumbers, lookupCreditorName } from '@/lib/payments/bankgiro-lookup'
import type { OperationContext } from '@/lib/operations/types'
import {
  companyGiroNumbersToOutput,
  creditorLookupToOutput,
  paymentsCompanyGiroNumbers,
  paymentsLookupCreditor,
} from '../bankgiro-lookup'
import { ALL_OPERATIONS } from '../registry'

const creditor = vi.mocked(lookupCreditorName)
const giros = vi.mocked(lookupCompanyGiroNumbers)

const ctx = { supabase: {}, companyId: 'c0000000-0000-4000-8000-000000000001', userId: 'user-1', log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } } as unknown as OperationContext

beforeEach(() => vi.clearAllMocks())

describe('operation shapes', () => {
  it('are registered reads under GET /payments/* with search-only MCP tools', () => {
    expect(ALL_OPERATIONS).toContain(paymentsLookupCreditor)
    expect(ALL_OPERATIONS).toContain(paymentsCompanyGiroNumbers)
    expect(paymentsLookupCreditor.id).toBe('payments.lookup-creditor')
    expect(paymentsLookupCreditor.kind).toBe('read')
    expect(paymentsLookupCreditor.scope).toBe('suppliers:read')
    expect(paymentsLookupCreditor.http).toEqual({ method: 'GET', path: '/api/v1/companies/:companyId/payments/creditor-lookup' })
    expect(paymentsLookupCreditor.mcp?.name).toBe('gnubok_lookup_bankgiro_creditor')
    expect(paymentsLookupCreditor.mcp?.visibility).toBe('search')

    expect(paymentsCompanyGiroNumbers.id).toBe('payments.company-giro-numbers')
    expect(paymentsCompanyGiroNumbers.kind).toBe('read')
    expect(paymentsCompanyGiroNumbers.scope).toBe('companies:read')
    expect(paymentsCompanyGiroNumbers.http).toEqual({ method: 'GET', path: '/api/v1/companies/:companyId/payments/giro-numbers' })
    expect(paymentsCompanyGiroNumbers.mcp?.name).toBe('gnubok_list_company_giro_numbers')
    expect(paymentsCompanyGiroNumbers.mcp?.visibility).toBe('search')
  })

  it('takes the giro, its type and an optional OCR or invoice reference; refuses a short giro and an unknown type', () => {
    const input = paymentsLookupCreditor.input
    expect(input.safeParse({ giro: '5050-1055', type: 'bankgiro' }).success).toBe(true)
    expect(input.safeParse({ giro: '5050-1055', type: 'plusgiro', ocr: '4400112233' }).success).toBe(true)
    expect(input.safeParse({ giro: '5050-1055', type: 'bankgiro', invoice_ref: 'INV-1' }).success).toBe(true)
    expect(input.safeParse({ giro: '1234', type: 'bankgiro' }).success).toBe(false)
    expect(input.safeParse({ giro: '5050-1055', type: 'iban' }).success).toBe(false)
    expect(input.safeParse({ type: 'bankgiro' }).success).toBe(false)
  })
})

describe('creditorLookupToOutput', () => {
  it('flattens the three answers into one object shape', () => {
    expect(creditorLookupToOutput({ enabled: false })).toEqual({ enabled: false, available: false, reason: null, creditor_name: null, ocr_valid: null, warnings: [] })
    expect(creditorLookupToOutput({ enabled: true, available: false, reason: 'not_found' })).toEqual({
      enabled: true,
      available: false,
      reason: 'not_found',
      creditor_name: null,
      ocr_valid: null,
      warnings: [],
    })
    const found = creditorLookupToOutput({
      enabled: true,
      available: true,
      creditorName: 'Derome Bygg AB',
      ocrValid: false,
      warnings: [{ code: 'OCR_REF_INVALID', text: null }],
    })
    expect(found).toEqual({ enabled: true, available: true, reason: null, creditor_name: 'Derome Bygg AB', ocr_valid: false, warnings: [{ code: 'OCR_REF_INVALID', text: null }] })
    expect(paymentsLookupCreditor.output.safeParse(found).success).toBe(true)
  })
})

describe('payments.lookup-creditor run', () => {
  it('hands the input to the service and answers its output', async () => {
    creditor.mockResolvedValue({ enabled: true, available: true, creditorName: 'Derome Bygg AB', ocrValid: true, warnings: [] })
    const outcome = await paymentsLookupCreditor.run(ctx, { giro: '5050-1055', type: 'bankgiro', ocr: '4400112233', invoice_ref: undefined }, { dryRun: false })
    expect(outcome).toEqual({
      ok: true,
      data: { enabled: true, available: true, reason: null, creditor_name: 'Derome Bygg AB', ocr_valid: true, warnings: [] },
    })
    expect(creditor).toHaveBeenCalledWith(ctx, { giro: '5050-1055', type: 'bankgiro', ocr: '4400112233', invoiceRef: null })
  })

  it('answers enabled false as a success, never an error, when the flag is off', async () => {
    creditor.mockResolvedValue({ enabled: false })
    const outcome = await paymentsLookupCreditor.run(ctx, { giro: '5050-1055', type: 'bankgiro', ocr: undefined, invoice_ref: undefined }, { dryRun: false })
    expect(outcome.ok).toBe(true)
    expect(outcome.ok && !outcome.dryRun && outcome.data.enabled).toBe(false)
  })
})

describe('payments.company-giro-numbers run', () => {
  it('answers the registered numbers, and a flat shape when there is nothing', async () => {
    giros.mockResolvedValue({ enabled: true, available: true, giroNumbers: [{ number: '5050-1055', type: 'bankgiro', name: 'Derome Bygg AB' }] })
    const outcome = await paymentsCompanyGiroNumbers.run(ctx, {}, { dryRun: false })
    expect(outcome).toEqual({ ok: true, data: { enabled: true, available: true, reason: null, giro_numbers: [{ number: '5050-1055', type: 'bankgiro', name: 'Derome Bygg AB' }] } })
    expect(companyGiroNumbersToOutput({ enabled: false })).toEqual({ enabled: false, available: false, reason: null, giro_numbers: [] })
    expect(companyGiroNumbersToOutput({ enabled: true, available: false, reason: 'premium_not_enabled' })).toEqual({
      enabled: true,
      available: false,
      reason: 'premium_not_enabled',
      giro_numbers: [],
    })
  })
})
