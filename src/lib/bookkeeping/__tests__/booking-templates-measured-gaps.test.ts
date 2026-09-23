import { describe, it, expect } from 'vitest'
import { makeTransaction } from '@/tests/helpers'
import {
  BOOKING_TEMPLATES,
  buildMappingResultFromTemplate,
  findMatchingTemplates,
  getTemplateById,
} from '../booking-templates'

/**
 * The templates added 2026-09-10 for the accounts that twelve months of bank
 * bookings landed on without any template behind them. Each case here pins
 * the one thing that made the template worth adding: the account it books
 * to, the VAT it emits (or deliberately does not), and that the matcher
 * finds it from the merchant text a bank actually sends.
 */

const GAP_IDS = [
  'goods_purchase_domestic',
  'goods_purchase_eu',
  'consumables',
  'goods_freight',
  'customs_duties',
  'it_services',
  'it_services_foreign',
  'newspapers_literature',
  'non_deductible_fees',
  'personnel_refreshments',
  'personnel_wellness',
  'vehicle_tax',
  'vehicle_rental',
  'share_capital_deposit',
  'shareholder_contribution',
  'dividend_paid',
  'capital_insurance_deposit',
  'securities_purchase',
  'grant_received',
  'royalty_income',
  'company_card_settlement',
  'expense_reimbursement',
] as const

function top(description: string, amount: number, entityType?: 'aktiebolag' | 'enskild_firma') {
  const tx = makeTransaction({ description, original_description: description, merchant_name: null, amount })
  return findMatchingTemplates(tx, entityType)[0]?.template.id
}

function accounts(lines: { account_number: string }[]): string[] {
  return lines.map((l) => l.account_number)
}

describe('measured-gap templates', () => {
  it('are all present, each on the account the gap was measured on', () => {
    const expected: Record<(typeof GAP_IDS)[number], string> = {
      goods_purchase_domestic: '4010',
      goods_purchase_eu: '4515',
      consumables: '5460',
      goods_freight: '5710',
      customs_duties: '5720',
      it_services: '6540',
      it_services_foreign: '6540',
      newspapers_literature: '6970',
      non_deductible_fees: '6992',
      personnel_refreshments: '7690',
      personnel_wellness: '7699',
      vehicle_tax: '5612',
      vehicle_rental: '5820',
      share_capital_deposit: '2081',
      shareholder_contribution: '2093',
      dividend_paid: '2898',
      capital_insurance_deposit: '1385',
      securities_purchase: '1810',
      grant_received: '3985',
      royalty_income: '3922',
      company_card_settlement: '2890',
      expense_reimbursement: '2820',
    }
    for (const id of GAP_IDS) {
      const t = getTemplateById(id)
      expect(t, id).toBeDefined()
      const bankIsDebit = t!.debit_account === '1930'
      const business = bankIsDebit ? t!.credit_account : t!.debit_account
      expect(business, id).toBe(expected[id])
    }
  })

  it('the catalog now covers goods: at least one template debits a 4xxx account', () => {
    expect(BOOKING_TEMPLATES.some((t) => t.debit_account.startsWith('4'))).toBe(true)
  })

  it('the owner and placement templates are AB only', () => {
    for (const id of ['share_capital_deposit', 'shareholder_contribution', 'dividend_paid', 'capital_insurance_deposit', 'securities_purchase']) {
      expect(getTemplateById(id)!.entity_applicability, id).toBe('aktiebolag')
    }
  })
})

describe('matcher finds the gap templates from bank text', () => {
  it('routes a builders merchant to goods, not to small equipment', () => {
    expect(top('BYGGMAX LJUSDAL', -1240)).toBe('goods_purchase_domestic')
  })

  it('routes customs to tull och spedition', () => {
    expect(top('TULLVERKET IMPORTAVGIFT', -890)).toBe('customs_duties')
  })

  it('routes vehicle tax to 5612', () => {
    expect(top('FORDONSSKATT TRANSPORTSTYRELSEN', -1520)).toBe('vehicle_tax')
  })

  it('routes a rental car to hyrbil (5820), no longer to travel tickets (5810)', () => {
    expect(top('HERTZ BILUTHYRNING ARLANDA', -2400)).toBe('vehicle_rental')
    const tx = makeTransaction({ description: 'HERTZ', original_description: 'HERTZ', merchant_name: null, amount: -2400, mcc_code: 7512 })
    const ids = findMatchingTemplates(tx).map((m) => m.template.id)
    expect(ids[0]).toBe('vehicle_rental')
    expect(ids).not.toContain('vehicle_leasing')
  })

  it('routes a freelance platform to foreign IT services', () => {
    expect(top('UPWORK ESCROW', -3200)).toBe('it_services_foreign')
  })

  it('routes share capital to the AB template and hides it from an enskild firma', () => {
    expect(top('Insättning aktiekapital', 25000, 'aktiebolag')).toBe('share_capital_deposit')
    expect(top('Insättning aktiekapital', 25000, 'enskild_firma')).not.toBe('share_capital_deposit')
  })

  it('routes a state grant to bidrag', () => {
    expect(top('TILLVÄXTVERKET PROJEKTBIDRAG', 50000)).toBe('grant_received')
  })

  it('leaves the default fixture (a grocery store) without a refreshments match', () => {
    // Grocery names are deliberately not keywords: for an enskild firma an
    // ICA row is more often private than personalfika.
    expect(findMatchingTemplates(makeTransaction()).map((m) => m.template.id)).not.toContain('personnel_refreshments')
  })
})

describe('gap templates book the VAT they promise', () => {
  const ab = 'aktiebolag' as const

  it('EU goods: cost on 4515 with fiktiv moms 2614/2645 and no extra basis pair', () => {
    const t = getTemplateById('goods_purchase_eu')!
    const r = buildMappingResultFromTemplate(t, makeTransaction({ amount: -1000 }), ab)
    expect(r.debit_account).toBe('4515')
    const acc = accounts(r.vat_lines)
    expect(acc).toContain('2614')
    expect(acc).toContain('2645')
    expect(acc).not.toContain('4535')
    expect(acc).not.toContain('4598')
    const out = r.vat_lines.find((l) => l.account_number === '2614')!
    expect(out.credit_amount).toBe(250)
  })

  it('non-EU IT services: fiktiv moms plus the ruta 22 basis pair on 4531/4598', () => {
    const t = getTemplateById('it_services_foreign')!
    const r = buildMappingResultFromTemplate(t, makeTransaction({ amount: -2000 }), ab)
    expect(r.debit_account).toBe('6540')
    const acc = accounts(r.vat_lines)
    expect(acc).toEqual(expect.arrayContaining(['2614', '2645', '4531', '4598']))
  })

  it('fines carry no VAT at all', () => {
    const t = getTemplateById('non_deductible_fees')!
    const r = buildMappingResultFromTemplate(t, makeTransaction({ amount: -600 }), ab)
    expect(r.vat_lines).toHaveLength(0)
    expect(r.debit_account).toBe('6992')
  })

  it('customs and vehicle tax carry no VAT', () => {
    for (const id of ['customs_duties', 'vehicle_tax']) {
      const r = buildMappingResultFromTemplate(getTemplateById(id)!, makeTransaction({ amount: -500 }), ab)
      expect(r.vat_lines, id).toHaveLength(0)
    }
  })

  it('a grant is income without output VAT', () => {
    const r = buildMappingResultFromTemplate(getTemplateById('grant_received')!, makeTransaction({ amount: 10000 }), ab)
    expect(r.credit_account).toBe('3985')
    expect(r.vat_lines).toHaveLength(0)
  })

  it('royalty income carries 6 % output VAT on 2631', () => {
    const r = buildMappingResultFromTemplate(getTemplateById('royalty_income')!, makeTransaction({ amount: 1060 }), ab)
    expect(r.credit_account).toBe('3922')
    expect(r.vat_lines).toHaveLength(1)
    expect(r.vat_lines[0].account_number).toBe('2631')
    expect(r.vat_lines[0].credit_amount).toBe(60)
  })

  it('newspapers deduct 6 % input VAT', () => {
    const r = buildMappingResultFromTemplate(getTemplateById('newspapers_literature')!, makeTransaction({ amount: -212 }), ab)
    expect(r.vat_lines).toHaveLength(1)
    expect(r.vat_lines[0].account_number).toBe('2641')
    expect(r.vat_lines[0].debit_amount).toBe(12)
  })

  it('transfers between bank and equity or placements emit no VAT lines', () => {
    for (const id of ['share_capital_deposit', 'shareholder_contribution', 'dividend_paid', 'capital_insurance_deposit', 'securities_purchase', 'company_card_settlement', 'expense_reimbursement']) {
      const t = getTemplateById(id)!
      const r = buildMappingResultFromTemplate(t, makeTransaction({ amount: t.debit_account === '1930' ? 5000 : -5000 }), ab)
      expect(r.vat_lines, id).toHaveLength(0)
    }
  })
})
