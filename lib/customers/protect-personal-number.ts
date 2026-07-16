import { decryptPersonnummer, encryptPersonnummer } from '@/lib/salary/personnummer'
import { maskCustomerPersonalNumber } from '@/lib/customers/mask-personal-number'

export function encryptCustomerPersonalNumber(value: string | null | undefined): string | null {
  return value ? encryptPersonnummer(value) : null
}

export function maskStoredCustomerPersonalNumber(value: string | null | undefined): string | null {
  if (!value) return null
  if (/^(\d{6}|\d{8})[-+]?\d{4}$/.test(value)) {
    return maskCustomerPersonalNumber(value)
  }
  return maskCustomerPersonalNumber(decryptPersonnummer(value))
}

export function maskCustomerRow<T extends { personal_number?: string | null }>(row: T): T {
  return {
    ...row,
    personal_number: maskStoredCustomerPersonalNumber(row.personal_number),
  }
}
