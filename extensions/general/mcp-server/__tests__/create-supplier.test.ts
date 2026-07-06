/**
 * Unit tests for gnubok_create_supplier: registration, risk tier, and
 * input validation (ASVS V2.3, V4.5; ISO A.8.28; CC6.3).
 *
 * The financial identifier checks here guard against the supplier-fraud /
 * BEC risk surface flagged in the PR compliance review: malformed IBAN,
 * BIC, bankgiro, org_number, or VAT number must be rejected before the
 * operation is staged, and an explicit default_payment_terms of 0 must
 * NOT be silently rewritten to 30 days.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { tools } from '../server'
import { TOOL_SCOPE_MAP } from '@/lib/auth/api-keys'
import { OPERATION_RISK_TIERS } from '@/lib/pending-operations/risk-tiers'

vi.mock('@/lib/currency/riksbanken', () => ({
  fetchExchangeRate: vi.fn().mockResolvedValue(11.5),
  convertToSEK: vi.fn(),
}))

const tool = () => tools.find((t) => t.name === 'gnubok_create_supplier')!

describe('gnubok_create_supplier: registration', () => {
  it('is registered with idempotent + non-read-only annotations', () => {
    expect(tool()).toBeDefined()
    expect(tool().annotations.readOnlyHint).toBe(false)
    expect(tool().annotations.idempotentHint).toBe(true)
    expect(tool().annotations.destructiveHint).toBe(false)
  })

  it('declares additionalProperties: false on its inputSchema', () => {
    const schema = tool().inputSchema as { additionalProperties?: boolean }
    expect(schema.additionalProperties).toBe(false)
  })

  it('only requires `name`', () => {
    const schema = tool().inputSchema as { required?: string[] }
    expect(schema.required).toEqual(['name'])
  })

  it('is mapped to suppliers:write scope', () => {
    expect(TOOL_SCOPE_MAP.gnubok_create_supplier).toBe('suppliers:write')
  })

  it('is classified as medium risk (carries payment-routing fields)', () => {
    expect(OPERATION_RISK_TIERS.create_supplier).toBe('medium')
  })

  it('inputSchema constrains name maxLength and supplier_type enum', () => {
    const props = (tool().inputSchema as { properties: Record<string, { maxLength?: number; enum?: string[] }> }).properties
    expect(props.name.maxLength).toBe(255)
    expect(props.supplier_type.enum).toEqual(['swedish_business', 'eu_business', 'non_eu_business'])
  })
})

/**
 * Validation tests below exercise the Zod schema via tool.execute(). All
 * inputs are rejected before any supabase call, so we pass an inert stub.
 */
const noopSupabase = {
  from: vi.fn(() => ({
    insert: vi.fn(() => ({ select: vi.fn(() => ({ single: vi.fn() })) })),
  })),
} as never

describe('gnubok_create_supplier: input validation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('rejects empty name', async () => {
    await expect(
      tool().execute({ name: '   ' }, 'company-1', 'user-1', noopSupabase),
    ).rejects.toThrow(/name/i)
  })

  it('rejects name longer than 255 chars', async () => {
    await expect(
      tool().execute({ name: 'A'.repeat(256) }, 'company-1', 'user-1', noopSupabase),
    ).rejects.toThrow(/name/i)
  })

  it('rejects malformed IBAN', async () => {
    await expect(
      tool().execute({ name: 'Acme', iban: 'NOT-AN-IBAN' }, 'company-1', 'user-1', noopSupabase),
    ).rejects.toThrow(/iban/i)
  })

  it('rejects malformed BIC', async () => {
    await expect(
      tool().execute({ name: 'Acme', bic: 'abc' }, 'company-1', 'user-1', noopSupabase),
    ).rejects.toThrow(/bic/i)
  })

  it('rejects bankgiro with invalid Luhn check digit', async () => {
    await expect(
      tool().execute({ name: 'Acme', bankgiro: '1234567' }, 'company-1', 'user-1', noopSupabase),
    ).rejects.toThrow(/bankgiro/i)
  })

  it('rejects malformed Swedish org_number', async () => {
    await expect(
      tool().execute({ name: 'Acme', org_number: '12345' }, 'company-1', 'user-1', noopSupabase),
    ).rejects.toThrow(/org_number/i)
  })

  it('rejects malformed EU VAT number', async () => {
    await expect(
      tool().execute({ name: 'Acme', vat_number: 'XX123' }, 'company-1', 'user-1', noopSupabase),
    ).rejects.toThrow(/vat_number/i)
  })

  it('rejects default_expense_account outside BAS class 4-7', async () => {
    await expect(
      tool().execute({ name: 'Acme', default_expense_account: '1930' }, 'company-1', 'user-1', noopSupabase),
    ).rejects.toThrow(/default_expense_account/i)
  })

  it('rejects default_payment_terms over 365', async () => {
    await expect(
      tool().execute({ name: 'Acme', default_payment_terms: 999 }, 'company-1', 'user-1', noopSupabase),
    ).rejects.toThrow(/default_payment_terms/i)
  })

  it('requires vat_number when supplier_type is eu_business', async () => {
    await expect(
      tool().execute({ name: 'Acme GmbH', supplier_type: 'eu_business' }, 'company-1', 'user-1', noopSupabase),
    ).rejects.toThrow(/vat_number/i)
  })
})

/**
 * The remaining cases verify the *happy path* doesn't accidentally drop or
 * mutate caller intent. We use dry_run so no DB write is attempted; the
 * staging helper still receives the validated params.
 */
describe('gnubok_create_supplier: staging behaviour', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('preserves default_payment_terms=0 (due-on-receipt)', async () => {
    const result = await tool().execute(
      { name: 'SameDay AB', default_payment_terms: 0, dry_run: true },
      'company-1',
      'user-1',
      noopSupabase,
    ) as { preview?: { default_payment_terms?: number }; dry_run?: boolean }
    expect(result.dry_run).toBe(true)
    expect(result.preview?.default_payment_terms).toBe(0)
  })

  it('defaults missing default_payment_terms to 30', async () => {
    const result = await tool().execute(
      { name: 'Acme AB', dry_run: true },
      'company-1',
      'user-1',
      noopSupabase,
    ) as { preview?: { default_payment_terms?: number } }
    expect(result.preview?.default_payment_terms).toBe(30)
  })

  it('defaults supplier_type to swedish_business', async () => {
    const result = await tool().execute(
      { name: 'Acme AB', dry_run: true },
      'company-1',
      'user-1',
      noopSupabase,
    ) as { preview?: { supplier_type?: string } }
    expect(result.preview?.supplier_type).toBe('swedish_business')
  })

  it('accepts a valid IBAN + BIC + bankgiro', async () => {
    const result = await tool().execute(
      {
        name: 'Acme AB',
        iban: 'SE3550000000054910000003',
        bic: 'NDEASESS',
        bankgiro: '5050-1055',
        dry_run: true,
      },
      'company-1',
      'user-1',
      noopSupabase,
    ) as { preview?: { iban?: string; bic?: string; bankgiro?: string }; dry_run?: boolean }
    expect(result.dry_run).toBe(true)
    expect(result.preview?.iban).toBe('SE3550000000054910000003')
    expect(result.preview?.bic).toBe('NDEASESS')
    expect(result.preview?.bankgiro).toBe('5050-1055')
  })
})
