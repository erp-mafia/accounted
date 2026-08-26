import { describe, expect, it } from 'vitest'
import { luhnCheckDigit } from '@/lib/bankgiro/luhn'
import {
  formatPayeeLabel,
  resolvePaymentReference,
  resolveSupplierPayee,
} from '@/lib/payments/supplier-payee'

// Luhn-valid fixtures built from the same check-digit routine the validators use.
const VALID_BG = '5050-1055' // Skatteverket's bankgiro; known Luhn-valid
const VALID_PG = `123456${luhnCheckDigit('123456')}`
const VALID_OCR = `1234567${luhnCheckDigit('1234567')}`

const emptySource = {
  bankgiro: null,
  plusgiro: null,
  bank_account: null,
  clearing_number: null,
  account_number: null,
}

describe('resolveSupplierPayee', () => {
  it('resolves a valid bankgiro first', () => {
    const result = resolveSupplierPayee({
      ...emptySource,
      bankgiro: VALID_BG,
      plusgiro: VALID_PG,
      clearing_number: '3300',
      account_number: '1234567',
    })
    expect(result).toEqual({ ok: true, payee: { type: 'bankgiro', bankgiro: '50501055' } })
  })

  it('fails on an invalid bankgiro instead of falling through to plusgiro', () => {
    const result = resolveSupplierPayee({
      ...emptySource,
      bankgiro: '1234-5678',
      plusgiro: VALID_PG,
    })
    expect(result).toEqual({ ok: false, reason: 'payee_invalid' })
  })

  it('resolves plusgiro when no bankgiro is set', () => {
    const result = resolveSupplierPayee({ ...emptySource, plusgiro: VALID_PG })
    expect(result).toEqual({ ok: true, payee: { type: 'plusgiro', plusgiro: VALID_PG } })
  })

  it('resolves structured clearing + account columns', () => {
    const result = resolveSupplierPayee({
      ...emptySource,
      clearing_number: '3300',
      account_number: '000123456',
    })
    expect(result).toEqual({
      ok: true,
      payee: { type: 'bank_account', clearing: '3300', account: '000123456' },
    })
  })

  it('rejects an invalid clearing in the structured columns', () => {
    const result = resolveSupplierPayee({
      ...emptySource,
      clearing_number: '12',
      account_number: '1234567',
    })
    expect(result).toEqual({ ok: false, reason: 'payee_invalid' })
  })

  it('parses free-text bank_account with an explicit separator', () => {
    const result = resolveSupplierPayee({ ...emptySource, bank_account: '3300-123 456 789' })
    expect(result).toEqual({
      ok: true,
      payee: { type: 'bank_account', clearing: '3300', account: '123456789' },
    })
  })

  it('accepts a 5-digit Swedbank clearing in free text', () => {
    const result = resolveSupplierPayee({ ...emptySource, bank_account: '83279 123456789' })
    expect(result).toEqual({
      ok: true,
      payee: { type: 'bank_account', clearing: '83279', account: '123456789' },
    })
  })

  it('refuses an ambiguous free-text digit blob', () => {
    const result = resolveSupplierPayee({ ...emptySource, bank_account: '83279123456789' })
    expect(result).toEqual({ ok: false, reason: 'payee_invalid' })
  })

  it('reports payee_missing when nothing is set', () => {
    expect(resolveSupplierPayee(emptySource)).toEqual({ ok: false, reason: 'payee_missing' })
  })

  it('treats whitespace-only fields as missing', () => {
    expect(resolveSupplierPayee({ ...emptySource, bankgiro: '  ' })).toEqual({
      ok: false,
      reason: 'payee_missing',
    })
  })
})

describe('formatPayeeLabel', () => {
  it('formats each payee type', () => {
    expect(formatPayeeLabel({ type: 'bankgiro', bankgiro: '50501055' })).toBe('BG 5050-1055')
    expect(formatPayeeLabel({ type: 'plusgiro', plusgiro: '1234567' })).toBe('PG 123456-7')
    expect(formatPayeeLabel({ type: 'bank_account', clearing: '3300', account: '123456789' })).toBe(
      '3300 123456789',
    )
  })
})

describe('resolvePaymentReference', () => {
  it('uses a Luhn-valid OCR as a structured reference', () => {
    const { reference, ocrInvalid } = resolvePaymentReference({
      payment_reference: VALID_OCR,
      supplier_invoice_number: 'F-1001',
    })
    expect(reference).toEqual({ type: 'ocr', value: VALID_OCR })
    expect(ocrInvalid).toBe(false)
  })

  it('strips formatting from the OCR before validating', () => {
    const { reference } = resolvePaymentReference({
      payment_reference: ` ${VALID_OCR.slice(0, 4)} ${VALID_OCR.slice(4)} `,
      supplier_invoice_number: 'F-1001',
    })
    expect(reference).toEqual({ type: 'ocr', value: VALID_OCR })
  })

  it('falls back to the invoice number with a warning on an invalid OCR', () => {
    const { reference, ocrInvalid } = resolvePaymentReference({
      payment_reference: '1234568',
      supplier_invoice_number: 'F-1001',
    })
    expect(reference).toEqual({ type: 'invoice_number', value: 'F-1001' })
    expect(ocrInvalid).toBe(true)
  })

  it('falls back to the invoice number without a warning when no OCR is set', () => {
    const { reference, ocrInvalid } = resolvePaymentReference({
      payment_reference: null,
      supplier_invoice_number: 'F-1001',
    })
    expect(reference).toEqual({ type: 'invoice_number', value: 'F-1001' })
    expect(ocrInvalid).toBe(false)
  })
})
