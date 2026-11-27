import { describe, expect, it } from 'vitest'
import { spendVatCodeSchema } from '@accounted/connect-contract'
import { DEFAULT_REVERSE_CHARGE_KIND, REVERSE_CHARGE_TREATMENT_KINDS, reverseChargeKindRuta } from '@/lib/bookkeeping/vat-entries'
import {
  SPEND_VAT_CODES,
  SPEND_VAT_CODE_NOT_REGISTERED,
  findSpendVatCode,
  spendVatCodesFor,
  toContractVatCode,
  vatCodeForTreatment,
} from '../vat-codes'

describe('spend VAT codes', () => {
  it('publishes a fixed purchase-side list of unique codes the contract accepts', () => {
    const codes = SPEND_VAT_CODES.map((d) => d.code)
    expect(codes).toEqual(['SE25', 'SE12', 'SE6', 'MOMSFRI', 'UTLMOMS', 'EUTJ', 'UTLTJ', 'EUVARA'])
    expect(new Set(codes).size).toBe(codes.length)
    for (const definition of [...SPEND_VAT_CODES, SPEND_VAT_CODE_NOT_REGISTERED]) {
      expect(spendVatCodeSchema.safeParse(toContractVatCode(definition)).success, definition.code).toBe(true)
    }
  })

  it('books Swedish VAT at its rate and nothing for VAT-free or foreign VAT', () => {
    expect(findSpendVatCode('SE25', true)?.handling).toEqual({ kind: 'domestic', rate: 0.25, account: '2641' })
    expect(findSpendVatCode('SE12', true)?.handling).toEqual({ kind: 'domestic', rate: 0.12, account: '2641' })
    expect(findSpendVatCode('SE6', true)?.handling).toEqual({ kind: 'domestic', rate: 0.06, account: '2641' })
    expect(findSpendVatCode('MOMSFRI', true)?.handling).toEqual({ kind: 'none' })
    expect(findSpendVatCode('UTLMOMS', true)?.handling).toEqual({ kind: 'none' })
  })

  it('self-assesses reverse charge at 25 % on 2645 / 2614, each kind in its own basis box', () => {
    const boxes = Object.fromEntries(
      SPEND_VAT_CODES.filter((d) => d.handling.kind === 'reverse').map((d) => {
        const handling = d.handling as { kind: 'reverse'; rate: number; reverseKind: Parameters<typeof reverseChargeKindRuta>[0] }
        expect(d.type).toBe('reverse')
        expect(handling.rate).toBe(0.25)
        expect([d.inputVatAccount, d.outputVatAccount]).toEqual(['2645', '2614'])
        return [d.code, reverseChargeKindRuta(handling.reverseKind)]
      }),
    )
    expect(boxes).toEqual({ EUTJ: 'ruta21', UTLTJ: 'ruta22', EUVARA: 'ruta20' })
    // Standard codes name no VAT accounts: the provider shows them only for reverse codes.
    for (const d of SPEND_VAT_CODES.filter((c) => c.type === 'standard')) {
      expect([d.inputVatAccount, d.outputVatAccount], d.code).toEqual([null, null])
    }
  })

  it('finds a code without regard to case or surrounding space, like the provider matches it', () => {
    expect(findSpendVatCode(' se25 ', true)?.code).toBe('SE25')
    expect(findSpendVatCode('eutj', null)?.code).toBe('EUTJ')
    expect(findSpendVatCode('DE19', true)).toBeNull()
    expect(findSpendVatCode('', true)).toBeNull()
    expect(findSpendVatCode(null, true)).toBeNull()
    expect(findSpendVatCode(undefined, true)).toBeNull()
  })

  it('gives a company that is not VAT registered EJMOMS in place of receipt VAT, and keeps reverse charge', () => {
    expect(spendVatCodesFor(false).map((d) => d.code)).toEqual(['EJMOMS', 'EUTJ', 'UTLTJ', 'EUVARA'])
    expect(SPEND_VAT_CODE_NOT_REGISTERED).toMatchObject({ code: 'EJMOMS', type: 'standard', rate: 0, handling: { kind: 'none' } })
    expect(findSpendVatCode('EJMOMS', false)?.code).toBe('EJMOMS')
    expect(findSpendVatCode('EUTJ', false)?.handling).toMatchObject({ kind: 'reverse', reverseKind: 'eu_services' })
    for (const code of ['SE25', 'SE12', 'SE6', 'MOMSFRI', 'UTLMOMS']) expect(findSpendVatCode(code, false), code).toBeNull()
    expect(findSpendVatCode('EJMOMS', true)).toBeNull()
  })

  it('treats an unknown registration as registered: only an explicit false changes anything', () => {
    expect(spendVatCodesFor(true)).toBe(SPEND_VAT_CODES)
    expect(spendVatCodesFor(null)).toBe(SPEND_VAT_CODES)
    expect(spendVatCodesFor(undefined)).toBe(SPEND_VAT_CODES)
  })

  it("suggests an account's usual code from its VAT treatment", () => {
    expect(vatCodeForTreatment('standard_25', true)).toBe('SE25')
    expect(vatCodeForTreatment('reduced_12', true)).toBe('SE12')
    expect(vatCodeForTreatment('reduced_6', true)).toBe('SE6')
    expect(vatCodeForTreatment('exempt', true)).toBe('MOMSFRI')
    expect(vatCodeForTreatment('reverse_charge_eu_services', true)).toBe('EUTJ')
    expect(vatCodeForTreatment('reverse_charge_non_eu_services', true)).toBe('UTLTJ')
    expect(vatCodeForTreatment('reverse_charge_eu_goods', true)).toBe('EUVARA')
    expect(vatCodeForTreatment('export', true)).toBeNull()
    expect(vatCodeForTreatment(null, true)).toBeNull()
    expect(vatCodeForTreatment(undefined, null)).toBeNull()
    expect(vatCodeForTreatment('standard_25', false)).toBe('EJMOMS')
    expect(vatCodeForTreatment('exempt', false)).toBe('EJMOMS')
    expect(vatCodeForTreatment(null, false)).toBe('EJMOMS')
    expect(vatCodeForTreatment('reverse_charge_eu_services', false)).toBe('EUTJ')
    expect(vatCodeForTreatment('reverse_charge_eu_goods', false)).toBe('EUVARA')
  })

  it('maps plain reverse_charge to the default kind, and every specific treatment to its own kind', () => {
    const plain = findSpendVatCode(vatCodeForTreatment('reverse_charge', true), true)
    expect(plain?.handling).toMatchObject({ kind: 'reverse', reverseKind: DEFAULT_REVERSE_CHARGE_KIND })
    for (const [treatment, kind] of Object.entries(REVERSE_CHARGE_TREATMENT_KINDS)) {
      expect(findSpendVatCode(vatCodeForTreatment(treatment, true), true)?.handling, treatment).toMatchObject({ kind: 'reverse', reverseKind: kind })
    }
  })

  it("hands the contract the code's identity and display, never how it books", () => {
    expect(toContractVatCode(findSpendVatCode('EUTJ', true)!)).toEqual({
      code: 'EUTJ',
      name: 'Tjänst från EU, omvänd moms',
      type: 'reverse',
      rate: 0.25,
      inputVatAccount: '2645',
      outputVatAccount: '2614',
    })
    expect(toContractVatCode(findSpendVatCode('SE12', true)!)).toEqual({
      code: 'SE12',
      name: 'Svensk moms 12 %',
      type: 'standard',
      rate: 0.12,
      inputVatAccount: null,
      outputVatAccount: null,
    })
  })
})
