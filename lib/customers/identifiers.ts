import {
  PERSONAL_NUMBER_PLAINTEXT_RE,
  isMaskedPersonalNumber,
} from '@/lib/customers/mask-personal-number'

export const INDIVIDUAL_CUSTOMER_TYPES = new Set(['individual'])

type CustomerIdentifierInput = {
  customer_type?: string
  org_number?: string | null
  personal_number?: string | null
}

export type CustomerIdentifierError = {
  field: 'org_number' | 'personal_number'
  message: string
}

export type ResolvedCustomerIdentifiers = {
  customerType: string
  orgNumber: string | null | undefined
  personalNumber: string | null | undefined
}

export type CustomerIdentifierResult =
  | { ok: true; data: ResolvedCustomerIdentifiers }
  | { ok: false; error: CustomerIdentifierError }

function comparablePersonalNumber(value: string): string {
  const digits = value.replace(/\D/g, '')
  return digits.length === 12 ? digits.slice(2) : digits
}

export function personalNumbersMatch(left: string, right: string): boolean {
  return comparablePersonalNumber(left) === comparablePersonalNumber(right)
}

/**
 * Resolve the canonical customer identifier fields before a database write.
 *
 * `org_number` remains accepted for individual customers for compatibility
 * with the original v1 contract. It is treated as plaintext personnummer and
 * moved to `personal_number`, which the caller encrypts before persistence.
 * Undefined means "leave unchanged" on update; null means "clear".
 */
export function resolveCustomerIdentifiers(
  input: CustomerIdentifierInput,
  options: { currentCustomerType?: string; create?: boolean } = {},
): CustomerIdentifierResult {
  const customerType = input.customer_type ?? options.currentCustomerType
  if (!customerType) {
    return {
      ok: false,
      error: { field: 'personal_number', message: 'Customer type is required' },
    }
  }

  const isIndividual = INDIVIDUAL_CUSTOMER_TYPES.has(customerType)
  const typeChanged =
    options.currentCustomerType !== undefined && customerType !== options.currentCustomerType
  const orgWasSubmitted = input.org_number !== undefined
  const personalWasSubmitted = input.personal_number !== undefined
  const submittedPersonalIsMask = isMaskedPersonalNumber(input.personal_number)
  const legacyPersonalNumber = input.org_number?.trim() || null
  const explicitPersonalNumber =
    personalWasSubmitted && !submittedPersonalIsMask ? input.personal_number?.trim() || null : undefined

  if (!isIndividual) {
    if (explicitPersonalNumber) {
      return {
        ok: false,
        error: {
          field: 'personal_number',
          message: 'Personal number is only allowed for individual customers',
        },
      }
    }
    return {
      ok: true,
      data: {
        customerType,
        orgNumber: options.create ? legacyPersonalNumber : input.org_number,
        personalNumber:
          options.create || typeChanged || explicitPersonalNumber === null ? null : undefined,
      },
    }
  }

  if (legacyPersonalNumber && !PERSONAL_NUMBER_PLAINTEXT_RE.test(legacyPersonalNumber)) {
    return {
      ok: false,
      error: {
        field: 'org_number',
        message: 'Individual customer org_number must be a valid personal number',
      },
    }
  }

  if (
    legacyPersonalNumber &&
    explicitPersonalNumber &&
    !personalNumbersMatch(legacyPersonalNumber, explicitPersonalNumber)
  ) {
    return {
      ok: false,
      error: {
        field: 'personal_number',
        message: 'org_number and personal_number must identify the same person',
      },
    }
  }

  let personalNumber: string | null | undefined
  if (explicitPersonalNumber) {
    personalNumber = explicitPersonalNumber
  } else if (legacyPersonalNumber) {
    personalNumber = legacyPersonalNumber
  } else if (explicitPersonalNumber === null) {
    personalNumber = null
  } else if (options.create || typeChanged) {
    personalNumber = null
  }

  return {
    ok: true,
    data: {
      customerType,
      orgNumber: options.create || typeChanged || orgWasSubmitted ? null : undefined,
      personalNumber,
    },
  }
}
