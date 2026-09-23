import { describe, expect, it, vi } from 'vitest'
import { encryptPersonnummer } from '@/lib/salary/personnummer'
import { maskedDeductionPersonnummer } from '@/lib/invoices/deduction-personnummer'

describe('maskedDeductionPersonnummer', () => {
  it('shows the birth date and hides the last four digits (YYYYMMDD-XXXX)', () => {
    const encrypted = encryptPersonnummer('199001012385')
    expect(maskedDeductionPersonnummer({ deduction_personnummer_encrypted: encrypted })).toBe(
      '19900101-XXXX',
    )
  })

  it('returns null when nothing is stored', () => {
    expect(maskedDeductionPersonnummer({ deduction_personnummer_encrypted: null })).toBeNull()
    expect(maskedDeductionPersonnummer({ deduction_personnummer_encrypted: undefined })).toBeNull()
    expect(maskedDeductionPersonnummer({})).toBeNull()
    expect(maskedDeductionPersonnummer(null)).toBeNull()
    expect(maskedDeductionPersonnummer(undefined)).toBeNull()
  })

  it('returns null and never throws on a ciphertext that cannot be decrypted', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      expect(() =>
        maskedDeductionPersonnummer({ deduction_personnummer_encrypted: 'deadbeef'.repeat(10) }),
      ).not.toThrow()
      expect(
        maskedDeductionPersonnummer({ deduction_personnummer_encrypted: 'deadbeef'.repeat(10) }),
      ).toBeNull()
      // Too short to even carry an IV + auth tag.
      expect(maskedDeductionPersonnummer({ deduction_personnummer_encrypted: 'abc' })).toBeNull()
    } finally {
      errorSpy.mockRestore()
    }
  })

  it('tolerates a legacy plaintext row the same way decryptPersonnummer does', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      expect(
        maskedDeductionPersonnummer({ deduction_personnummer_encrypted: '198507162389' }),
      ).toBe('19850716-XXXX')
    } finally {
      warnSpy.mockRestore()
    }
  })
})
