import { describe, expect, it } from 'vitest'
import {
  personalNumbersMatch,
  resolveCustomerIdentifiers,
} from '@/lib/customers/identifiers'

describe('resolveCustomerIdentifiers', () => {
  it('moves the legacy org_number alias into personal_number for an individual', () => {
    const result = resolveCustomerIdentifiers(
      { customer_type: 'individual', org_number: '19900101-1234' },
      { create: true },
    )

    expect(result).toEqual({
      ok: true,
      data: {
        customerType: 'individual',
        orgNumber: null,
        personalNumber: '19900101-1234',
      },
    })
  })

  it('accepts matching 10-digit and 12-digit forms only once', () => {
    expect(personalNumbersMatch('19900101-1234', '9001011234')).toBe(true)
    expect(
      resolveCustomerIdentifiers(
        {
          customer_type: 'individual',
          org_number: '9001011234',
          personal_number: '19900101-1234',
        },
        { create: true },
      ),
    ).toMatchObject({
      ok: true,
      data: { orgNumber: null, personalNumber: '19900101-1234' },
    })
  })

  it('uses the legacy alias when a nullable client also sends personal_number null', () => {
    expect(
      resolveCustomerIdentifiers(
        {
          customer_type: 'individual',
          org_number: '19900101-1234',
          personal_number: null,
        },
        { create: true },
      ),
    ).toMatchObject({
      ok: true,
      data: { orgNumber: null, personalNumber: '19900101-1234' },
    })
  })

  it('rejects conflicting individual identifier fields', () => {
    const result = resolveCustomerIdentifiers(
      {
        customer_type: 'individual',
        org_number: '900101-1234',
        personal_number: '900101-5678',
      },
      { create: true },
    )

    expect(result).toMatchObject({
      ok: false,
      error: { field: 'personal_number' },
    })
  })

  it('rejects a non-personnummer legacy value for an individual', () => {
    const result = resolveCustomerIdentifiers(
      { customer_type: 'individual', org_number: 'TEST-ORG' },
      { create: true },
    )

    expect(result).toMatchObject({ ok: false, error: { field: 'org_number' } })
  })

  it('keeps a masked update unchanged and clears the canonical field on a type change', () => {
    expect(
      resolveCustomerIdentifiers(
        { personal_number: '********-1234' },
        { currentCustomerType: 'individual' },
      ),
    ).toMatchObject({
      ok: true,
      data: { orgNumber: undefined, personalNumber: undefined },
    })

    expect(
      resolveCustomerIdentifiers(
        { customer_type: 'swedish_business', personal_number: '********-1234' },
        { currentCustomerType: 'individual' },
      ),
    ).toMatchObject({
      ok: true,
      data: { personalNumber: null },
    })
  })
})
