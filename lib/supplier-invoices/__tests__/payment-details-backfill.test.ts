import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import {
  backfillSupplierPaymentDetails,
  cleanSupplierPaymentDetails,
  isValidBic,
  isValidIban,
  planSupplierPaymentBackfill,
} from '../payment-details-backfill'

const { supabase, enqueue, reset, findCall } = createQueuedMockSupabase()

describe('isValidIban', () => {
  it('accepts a real IBAN with or without spaces and rejects a misread digit', () => {
    expect(isValidIban('SE45 5000 0000 0583 9825 7466')).toBe(true)
    expect(isValidIban('DE89370400440532013000')).toBe(true)
    expect(isValidIban('SE4550000000058398257467')).toBe(false)
    expect(isValidIban('991-2346')).toBe(false)
    expect(isValidIban(null)).toBe(false)
  })
})

describe('isValidBic', () => {
  it('takes 8 or 11 characters only', () => {
    expect(isValidBic('ESSESESS')).toBe(true)
    expect(isValidBic('DEUTDEFF500')).toBe(true)
    expect(isValidBic('ESSE')).toBe(false)
  })
})

describe('cleanSupplierPaymentDetails', () => {
  it('keeps each valid detail on its own and drops the invalid ones', () => {
    expect(cleanSupplierPaymentDetails({ bankgiro: '5050-1055', plusgiro: '123-4', iban: 'SE45 5000 0000 0583 9825 7466', bic: 'essesess' })).toEqual({
      bankgiro: '5050-1055',
      iban: 'SE4550000000058398257466',
      bic: 'ESSESESS',
    })
    expect(cleanSupplierPaymentDetails({ bankgiro: '12', plusgiro: null })).toEqual({})
    expect(cleanSupplierPaymentDetails(null)).toEqual({})
  })
})

describe('planSupplierPaymentBackfill', () => {
  it('fills only what the supplier lacks and never overwrites', () => {
    expect(planSupplierPaymentBackfill({ bankgiro: '991-2346', plusgiro: null, iban: null, bic: null }, { bankgiro: '5050-1055', iban: 'DE89370400440532013000' })).toEqual({
      iban: 'DE89370400440532013000',
    })
    expect(planSupplierPaymentBackfill({ bankgiro: '', plusgiro: '', iban: '', bic: '' }, { bankgiro: '5050-1055' })).toEqual({ bankgiro: '5050-1055' })
  })
})

describe('backfillSupplierPaymentDetails', () => {
  beforeEach(() => {
    reset()
    vi.clearAllMocks()
  })

  it('writes the missing bankgiro to the supplier', async () => {
    enqueue({ data: { bankgiro: null, plusgiro: null, iban: null, bic: null } })
    enqueue({ data: null })
    const written = await backfillSupplierPaymentDetails(supabase as never, 'company-1', 'sup-1', { bankgiro: '5050-1055' })
    expect(written).toEqual({ bankgiro: '5050-1055' })
    expect(findCall('suppliers', 'update')?.[0]).toEqual({ bankgiro: '5050-1055' })
  })

  it('touches nothing when the details are invalid or already there', async () => {
    expect(await backfillSupplierPaymentDetails(supabase as never, 'company-1', 'sup-1', { bankgiro: '12' })).toEqual({})
    expect(supabase.from).not.toHaveBeenCalled()
    enqueue({ data: { bankgiro: '991-2346', plusgiro: null, iban: null, bic: null } })
    expect(await backfillSupplierPaymentDetails(supabase as never, 'company-1', 'sup-1', { bankgiro: '5050-1055' })).toEqual({})
    expect(findCall('suppliers', 'update')).toBeUndefined()
  })
})
