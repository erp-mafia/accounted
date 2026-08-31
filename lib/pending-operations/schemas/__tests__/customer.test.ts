import { describe, it, expect } from 'vitest'
import { encryptPersonnummer } from '@/lib/salary/personnummer'
import { UpdateCustomerParamsSchema } from '../customer'

const CUSTOMER_ID = '11111111-1111-4111-8111-111111111111'

const wrap = (changes: Record<string, unknown>) => ({
  customer_id: CUSTOMER_ID,
  changes,
})

// Synthetic personnummer, never a real one.
const PERSONAL_NUMBER = '19900101-1234'

describe('UpdateCustomerParamsSchema: personal_number_encrypted (#1876)', () => {
  it('accepts AES-256-GCM ciphertext', () => {
    const encrypted = encryptPersonnummer(PERSONAL_NUMBER)
    const parsed = UpdateCustomerParamsSchema.parse(
      wrap({ personal_number_encrypted: encrypted }),
    )
    expect(parsed.changes.personal_number_encrypted).toBe(encrypted)
  })

  it('accepts explicit null (clears the stored value at commit)', () => {
    const parsed = UpdateCustomerParamsSchema.parse(
      wrap({ personal_number_encrypted: null }),
    )
    expect(parsed.changes.personal_number_encrypted).toBeNull()
  })

  it('rejects a plaintext personnummer under personal_number_encrypted', () => {
    expect(() =>
      UpdateCustomerParamsSchema.parse(wrap({ personal_number_encrypted: PERSONAL_NUMBER })),
    ).toThrow(/encrypted personal number/i)
  })

  it('rejects the plaintext personal_number key (strict schema)', () => {
    expect(() =>
      UpdateCustomerParamsSchema.parse(wrap({ personal_number: PERSONAL_NUMBER })),
    ).toThrow(/unrecognized key/i)
  })

  it('still rejects unknown fields', () => {
    expect(() =>
      UpdateCustomerParamsSchema.parse(wrap({ company_id: 'other-company' })),
    ).toThrow(/unrecognized key/i)
  })

  it('still requires at least one changed field', () => {
    expect(() => UpdateCustomerParamsSchema.parse(wrap({}))).toThrow(/at least one/i)
  })
})
