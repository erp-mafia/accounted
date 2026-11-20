import { beforeEach, describe, expect, it, vi } from 'vitest'
import { calculateVatDeclaration, customerLossVatAdjustment } from '../vat-declaration'

/**
 * Kundförlust in the momsdeklaration (build spec 4.2 G and H): the base in
 * ruta 05 (or 06 to 08 for the sale behind the VAT account) moves with the
 * output VAT a konstaterad write-off or a recovery moved, from the bases the
 * decision recorded.
 */

type Line = { account_number: string; debit_amount: number; credit_amount: number }
type WriteOff = { id?: string; kind: string; vat_by_rate: Array<{ account: string; rate: number; vat: number; base: number }>; reverses_id?: string | null; net_amount?: number }

let ledger: Line[] = []
let writeOffs: WriteOff[] = []
let chartAccounts: Array<{ account_number: string; account_name: string; account_class: number; default_vat_rate: number | null }> = []
let writeOffsError: { message: string; code: string } | null = null

function builder(rows: () => unknown[], error: () => { message: string; code: string } | null = () => null) {
  const b: Record<string, unknown> = {}
  for (const m of ['select', 'eq', 'neq', 'in', 'gte', 'lte', 'lt', 'or', 'not', 'order', 'range', 'limit']) {
    b[m] = vi.fn().mockReturnValue(b)
  }
  b.maybeSingle = vi.fn().mockResolvedValue({ data: null, error: null })
  b.single = vi.fn().mockResolvedValue({ data: null, error: null })
  b.then = (resolve: (v: unknown) => void) => {
    const e = error()
    return resolve(e ? { data: null, error: e } : { data: rows(), error: null })
  }
  return b
}

function makeClient() {
  return {
    from: vi.fn((table: string) => {
      if (table === 'invoice_write_offs') return builder(() => writeOffs, () => writeOffsError)
      if (table === 'chart_of_accounts') {
        return builder(() => chartAccounts.map((a) => ({ default_vat_treatment: null, ...a })))
      }
      return builder(() => [])
    }),
    rpc: vi.fn(async () => {
      const byAccount = new Map<string, { debit: number; credit: number }>()
      for (const l of ledger) {
        const t = byAccount.get(l.account_number) ?? { debit: 0, credit: 0 }
        t.debit += l.debit_amount
        t.credit += l.credit_amount
        byAccount.set(l.account_number, t)
      }
      return {
        data: {
          totals: [...byAccount].map(([account_number, t]) => ({ account_number, ...t })),
          settlement_shaped_entries: [],
          source_type_counts: {},
        },
        error: null,
      }
    }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any
}

const l = (account_number: string, debit_amount: number, credit_amount: number): Line => ({
  account_number,
  debit_amount,
  credit_amount,
})

beforeEach(() => {
  ledger = []
  writeOffs = []
  chartAccounts = []
  writeOffsError = null
})

describe('customerLossVatAdjustment', () => {
  const share = [
    { account: '2611', rate: 25, vat: 125, base: 500 },
    { account: '2621', rate: 12, vat: 12, base: 100 },
  ]

  it('lowers ruta 05 for a konstaterad loss and raises it for a recovery, per rate', () => {
    expect(customerLossVatAdjustment([{ kind: 'confirmed', vat_by_rate: share }])).toEqual({
      ruta05: -600,
      ruta06: 0,
      ruta07: 0,
      ruta08: 0,
      base25: -500,
      base12: -100,
      base6: 0,
      recoveredNet: 0,
    })
    expect(customerLossVatAdjustment([{ kind: 'recovered', vat_by_rate: share }]).ruta05).toBe(600)
  })

  it('undoes a decision in the period of its annulment, and ignores reserves', () => {
    expect(
      customerLossVatAdjustment([
        { kind: 'annulled', vat_by_rate: share, reversed_kind: 'confirmed' },
        { kind: 'annulled', vat_by_rate: [share[0]!], reversed_kind: 'recovered' },
        { kind: 'doubtful', vat_by_rate: share },
        { kind: 'annulled', vat_by_rate: share, reversed_kind: 'doubtful' },
      ]).ruta05,
    ).toBe(100)
  })

  it('takes each base back from the ruta its sale was declared in', () => {
    const adjustment = customerLossVatAdjustment([
      {
        kind: 'confirmed',
        vat_by_rate: [
          // Hyra under frivillig skattskyldighet: ruta 08.
          { account: '2613', rate: 25, vat: 250, base: 1000 },
          // Vinstmarginalbeskattning: ruta 07.
          { account: '2616', rate: 25, vat: 50, base: 200 },
          // Uttag: ruta 06.
          { account: '2612', rate: 25, vat: 25, base: 100 },
          // An ordinary sale: ruta 05.
          { account: '2631', rate: 6, vat: 6, base: 100 },
        ],
      },
    ])
    expect(adjustment).toEqual({
      ruta05: -100,
      ruta06: -100,
      ruta07: -200,
      ruta08: -1000,
      base25: 0,
      base12: 0,
      base6: -100,
      recoveredNet: 0,
    })
  })

  it('moves nothing for a loss without a VAT share', () => {
    expect(customerLossVatAdjustment([{ kind: 'confirmed', vat_by_rate: [] }]).ruta05).toBe(0)
  })

  it('counts the net a recovery put on 3950, and takes it back in the period of its annulment', () => {
    expect(customerLossVatAdjustment([{ kind: 'recovered', vat_by_rate: [], net_amount: 400 }]).recoveredNet).toBe(400)
    expect(
      customerLossVatAdjustment([
        { kind: 'recovered', vat_by_rate: share, net_amount: '600.00' },
        { kind: 'annulled', vat_by_rate: share, net_amount: 600, reversed_kind: 'recovered' },
        { kind: 'confirmed', vat_by_rate: share, net_amount: 600 },
        { kind: 'annulled', vat_by_rate: share, net_amount: 600, reversed_kind: 'confirmed' },
      ]).recoveredNet,
    ).toBe(0)
  })
})

describe('calculateVatDeclaration with kundförlust', () => {
  it('keeps ruta 05 at ruta 10 / 0.25 after a konstaterad loss in the period', async () => {
    // A sale of 2 000 + 500 and a konstaterad loss on 500 + 125 of another invoice.
    ledger = [
      l('1510', 2500, 0),
      l('3001', 0, 2000),
      l('2611', 0, 500),
      l('6351', 500, 0),
      l('2611', 125, 0),
      l('1510', 0, 625),
    ]
    writeOffs = [{ kind: 'confirmed', vat_by_rate: [{ account: '2611', rate: 25, vat: 125, base: 500 }] }]
    const result = await calculateVatDeclaration(makeClient(), 'company-1', 'monthly', 2026, 6)
    expect(result.rutor.ruta10).toBe(375)
    expect(result.rutor.ruta05).toBe(1500)
    expect(result.rutor.ruta05 * 0.25).toBe(result.rutor.ruta10)
    expect(result.breakdown.invoices.base25).toBe(1500)
  })

  it('lowers ruta 08, not ruta 05, for a konstaterad loss on rent under frivillig skattskyldighet', async () => {
    ledger = [l('6351', 1000, 0), l('2613', 250, 0), l('1510', 0, 1250)]
    writeOffs = [{ kind: 'confirmed', vat_by_rate: [{ account: '2613', rate: 25, vat: 250, base: 1000 }] }]
    const result = await calculateVatDeclaration(makeClient(), 'company-1', 'monthly', 2026, 6)
    expect(result.rutor.ruta10).toBe(-250)
    expect(result.rutor.ruta08).toBe(-1000)
    expect(result.rutor.ruta05).toBe(0)
  })

  it('raises ruta 05 again for a recovery, and leaves the recovery out of the revenue-without-a-ruta warning', async () => {
    ledger = [l('1930', 125, 0), l('3950', 0, 100), l('2611', 0, 25)]
    writeOffs = [{ kind: 'recovered', net_amount: 100, vat_by_rate: [{ account: '2611', rate: 25, vat: 25, base: 100 }] }]
    chartAccounts = [{ account_number: '3950', account_name: 'Återvunna, tidigare avskrivna kundfordringar', account_class: 3, default_vat_rate: null }]
    const result = await calculateVatDeclaration(makeClient(), 'company-1', 'monthly', 2026, 7)
    expect(result.rutor.ruta10).toBe(25)
    expect(result.rutor.ruta05).toBe(100)
    expect(result.revenueAccountsWithoutRuta ?? []).toEqual([])
  })

  it('keeps warning about 3950 booked by hand, as before', async () => {
    chartAccounts = [{ account_number: '3950', account_name: 'Återvunna, tidigare avskrivna kundfordringar', account_class: 3, default_vat_rate: null }]
    // Only a hand-booked 3950 in the period.
    ledger = [l('1930', 300, 0), l('3950', 0, 300)]
    const byHand = await calculateVatDeclaration(makeClient(), 'company-1', 'monthly', 2026, 7)
    expect(byHand.revenueAccountsWithoutRuta).toEqual([
      { account_number: '3950', account_name: 'Återvunna, tidigare avskrivna kundfordringar', amount: 300 },
    ])

    // A recovery beside it: only the hand-booked part is warned about.
    ledger = [l('1930', 425, 0), l('3950', 0, 400), l('2611', 0, 25)]
    writeOffs = [{ kind: 'recovered', net_amount: 100, vat_by_rate: [{ account: '2611', rate: 25, vat: 25, base: 100 }] }]
    const both = await calculateVatDeclaration(makeClient(), 'company-1', 'monthly', 2026, 7)
    expect(both.revenueAccountsWithoutRuta).toEqual([
      { account_number: '3950', account_name: 'Återvunna, tidigare avskrivna kundfordringar', amount: 300 },
    ])
  })

  it('counts no kundförlust decisions, with a warning, while invoice_write_offs does not exist yet', async () => {
    ledger = [l('1510', 1250, 0), l('3001', 0, 1000), l('2611', 0, 250)]
    writeOffs = [{ kind: 'confirmed', vat_by_rate: [{ account: '2611', rate: 25, vat: 250, base: 1000 }] }]
    for (const code of ['PGRST205', '42P01']) {
      writeOffsError = { message: 'relation "public.invoice_write_offs" does not exist', code }
      const result = await calculateVatDeclaration(makeClient(), 'company-1', 'monthly', 2026, 6)
      expect(result.rutor.ruta05).toBe(1000)
      expect(result.rutor.ruta10).toBe(250)
    }
  })

  it('still fails on any other invoice_write_offs error', async () => {
    writeOffsError = { message: 'canceling statement due to statement timeout', code: '57014' }
    await expect(calculateVatDeclaration(makeClient(), 'company-1', 'monthly', 2026, 6)).rejects.toThrow('statement timeout')
  })

  it('adds the base back when the konstaterad voucher is stornoed in a later period', async () => {
    ledger = [l('6351', 0, 500), l('2611', 0, 125), l('1510', 625, 0)]
    writeOffs = [{ id: 'x', kind: 'annulled', reverses_id: 'g', vat_by_rate: [{ account: '2611', rate: 25, vat: 125, base: 500 }] }]
    const client = makeClient()
    // The second invoice_write_offs read resolves what the annulment annuls.
    const original = client.from
    let reads = 0
    client.from = vi.fn((table: string) => {
      if (table === 'invoice_write_offs') {
        reads += 1
        return reads === 1 ? builder(() => writeOffs) : builder(() => [{ id: 'g', kind: 'confirmed' }])
      }
      return original(table)
    })
    const result = await calculateVatDeclaration(client, 'company-1', 'monthly', 2026, 8)
    expect(result.rutor.ruta10).toBe(125)
    expect(result.rutor.ruta05).toBe(500)
  })
})
