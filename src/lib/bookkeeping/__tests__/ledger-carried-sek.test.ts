import { beforeEach, describe, expect, it, vi } from 'vitest'
import { carriedSek, carriedSekOf, clearedSek, paidOfClearedSek, statedSettlement } from '../ledger-carried-sek'

/**
 * What the ledger carries is public.document_carried_sek, every voucher shape
 * of it on real Postgres in tests/pg/document-carried-sek.pg.test.ts. Here the
 * seam: the question asked, the answers passed on, and what a payment clears.
 */
function client(result: { data: unknown; error: unknown }) {
  return { rpc: vi.fn().mockResolvedValue(result) } as never as Parameters<typeof carriedSek>[0] & {
    rpc: ReturnType<typeof vi.fn>
  }
}

describe('clearedSek', () => {
  it('a full settlement clears exactly what the ledger carries, not the rate', () => {
    expect(clearedSek({ amount: 176.7, remaining: 176.7, carried: 1965.44, rate: 11.123 })).toBe(1965.44)
  })

  it('a part payment clears its share, and the rest what is left', () => {
    const first = clearedSek({ amount: 12.5, remaining: 37.5, carried: 361.55, rate: 9.6414 })
    expect(first).toBe(120.52)
    const rest = clearedSek({ amount: 25, remaining: 25, carried: 361.55 - first, rate: 9.6414 })
    expect(rest).toBe(241.03)
  })

  it('with no ledger figure, the amount at the booking rate', () => {
    expect(clearedSek({ amount: 30, remaining: 30, carried: null, rate: 10.9455 })).toBe(328.37)
    expect(clearedSek({ amount: 15, remaining: 30, carried: null, rate: 10.9455 })).toBe(164.18)
  })
})

describe('paidOfClearedSek', () => {
  it('the ledger figure pays the whole remainder, whatever the rate reads', () => {
    expect(paidOfClearedSek({ sek: 120.23, remaining: 126.39, carried: 120.23, rate: 0.9512 })).toBe(126.39)
    expect(paidOfClearedSek({ sek: 126.37, remaining: 132.86, carried: 126.37, rate: 0.9512 })).toBe(132.86)
    expect(paidOfClearedSek({ sek: 11500, remaining: 1000, carried: 11500, rate: 11 })).toBe(1000)
  })

  it('less than that pays its share of the ledger, not the rate', () => {
    expect(paidOfClearedSek({ sek: 5750, remaining: 1000, carried: 11500, rate: 11 })).toBe(500)
  })

  it('more than that stays more, for the overshoot guard', () => {
    expect(paidOfClearedSek({ sek: 12650, remaining: 1000, carried: 11500, rate: 11 })).toBe(1100)
  })

  it('with no ledger figure, at the rate', () => {
    expect(paidOfClearedSek({ sek: 5748.35, remaining: 1000, carried: null, rate: 11.4967 })).toBe(500)
  })

  it('reads clearedSek back: a part and the rest pay the whole remainder', () => {
    const cleared = clearedSek({ amount: 12.5, remaining: 37.5, carried: 361.55, rate: 9.6414 })
    expect(paidOfClearedSek({ sek: cleared, remaining: 37.5, carried: 361.55, rate: 9.6414 })).toBe(12.5)
  })
})

describe('statedSettlement', () => {
  it('the bank takes the rate figure plus the difference; the öre the ledger adds is the kursdifferens', () => {
    expect(statedSettlement({ cleared: 1965.44, sekAtRate: 1965.43, difference: 13.61 })).toEqual({
      bankSek: 1979.04,
      gainSek: 13.6,
    })
  })

  it('a rättelse inside the limit moves the gain, never the bank', () => {
    expect(statedSettlement({ cleared: 10500, sekAtRate: 11000, difference: 200 })).toEqual({ bankSek: 11200, gainSek: 700 })
    expect(statedSettlement({ cleared: 11500, sekAtRate: 11000, difference: -100 })).toEqual({ bankSek: 10900, gainSek: -600 })
  })

  it('a stated zero is a statement: exactly the rate figure arrived', () => {
    expect(statedSettlement({ cleared: 1965.44, sekAtRate: 1965.43, difference: 0 })).toEqual({ bankSek: 1965.43, gainSek: -0.01 })
  })

  it('nothing stated: the debt was paid as it stands, nothing gained', () => {
    expect(statedSettlement({ cleared: 1965.44, sekAtRate: 1965.43 })).toEqual({ bankSek: 1965.44, gainSek: 0 })
  })

  it('a difference that closes the gap leaves none', () => {
    expect(statedSettlement({ cleared: 1965.44, sekAtRate: 1965.43, difference: 0.01 })).toEqual({ bankSek: 1965.44, gainSek: 0 })
  })
})

describe('carriedSek', () => {
  beforeEach(() => vi.clearAllMocks())

  it('asks the one definition, for this company, side and document', async () => {
    const supabase = client({ data: { ok: true, sek: 1965.44 }, error: null })
    expect(await carriedSek(supabase, 'c-1', 'customer', 'inv-1')).toEqual({ ok: true, sek: 1965.44 })
    expect(supabase.rpc).toHaveBeenCalledWith('document_carried_sek', {
      p_company_id: 'c-1',
      p_side: 'customer',
      p_document_id: 'inv-1',
    })
  })

  it('passes on the reason the ledger cannot say', async () => {
    const supabase = client({ data: { ok: false, reason: 'payment_voucher_shared' }, error: null })
    expect(await carriedSek(supabase, 'c-1', 'supplier', 'si-1')).toEqual({ ok: false, reason: 'payment_voucher_shared' })
  })

  it('throws on a read error, keeping its code', async () => {
    const supabase = client({ data: null, error: { code: '57014', message: 'statement timeout' } })
    await expect(carriedSek(supabase, 'c-1', 'supplier', 'si-1')).rejects.toMatchObject({ code: '57014' })
  })
})

describe('carriedSekOf', () => {
  it('a kronor document without the öre to round costs no read', async () => {
    const supabase = client({ data: null, error: null })
    expect(await carriedSekOf(supabase, 'c-1', 'customer', { id: 'inv-1', currency: 'SEK' })).toBeNull()
    expect(await carriedSekOf(supabase, 'c-1', 'customer', { id: 'inv-1', currency: null })).toBeNull()
    expect(supabase.rpc).not.toHaveBeenCalled()
  })

  it('answers the figure, or null for a door that falls back to the rate', async () => {
    expect(await carriedSekOf(client({ data: { ok: true, sek: 10 }, error: null }), 'c-1', 'supplier', { id: 's', currency: 'EUR' })).toBe(10)
    expect(await carriedSekOf(client({ data: { ok: false, reason: 'no_registration_voucher' }, error: null }), 'c-1', 'supplier', { id: 's', currency: 'EUR' })).toBeNull()
  })

  describe('a SEK customer invoice whose issue verifikat booked the öresavrundning (crm#1553)', () => {
    const invoice = { id: 'inv-1', currency: 'SEK', total: 17176.25, remaining_amount: 17176.25, paid_amount: 0, journal_entry_id: 'je-1' }

    it('answers what 1510 carries when it is the remainder rounded', async () => {
      const supabase = client({ data: { ok: true, sek: 17176 }, error: null })
      expect(await carriedSekOf(supabase, 'c-1', 'customer', invoice)).toBe(17176)
      expect(supabase.rpc).toHaveBeenCalledWith('document_carried_sek', { p_company_id: 'c-1', p_side: 'customer', p_document_id: 'inv-1' })
    })

    it('null when 1510 carries the remainder, a krona or more off it, or the ledger cannot say', async () => {
      expect(await carriedSekOf(client({ data: { ok: true, sek: 17176.25 }, error: null }), 'c-1', 'customer', invoice)).toBeNull()
      expect(await carriedSekOf(client({ data: { ok: true, sek: 17000 }, error: null }), 'c-1', 'customer', invoice)).toBeNull()
      expect(await carriedSekOf(client({ data: { ok: false, reason: 'registration_voucher_shared' }, error: null }), 'c-1', 'customer', invoice)).toBeNull()
    })

    it('reads nothing for a whole-krona remainder, no issue verifikat, or a supplier invoice', async () => {
      const supabase = client({ data: { ok: true, sek: 1 }, error: null })
      expect(await carriedSekOf(supabase, 'c-1', 'customer', { ...invoice, total: 17176, remaining_amount: 17176 })).toBeNull()
      expect(await carriedSekOf(supabase, 'c-1', 'customer', { ...invoice, journal_entry_id: null })).toBeNull()
      expect(await carriedSekOf(supabase, 'c-1', 'supplier', invoice)).toBeNull()
      expect(supabase.rpc).not.toHaveBeenCalled()
    })

    it('reads the remainder after a part payment, and a numeric string', async () => {
      const supabase = client({ data: { ok: true, sek: 12176 }, error: null })
      expect(await carriedSekOf(supabase, 'c-1', 'customer', { ...invoice, remaining_amount: '12176.25' as never, paid_amount: 5000 })).toBe(12176)
    })

    it('reads a whole-krona remainder left by a part payment: the total has the öre, and 1510 still carries them', async () => {
      // 17 176,25 issued at 17 176, a part payment of 5 000,25: 12 176 open while 1510 carries 12 175,75.
      const supabase = client({ data: { ok: true, sek: 12175.75 }, error: null })
      expect(await carriedSekOf(supabase, 'c-1', 'customer', { ...invoice, remaining_amount: 12176, paid_amount: 5000.25 })).toBe(12175.75)
      expect(supabase.rpc).toHaveBeenCalledTimes(1)
    })

    it('still reads a remainder with öre when the total is whole kronor', async () => {
      // 1 000 with a payment typed as Cr 1510 333 / Cr 3740 0,33 of 333,33: 666,67 open, 1510 carries 667.
      const supabase = client({ data: { ok: true, sek: 667 }, error: null })
      expect(await carriedSekOf(supabase, 'c-1', 'customer', { ...invoice, total: 1000, remaining_amount: 666.67, paid_amount: 333.33 })).toBe(667)
    })

    it('without the total on the row, gates on the remainder as before', async () => {
      const supabase = client({ data: { ok: true, sek: 1 }, error: null })
      expect(await carriedSekOf(supabase, 'c-1', 'customer', { id: 'inv-1', currency: 'SEK', remaining_amount: 12176, journal_entry_id: 'je-1' })).toBeNull()
      expect(supabase.rpc).not.toHaveBeenCalled()
    })
  })
})
