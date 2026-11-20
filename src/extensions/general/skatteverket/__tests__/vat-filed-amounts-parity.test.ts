/**
 * One whole-krona rule for a momsdeklaration, whichever way it is filed.
 *
 * The Skatteverket integration used to round each ruta to the nearest krona
 * while the eSKD file, the manual-filing PDF and the settlement verifikat
 * dropped the öre (buildFiledAmounts). A declaration filed through the
 * integration could then differ by a krona or more from the net the settlement
 * booked on 2650/1650, and from the file the same period exports.
 *
 * These tests pin the API payload to buildFiledAmounts on every ruta, and pin
 * the three other outputs of the same ledger to the payload.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { VAT_RUTA_LABELS, type VatDeclarationRutor } from '@/types'
import { buildFiledAmounts, buildManualFilingRows } from '@/lib/reports/vat-manual-filing'
import { buildESkdFile, RUTA_TO_ESKD_TAG } from '@/lib/reports/vat-eskd-file'
import { calculateVatDeclaration } from '@/lib/reports/vat-declaration'
import { buildVatSettlementProposal } from '@/lib/reports/vat-settlement'
import { buildMomsuppgift } from '../lib/declaration-prep'
import { rutorToMomsuppgift } from '../lib/mappers'
import type { SkatteverketMomsuppgift } from '../types'

/**
 * Ruta to momsuppgift field, written out here on purpose and not imported from
 * the mapper: a ruta wired to the wrong Skatteverket field must fail this file
 * even if the mapper's own table agrees with itself. Box numbers per the
 * comments on SkatteverketMomsuppgift (types.ts).
 */
const FIELD_BY_RUTA: Record<keyof VatDeclarationRutor, keyof SkatteverketMomsuppgift> = {
  ruta05: 'momspliktigForsaljning',
  ruta06: 'momspliktigaUttag',
  ruta07: 'vinstmarginal',
  ruta08: 'hyresInkomst',
  ruta10: 'momsForsaljningUtgaendeHog',
  ruta11: 'momsForsaljningUtgaendeMedel',
  ruta12: 'momsForsaljningUtgaendeLag',
  ruta20: 'inkopVarorEU',
  ruta21: 'inkopTjansterEU',
  ruta22: 'inkopTjansterUtanforEU',
  ruta23: 'inkopVarorSE',
  ruta24: 'inkopTjansterSE',
  ruta30: 'momsInkopUtgaendeHog',
  ruta31: 'momsInkopUtgaendeMedel',
  ruta32: 'momsInkopUtgaendeLag',
  ruta35: 'forsaljningVarorEU',
  ruta36: 'forsaljningVarorUtanforEU',
  ruta37: 'inkopVaror3pHandel',
  ruta38: 'forsaljningVaror3pHandel',
  ruta39: 'forsaljningTjansterEU',
  ruta40: 'ovrigForsaljningTjansterUtanforSE',
  ruta41: 'forsaljningBskKopareSE',
  ruta42: 'momsfriForsaljning',
  ruta48: 'ingaendeMomsAvdrag',
  ruta49: 'summaMoms',
  ruta50: 'import',
  ruta60: 'momsImportUtgaendeHog',
  ruta61: 'momsImportUtgaendeMedel',
  ruta62: 'momsImportUtgaendeLag',
}

const ALL_RUTOR = Object.keys(VAT_RUTA_LABELS) as (keyof VatDeclarationRutor)[]

/** The nine output-VAT fields Skatteverket sums before subtracting ruta 48 (FK009). */
const OUTPUT_VAT_FIELDS: (keyof SkatteverketMomsuppgift)[] = [
  'momsForsaljningUtgaendeHog', 'momsForsaljningUtgaendeMedel', 'momsForsaljningUtgaendeLag',
  'momsInkopUtgaendeHog', 'momsInkopUtgaendeMedel', 'momsInkopUtgaendeLag',
  'momsImportUtgaendeHog', 'momsImportUtgaendeMedel', 'momsImportUtgaendeLag',
]

/** Every ruta gets its own amount: a base that differs per box plus the given öre. */
function rutorWithOre(ore: number, sign: 1 | -1 = 1): VatDeclarationRutor {
  const rutor = {} as VatDeclarationRutor
  ALL_RUTOR.forEach((key, index) => {
    rutor[key] = sign * (1000 + index * 37 + ore)
  })
  return rutor
}

/** A payload field Skatteverket never received counts as 0 (absent means 0). */
function sent(payload: SkatteverketMomsuppgift, key: keyof VatDeclarationRutor): number {
  return payload[FIELD_BY_RUTA[key]] ?? 0
}

/** `-0` and `0` are the same filed amount; Object.is would call them different. */
function filed(rutor: VatDeclarationRutor, key: keyof VatDeclarationRutor): number {
  return buildFiledAmounts(rutor).amounts[key] + 0
}

function expectPayloadMatchesFiledAmounts(rutor: VatDeclarationRutor) {
  const payload = rutorToMomsuppgift(rutor)
  for (const key of ALL_RUTOR) {
    expect(sent(payload, key), key).toBe(filed(rutor, key))
  }
  return payload
}

describe('rutorToMomsuppgift carries the amounts buildFiledAmounts produces', () => {
  it('covers every ruta of the declaration', () => {
    // A ruta added to the type without a Skatteverket field would be filed in
    // the eSKD file and silently missing from the API payload.
    expect(Object.keys(FIELD_BY_RUTA).sort()).toEqual([...ALL_RUTOR].sort())
  })

  it.each([
    ['an öre part of exactly 0,50', 0.5],
    ['an öre part of 0,51', 0.51],
    ['an öre part of 0,99', 0.99],
    ['an öre part below 0,50', 0.49],
    ['no öre at all', 0],
  ])('agrees on every ruta with %s', (_label, ore) => {
    expectPayloadMatchesFiledAmounts(rutorWithOre(ore))
  })

  it('drops the öre and never rounds up: 0,50 and above stay on the lower krona', () => {
    const rutor = rutorWithOre(0.5)
    const payload = rutorToMomsuppgift(rutor)
    for (const key of ALL_RUTOR.filter((k) => k !== 'ruta49')) {
      expect(sent(payload, key), key).toBe(Math.floor(rutor[key]))
    }
  })

  it.each([
    ['0,51', 0.51],
    ['0,75', 0.75],
    ['0,99', 0.99],
    ['0,25', 0.25],
  ])('agrees on every ruta when the rutor are negative with an öre part of %s', (_label, ore) => {
    expectPayloadMatchesFiledAmounts(rutorWithOre(ore, -1))
  })

  it('drops the öre of a negative ruta toward zero: it does not gain a krona', () => {
    // A credit-note-heavy period can leave a ruta negative. "Öretal faller
    // bort" drops the öre, so -1 000,75 is filed as -1 000. Rounding to the
    // nearest krona and rounding down both make it -1 001.
    const rutor = rutorWithOre(0.75, -1)
    const payload = rutorToMomsuppgift(rutor)
    for (const key of ALL_RUTOR.filter((k) => k !== 'ruta49')) {
      expect(sent(payload, key), key).toBe(Math.ceil(rutor[key]))
      expect(Math.abs(sent(payload, key)), key).toBeLessThan(Math.abs(rutor[key]))
    }
  })

  it('agrees on a mixed declaration: some rutor negative, some with high öre, some empty', () => {
    const rutor = rutorWithOre(0)
    for (const key of ALL_RUTOR) rutor[key] = 0
    rutor.ruta05 = 48211.5
    rutor.ruta10 = 12052.88
    rutor.ruta11 = -340.61 // credit notes outweigh the 12 % sales
    rutor.ruta21 = 3190.67
    rutor.ruta30 = 797.67
    rutor.ruta48 = 9844.93
    rutor.ruta50 = 1200.99
    rutor.ruta60 = 300.25
    rutor.ruta49 = 12052.88 - 340.61 + 797.67 + 300.25 - 9844.93

    const payload = expectPayloadMatchesFiledAmounts(rutor)

    expect(payload.momsForsaljningUtgaendeHog).toBe(12052)
    expect(payload.momsForsaljningUtgaendeMedel).toBe(-340)
    expect(payload.inkopTjansterEU).toBe(3190)
    expect(payload.momsInkopUtgaendeHog).toBe(797)
    expect(payload.ingaendeMomsAvdrag).toBe(9844)
    expect(payload.import).toBe(1200)
    // 12 052 - 340 + 797 + 300 - 9 844, not the 2 965,26 of the ledger.
    expect(payload.summaMoms).toBe(2965)
    // Empty rutor are left out; Skatteverket reads an absent field as 0.
    expect(payload.momspliktigaUttag).toBeUndefined()
    expect(payload.momsImportUtgaendeMedel).toBeUndefined()
  })

  it('summaMoms is the recomputed net, signed, and ties to the fields it is filed with (FK009)', () => {
    for (const rutor of [rutorWithOre(0.5), rutorWithOre(0.99), rutorWithOre(0.75, -1)]) {
      const payload = rutorToMomsuppgift(rutor)
      const outputVat = OUTPUT_VAT_FIELDS.reduce((sum, field) => sum + (payload[field] ?? 0), 0)

      expect(payload.summaMoms).toBe(outputVat - (payload.ingaendeMomsAvdrag ?? 0))
      expect(payload.summaMoms).toBe(buildFiledAmounts(rutor).net)
      expect(Number.isInteger(payload.summaMoms)).toBe(true)
    }
  })

  it('files a refund with the net of the truncated rutor, not one krona more', () => {
    const rutor = rutorWithOre(0)
    for (const key of ALL_RUTOR) rutor[key] = 0
    rutor.ruta21 = 2445.4
    rutor.ruta30 = 611.35
    rutor.ruta31 = 27.22
    rutor.ruta48 = 1204.81
    rutor.ruta49 = 611.35 + 27.22 - 1204.81 // -566,24

    const payload = expectPayloadMatchesFiledAmounts(rutor)

    // 611 + 27 - 1 204. Rounding ruta 48 up to 1 205 asked for 567 back.
    expect(payload.ingaendeMomsAvdrag).toBe(1204)
    expect(payload.summaMoms).toBe(-566)
  })

  it('always sends summaMoms, also for an empty declaration', () => {
    const rutor = rutorWithOre(0)
    for (const key of ALL_RUTOR) rutor[key] = 0

    expect(rutorToMomsuppgift(rutor)).toEqual({ summaMoms: 0 })
  })

  it('leaves out a ruta whose öre are all it holds', () => {
    const rutor = rutorWithOre(0)
    for (const key of ALL_RUTOR) rutor[key] = 0
    rutor.ruta10 = 0.75
    rutor.ruta48 = -0.6 // truncates to -0, which must not be sent as a value

    const payload = rutorToMomsuppgift(rutor)

    expect(payload).toEqual({ summaMoms: 0 })
    expect(Object.is(payload.summaMoms, -0)).toBe(false)
  })
})

// ============================================================
// The same ledger through all four outputs
// ============================================================

interface Ledger {
  totals: Array<{ account_number: string; debit: number; credit: number }>
}

/**
 * Table-routed client: the totals RPC answers the same ledger to the
 * declaration and to the settlement proposal, the chart is empty (BAS
 * mapping only), and no settlement is booked yet.
 */
function makeClient(ledger: Ledger) {
  const rows: Record<string, unknown> = {
    company_settings: { org_number: '5560000000', entity_type: 'aktiebolag' },
  }
  return {
    rpc: vi.fn().mockResolvedValue({
      data: { totals: ledger.totals, settlement_shaped_entries: [], source_type_counts: {} },
      error: null,
    }),
    from: vi.fn().mockImplementation((table: string) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const b: Record<string, any> = {}
      for (const m of ['select', 'eq', 'neq', 'in', 'gte', 'lte', 'not', 'order', 'range', 'limit']) {
        b[m] = vi.fn().mockReturnValue(b)
      }
      b.single = vi.fn().mockResolvedValue({ data: rows[table] ?? null, error: null })
      b.maybeSingle = vi.fn().mockResolvedValue({ data: rows[table] ?? null, error: null })
      b.then = (resolve: (v: unknown) => void) => resolve({ data: [], error: null })
      return b
    }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any
}

function eskdAmount(xml: string, tag: string): number | null {
  const match = new RegExp(`<${tag}>(-?\\d+)</${tag}>`).exec(xml)
  return match ? Number(match[1]) : null
}

const PERIOD = ['quarterly', 2026, 3] as const

beforeEach(() => {
  vi.clearAllMocks()
})

describe('one ledger, four outputs: API payload, eSKD file, PDF rows and settlement verifikat', () => {
  async function outputsOf(ledger: Ledger) {
    const supabase = makeClient(ledger)
    const { momsuppgift } = await buildMomsuppgift(supabase, 'company-1', {
      periodType: PERIOD[0], year: PERIOD[1], period: PERIOD[2],
    })
    const declaration = await calculateVatDeclaration(supabase, 'company-1', ...PERIOD)
    const proposal = await buildVatSettlementProposal(supabase, 'company-1', ...PERIOD)
    const eskd = buildESkdFile(declaration.rutor, { orgNumber: '5560000000', periodEnd: '2026-09-30' })
    const pdfRows = buildManualFilingRows(declaration.rutor)
    return { momsuppgift, declaration, proposal, eskd, pdfRows }
  }

  it('a refund period: Skatteverket is asked for exactly what the settlement books on 1650', async () => {
    // Reverse-charge purchases with öre of 0,50 and above on the input side.
    const { momsuppgift, proposal, eskd, pdfRows } = await outputsOf({
      totals: [
        { account_number: '4535', debit: 2445.4, credit: 0 },
        { account_number: '2614', debit: 0, credit: 611.35 },
        { account_number: '2624', debit: 0, credit: 27.22 },
        { account_number: '2641', debit: 566.24, credit: 0 },
        { account_number: '2645', debit: 638.57, credit: 0 },
      ],
    })

    expect(momsuppgift.summaMoms).toBe(-566)
    expect(proposal.filed_net).toBe(momsuppgift.summaMoms)

    const receivable = proposal.lines.find((l) => l.account_number === '1650')
    expect(receivable?.debit_amount).toBe(Math.abs(momsuppgift.summaMoms!))
    expect(proposal.lines.some((l) => l.account_number === '2650')).toBe(false)

    expect(eskdAmount(eskd, 'MomsBetala')).toBe(momsuppgift.summaMoms)
    expect(eskdAmount(eskd, 'MomsIngAvdr')).toBe(momsuppgift.ingaendeMomsAvdrag)
    expect(pdfRows.at(-1)).toMatchObject({ ruta: '49', label: 'Moms att återfå', amount: 566 })
  })

  it('a payment period: the krona drawn from the skattekonto is the krona credited on 2650', async () => {
    // Two output rutor at 0,50 and above and an input ruta below it. Rounded
    // to the nearest krona this was 12 053 + 798 - 9 844 = 3 007, two kronor
    // above the settlement: the gap is not capped at one krona.
    const { momsuppgift, proposal, eskd, pdfRows } = await outputsOf({
      totals: [
        { account_number: '3001', debit: 0, credit: 48211.5 },
        { account_number: '2611', debit: 0, credit: 12052.88 },
        { account_number: '2614', debit: 0, credit: 797.67 },
        { account_number: '4535', debit: 3190.67, credit: 0 },
        { account_number: '2641', debit: 9046.7, credit: 0 },
        { account_number: '2645', debit: 797.67, credit: 0 },
      ],
    })

    // 12 052 + 797 - 9 844 (ruta 48 is 9 844,37).
    expect(momsuppgift.summaMoms).toBe(3005)
    expect(proposal.filed_net).toBe(momsuppgift.summaMoms)

    const payable = proposal.lines.find((l) => l.account_number === '2650')
    expect(payable?.credit_amount).toBe(momsuppgift.summaMoms)

    expect(eskdAmount(eskd, 'MomsBetala')).toBe(momsuppgift.summaMoms)
    expect(pdfRows.at(-1)).toMatchObject({ ruta: '49', label: 'Moms att betala', amount: 3005 })
  })

  it('every amount in the eSKD file is the amount in the API payload, ruta by ruta', async () => {
    const { momsuppgift, declaration, eskd } = await outputsOf({
      totals: [
        { account_number: '3001', debit: 0, credit: 48211.5 },
        { account_number: '2611', debit: 0, credit: 12052.88 },
        { account_number: '2621', debit: 340.61, credit: 0 }, // credit notes: a negative ruta 11
        { account_number: '2614', debit: 0, credit: 797.67 },
        { account_number: '2615', debit: 0, credit: 300.25 },
        { account_number: '4535', debit: 3190.67, credit: 0 },
        { account_number: '4545', debit: 1200.99, credit: 0 },
        { account_number: '3108', debit: 0, credit: 7300.5 },
        { account_number: '3308', debit: 0, credit: 915.99 },
        { account_number: '2641', debit: 8746.76, credit: 0 },
        { account_number: '2645', debit: 1097.92, credit: 0 },
      ],
    })

    expect(declaration.rutor.ruta11).toBe(-340.61)
    for (const key of ALL_RUTOR) {
      // The file omits an empty ruta just as the payload omits its field.
      expect(eskdAmount(eskd, RUTA_TO_ESKD_TAG[key]) ?? 0, key).toBe(sent(momsuppgift, key))
    }
    expect(eskdAmount(eskd, 'MomsUtgMedel')).toBe(-340)
  })
})
