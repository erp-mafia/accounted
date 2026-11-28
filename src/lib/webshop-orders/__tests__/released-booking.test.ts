import { describe, expect, it } from 'vitest'
import { createFakeDb } from '@/lib/pos-sales/__tests__/fake-db'
import { readCompanyReleasedWebshopBookings, readReleasedWebshopBookings } from '../released-booking'

const COMPANY = 'company-1'

const entry = (id: string, overrides: Record<string, unknown> = {}) => ({
  id,
  company_id: COMPANY,
  source_type: 'webshop_order',
  status: 'reversed',
  voucher_series: 'L',
  fiscal_period_id: 'fp-2026',
  correction_of_id: null,
  ...overrides,
})

const orderNaming = (id: string, journal_entry_id: string) => ({ id, company_id: COMPANY, journal_entry_id })

describe('readReleasedWebshopBookings', () => {
  it('returns the verifikat a plain storno reversed, with their series and fiscal year', async () => {
    const db = createFakeDb({
      journal_entries: [
        entry('je-rev'),
        entry('je-posted', { status: 'posted' }),
        entry('je-fixed'),
        // The rättelse that replaced je-fixed.
        entry('je-fix', { status: 'posted', source_type: 'correction', correction_of_id: 'je-fixed' }),
        // A rättelse abandoned before it posted replaces nothing.
        entry('je-cancelled-fix', { status: 'cancelled', source_type: 'correction', correction_of_id: 'je-rev' }),
        entry('je-other-company', { company_id: 'company-2' }),
      ],
    })

    const released = await readReleasedWebshopBookings(db.client as never, COMPANY, [
      'je-rev',
      'je-posted',
      'je-fixed',
      'je-other-company',
      null,
      'je-rev',
    ])

    expect(Array.from(released.values())).toEqual([{ id: 'je-rev', voucher_series: 'L', fiscal_period_id: 'fp-2026' }])
  })

  it('reads nothing for orders that name no verifikat', async () => {
    const db = createFakeDb({})
    expect((await readReleasedWebshopBookings(db.client as never, COMPANY, [null, undefined])).size).toBe(0)
    expect(db.updates).toEqual([])
  })
})

describe('readCompanyReleasedWebshopBookings', () => {
  it('returns the released verifikat an order still names, never one its orders were booked again from', async () => {
    const db = createFakeDb({
      journal_entries: [
        entry('je-waiting'),
        entry('je-rebooked'),
        entry('je-fixed'),
        entry('je-fix', { status: 'posted', source_type: 'correction', correction_of_id: 'je-fixed' }),
        entry('je-posted', { status: 'posted' }),
        entry('je-manual', { source_type: 'manual' }),
      ],
      webshop_orders: [
        orderNaming('o1', 'je-waiting'),
        orderNaming('o2', 'je-waiting'),
        // Booked again: names its new verifikat.
        orderNaming('o3', 'je-new'),
        orderNaming('o4', 'je-fixed'),
        orderNaming('o5', 'je-posted'),
      ],
    })

    const released = await readCompanyReleasedWebshopBookings(db.client as never, COMPANY)

    expect(Array.from(released.keys())).toEqual(['je-waiting'])
  })

  it('throws when a read fails, so no caller guesses', async () => {
    const failing = {
      from: () => {
        const chain: Record<string, unknown> = {}
        for (const method of ['select', 'eq', 'in', 'neq', 'order', 'range']) chain[method] = () => chain
        chain.then = (resolve: (value: unknown) => void) =>
          resolve({ data: null, error: { code: '57014', message: 'canceling statement due to statement timeout' } })
        return chain
      },
    }
    await expect(readCompanyReleasedWebshopBookings(failing as never, COMPANY)).rejects.toThrow(/statement timeout/)
  })
})
