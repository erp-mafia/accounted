import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  getDefaultAccountForCategory,
  getDefaultVatTreatmentForCategory,
} from '@/lib/bookkeeping/category-mapping'
import type { AccountCandidate, SelectAccountInput } from '../select-account'

const generateStructured = vi.fn()
vi.mock('@/lib/ai', () => ({ getAiService: () => ({ generateStructured }) }))

import { selectAccount } from '../select-account'

function pick(
  choice: string,
  opts: { confidence?: 'high' | 'medium' | 'low'; moms?: string; reasoning?: string } = {},
) {
  return {
    value: {
      reasoning: opts.reasoning ?? 'resonemang',
      choice,
      confidence: opts.confidence ?? 'high',
      ...(opts.moms ? { moms: opts.moms } : {}),
    },
    model: 'qwen3.8',
    usage: {},
  }
}

const CAND: AccountCandidate = {
  account: '5410',
  label: 'Förbrukningsinventarier',
  vatTreatment: 'standard_25',
  source: 'counterparty_template',
  confidence: 0.9,
}

function input(over: Partial<SelectAccountInput> = {}): SelectAccountInput {
  return {
    transaction: { merchantName: 'Biltema', description: 'Kortköp Biltema', amount: -499, currency: 'SEK' },
    candidates: [CAND],
    entityType: 'aktiebolag',
    vatRegistered: true,
    samples: 1,
    ...over,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  generateStructured.mockResolvedValue(pick('cand:0'))
})

describe('selectAccount', () => {
  it('resolves a chosen candidate to its account + VAT, flagged fromCandidate', async () => {
    const res = await selectAccount(input())
    expect(res.account).toBe('5410')
    expect(res.fromCandidate).toBe(true)
    expect(res.vatTreatment).toBe('standard_25')
    expect(res.choice).toEqual({ kind: 'candidate', account: '5410' })
    expect(res.confidence).toBeGreaterThan(0)
    expect(res.model).toBe('qwen3.8')
  })

  it('resolves a chosen category to the deterministic default account + VAT (novel path)', async () => {
    generateStructured.mockResolvedValue(pick('cat:expense_software'))
    const res = await selectAccount(input({ candidates: [] }))
    expect(res.category).toBe('expense_software')
    expect(res.account).toBe(getDefaultAccountForCategory('expense_software', 'aktiebolag'))
    expect(res.vatTreatment).toBe(getDefaultVatTreatmentForCategory('expense_software'))
    expect(res.fromCandidate).toBe(false)
  })

  it('needs_review yields no account and zero confidence', async () => {
    generateStructured.mockResolvedValue(pick('needs_review'))
    const res = await selectAccount(input())
    expect(res.account).toBeNull()
    expect(res.category).toBeNull()
    expect(res.confidence).toBe(0)
    expect(res.choice).toEqual({ kind: 'needs_review' })
  })

  it('degrades an unknown/hallucinated choice to needs_review', async () => {
    generateStructured.mockResolvedValue(pick('cand:99'))
    const res = await selectAccount(input())
    expect(res.choice).toEqual({ kind: 'needs_review' })
    expect(res.account).toBeNull()
  })

  it('applies reverse charge only for a VAT-registered company', async () => {
    generateStructured.mockResolvedValue(pick('cat:expense_professional_services', { moms: 'omvand_eu' }))
    const yes = await selectAccount(input({ candidates: [], vatRegistered: true }))
    expect(yes.vatCase).toBe('reverse_charge_eu')
    expect(yes.reverseCharge).toBe(true)
    expect(yes.vatTreatment).toBe('reverse_charge')
    expect(yes.reverseChargeKind).toBe('eu_services')

    generateStructured.mockResolvedValue(pick('cat:expense_professional_services', { moms: 'omvand_eu' }))
    const no = await selectAccount(input({ candidates: [], vatRegistered: false }))
    expect(no.vatTreatment).not.toBe('reverse_charge')
    expect(no.reverseChargeKind).toBeNull()
  })

  it('tells a service from outside the EU from one inside it, so the booking can report ruta 22', async () => {
    generateStructured.mockResolvedValue(pick('cat:expense_software', { moms: 'omvand_utanfor_eu' }))
    const res = await selectAccount(input({ candidates: [], vatRegistered: true }))
    expect(res.vatCase).toBe('reverse_charge_non_eu')
    expect(res.reverseCharge).toBe(true)
    expect(res.vatTreatment).toBe('reverse_charge')
    expect(res.reverseChargeKind).toBe('non_eu_services')

    const unregistered = await selectAccount(input({ candidates: [], vatRegistered: false }))
    expect(unregistered.vatTreatment).not.toBe('reverse_charge')
    expect(unregistered.reverseChargeKind).toBeNull()
  })

  it('names no box for a reverse charge it only took over from a candidate', async () => {
    generateStructured.mockResolvedValue(pick('cand:0', { moms: 'sverige' }))
    const res = await selectAccount(input({ candidates: [{ ...CAND, vatTreatment: 'reverse_charge' }] }))
    expect(res.vatTreatment).toBe('reverse_charge')
    expect(res.reverseChargeKind).toBeNull()
  })

  it('never applies reverse charge to a needs_review outcome', async () => {
    generateStructured.mockResolvedValue(pick('needs_review', { moms: 'omvand_eu' }))
    const res = await selectAccount(input())
    expect(res.reverseCharge).toBe(false)
    expect(res.vatCase).toBe('domestic')
  })

  describe('where the purchase is taxed', () => {
    const MEAL_ABROAD = { merchantName: null, description: 'BUN MEE SAN FRANCISCO', amount: -473.63, currency: 'SEK' }

    it('books a purchase used on the spot abroad without Swedish moms, whatever the category defaults to', async () => {
      expect(getDefaultVatTreatmentForCategory('expense_travel')).toBe('standard_25')
      generateStructured.mockResolvedValue(pick('cat:expense_travel', { moms: 'utomlands' }))
      const res = await selectAccount(input({ candidates: [], transaction: MEAL_ABROAD }))
      expect(res.account).toBe(getDefaultAccountForCategory('expense_travel', 'aktiebolag'))
      expect(res.vatCase).toBe('abroad')
      expect(res.vatTreatment).toBe('exempt')
      expect(res.reverseCharge).toBe(false)
      expect(res.reverseChargeKind).toBeNull()
    })

    it('lets it override a candidate learned with Swedish moms too: it is this row that was bought abroad', async () => {
      generateStructured.mockResolvedValue(pick('cand:0', { moms: 'utomlands' }))
      const res = await selectAccount(input({ transaction: MEAL_ABROAD }))
      expect(res.account).toBe('5410')
      expect(res.vatTreatment).toBe('exempt')
    })

    it('keeps the default for a purchase in Sweden, said or unsaid', async () => {
      generateStructured.mockResolvedValue(pick('cat:expense_travel', { moms: 'sverige' }))
      expect((await selectAccount(input({ candidates: [] }))).vatTreatment).toBe('standard_25')

      generateStructured.mockResolvedValue(pick('cat:expense_travel'))
      const unsaid = await selectAccount(input({ candidates: [] }))
      expect(unsaid.vatCase).toBe('domestic')
      expect(unsaid.vatTreatment).toBe('standard_25')
    })

    it('reads an answer outside the closed set as the default', async () => {
      for (const moms of ['usa', 'constructor', 'reverse_charge_non_eu', 'omvand_eu_vara']) {
        generateStructured.mockResolvedValue(pick('cat:expense_travel', { moms }))
        const res = await selectAccount(input({ candidates: [] }))
        expect(res.vatCase).toBe('domestic')
        expect(res.vatTreatment).toBe('standard_25')
      }
    })

    it('never touches money coming in: abroad is about a purchase', async () => {
      generateStructured.mockResolvedValue(pick('cat:income_services', { moms: 'utomlands' }))
      const res = await selectAccount(
        input({ candidates: [], transaction: { description: 'Inbetalning', amount: 1000, currency: 'SEK' } }),
      )
      expect(res.vatTreatment).toBe(getDefaultVatTreatmentForCategory('income_services'))
    })

    it('offers the model exactly the four answers the booking can carry', async () => {
      await selectAccount(input())
      const { schema, system } = generateStructured.mock.calls[0][0]
      expect(schema.jsonSchema.properties.moms.enum).toEqual(['sverige', 'utomlands', 'omvand_eu', 'omvand_utanfor_eu'])
      expect(schema.jsonSchema.properties).not.toHaveProperty('reverse_charge')
      for (const id of schema.jsonSchema.properties.moms.enum) expect(system).toContain(`"${id}"`)
    })
  })

  describe('self-consistency', () => {
    it('defaults to 3 samples and majority-votes the winner', async () => {
      generateStructured
        .mockResolvedValueOnce(pick('cand:0'))
        .mockResolvedValueOnce(pick('cand:0'))
        .mockResolvedValueOnce(pick('cat:expense_other'))
      const res = await selectAccount(input({ samples: undefined }))
      expect(generateStructured).toHaveBeenCalledTimes(3)
      expect(res.choice).toEqual({ kind: 'candidate', account: '5410' })
      expect(res.agreement).toBe(0.67)
    })

    it('single sample has full agreement', async () => {
      const res = await selectAccount(input({ samples: 1 }))
      expect(res.agreement).toBe(1)
      expect(generateStructured).toHaveBeenCalledTimes(1)
    })

    it('lower agreement lowers an unbacked (category-guess) confidence', async () => {
      generateStructured
        .mockResolvedValueOnce(pick('cat:expense_office', { confidence: 'high' }))
        .mockResolvedValueOnce(pick('cat:expense_office', { confidence: 'high' }))
        .mockResolvedValueOnce(pick('cat:expense_travel', { confidence: 'high' }))
      const split = await selectAccount(input({ candidates: [], samples: 3 }))
      // No candidate backs the pick → unbacked: 2/3 agreement × 0.7 (high) ≈ 0.47.
      expect(split.confidence).toBeCloseTo(0.47, 1)
      expect(split.agreement).toBe(0.67)
    })

    it('an unbacked category guess never reaches the säker band, however sure the model is', async () => {
      generateStructured.mockResolvedValue(pick('cat:expense_software', { confidence: 'high' }))
      const res = await selectAccount(input({ candidates: [], samples: 1 }))
      // high model conf, full agreement, but no deterministic backing → capped at 0.7 (< 0.8).
      expect(res.confidence).toBeLessThan(0.8)
      expect(res.confidence).toBeCloseTo(0.7, 2)
    })

    it('a backed pick takes the candidate confidence, only reduced when the model is unsure', async () => {
      // model says "low", but the chosen candidate is a 0.9 counterparty template.
      generateStructured.mockResolvedValue(pick('cand:0', { confidence: 'low' }))
      const res = await selectAccount(input({ samples: 1 }))
      // backing 0.9 × agreement 1 × low-factor 0.75 = 0.675.
      expect(res.confidence).toBeCloseTo(0.68, 2)
    })

    it('a backed pick the model is sure about keeps the full candidate confidence', async () => {
      generateStructured.mockResolvedValue(pick('cand:0', { confidence: 'high' }))
      const res = await selectAccount(input({ samples: 1 }))
      expect(res.confidence).toBe(0.9) // 0.9 × 1 × 1
    })
  })

  describe('prompt + schema', () => {
    it('builds a closed enum of candidate ids + category ids + needs_review, reasoning first', async () => {
      await selectAccount(input())
      const call = generateStructured.mock.calls[0][0]
      const props = call.schema.jsonSchema.properties
      expect(Object.keys(props)[0]).toBe('reasoning') // reason-before-choice
      expect(props.choice.enum).toContain('cand:0')
      expect(props.choice.enum).toContain('cat:expense_software')
      expect(props.choice.enum).toContain('needs_review')
      expect(call.system).toContain('BAS')
    })

    it('puts the candidate and the underlag into the prompt', async () => {
      await selectAccount(input({ underlag: 'Leverantör: Biltema AB\nSumma: 499 kr' }))
      const prompt = generateStructured.mock.calls[0][0].prompt as string
      expect(prompt).toContain('KANDIDATKONTON')
      expect(prompt).toContain('konto 5410')
      expect(prompt).toContain('Biltema')
      expect(prompt).toContain('Underlag')
      expect(prompt).toContain('Summa: 499 kr')
    })

    it('omits the candidate block when there are none', async () => {
      generateStructured.mockResolvedValue(pick('cat:expense_other'))
      await selectAccount(input({ candidates: [] }))
      const prompt = generateStructured.mock.calls[0][0].prompt as string
      expect(prompt).not.toContain('KANDIDATKONTON')
      expect(prompt).toContain('KATEGORIER')
    })
  })

  describe('VAT registration (lib/bookkeeping/vat-registration.ts)', () => {
    it('resolves the category default to exempt for a non-registered company, standard_25 for a registered one', async () => {
      generateStructured.mockResolvedValue(pick('cat:expense_software'))
      const yes = await selectAccount(input({ candidates: [], vatRegistered: true }))
      expect(yes.vatTreatment).toBe('standard_25')

      generateStructured.mockResolvedValue(pick('cat:expense_software'))
      const no = await selectAccount(input({ candidates: [], vatRegistered: false }))
      expect(no.account).toBe(getDefaultAccountForCategory('expense_software', 'aktiebolag'))
      expect(no.vatTreatment).toBe('exempt')
    })

    it('resolves a candidate learned with 25 % moms to exempt for a non-registered company', async () => {
      generateStructured.mockResolvedValue(pick('cand:0'))
      const res = await selectAccount(input({ vatRegistered: false }))
      expect(res.account).toBe('5410')
      expect(res.fromCandidate).toBe(true)
      expect(res.vatTreatment).toBe('exempt')
    })

    it('leaves an unknown registration (undefined) untouched', async () => {
      generateStructured.mockResolvedValue(pick('cat:expense_software'))
      const res = await selectAccount(input({ candidates: [], vatRegistered: undefined }))
      expect(res.vatTreatment).toBe('standard_25')
    })
  })
})
