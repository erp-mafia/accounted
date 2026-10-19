import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { statedPayeeColumns } from '@/lib/payments/payment-details'
import {
  backfillSupplierPaymentDetails,
  inboxStatedPaymentDetails,
  planSupplierPaymentBackfill,
} from '../payment-details-backfill'

const { supabase, enqueue, reset, findCall } = createQueuedMockSupabase()

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
    expect(findCall('suppliers', 'update')?.[0]).toEqual({ bankgiro: '5050-1055', plusgiro: null, iban: null, bic: null })
  })

  it('touches nothing when the details are invalid or already there', async () => {
    expect(await backfillSupplierPaymentDetails(supabase as never, 'company-1', 'sup-1', { bankgiro: '12' })).toEqual({})
    expect(supabase.from).not.toHaveBeenCalled()
    enqueue({ data: { bankgiro: '991-2346', plusgiro: null, iban: null, bic: null } })
    expect(await backfillSupplierPaymentDetails(supabase as never, 'company-1', 'sup-1', { bankgiro: '5050-1055' })).toEqual({})
    expect(findCall('suppliers', 'update')).toBeUndefined()
  })
})

describe('inboxStatedPaymentDetails', () => {
  it('reads the giro, IBAN and BIC an extraction states for its supplier, and nothing else', () => {
    expect(
      inboxStatedPaymentDetails({
        supplier: { name: 'Derome Bygg AB', organizationNumber: '5566778899', bankgiro: '9020-0007', iban: 'SE45 5000 0000 0583 9825 7466' },
        invoice: { invoiceNumber: 'F-1' },
      }),
    ).toEqual({ bankgiro: '9020-0007', plusgiro: null, iban: 'SE45 5000 0000 0583 9825 7466', bic: null })
  })

  it('is null when the extraction states no payment details, has no supplier or is not there', () => {
    expect(inboxStatedPaymentDetails({ supplier: { name: 'Derome Bygg AB', bankgiro: '  ', plusgiro: 1234566 } })).toBeNull()
    expect(inboxStatedPaymentDetails({ invoice: { invoiceNumber: 'F-1' } })).toBeNull()
    expect(inboxStatedPaymentDetails({ supplier: 'Derome Bygg AB' })).toBeNull()
    expect(inboxStatedPaymentDetails(null)).toBeNull()
    expect(inboxStatedPaymentDetails(undefined)).toBeNull()
  })

  it('leaves validation to the columns: a misread bankgiro is read but never stored', () => {
    const details = inboxStatedPaymentDetails({ supplier: { bankgiro: '5050-1056', plusgiro: '123456-6' } })
    expect(details).toEqual({ bankgiro: '5050-1056', plusgiro: '123456-6', iban: null, bic: null })
    expect(statedPayeeColumns(details)).toEqual({ payee_bankgiro: null, payee_plusgiro: '123456-6', payee_iban: null, payee_bic: null })
  })
})
