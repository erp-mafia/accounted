import { describe, it, expect } from 'vitest'
import { makeTransaction } from '@/tests/helpers'
import {
  BOOKING_TEMPLATES,
  getTemplateById,
  getTemplatesByGroup,
  getTemplatesByMcc,
  getTemplateGroups,
  searchTemplates,
  findMatchingTemplates,
  buildMappingResultFromTemplate,
  getCommonTemplates,
  getAdvancedTemplates,
  validateTemplateForEntity,
  stripBankNoise,
  type BookingTemplate,
} from '../booking-templates'
import { applySettlementAccount } from '../mapping-engine'

// ============================================================
// Template Data Integrity
// ============================================================

describe('BOOKING_TEMPLATES data integrity', () => {
  it('has exactly 60 templates', () => {
    expect(BOOKING_TEMPLATES).toHaveLength(60)
  })

  it('all template IDs are unique', () => {
    const ids = BOOKING_TEMPLATES.map((t) => t.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('all templates have valid required fields', () => {
    for (const t of BOOKING_TEMPLATES) {
      expect(t.id).toBeTruthy()
      expect(t.name_sv).toBeTruthy()
      expect(t.name_en).toBeTruthy()
      expect(t.group).toBeTruthy()
      expect(['expense', 'income', 'transfer']).toContain(t.direction)
      expect(['all', 'enskild_firma', 'aktiebolag']).toContain(t.entity_applicability)
      expect(t.debit_account).toMatch(/^\d{4}$/)
      expect(t.credit_account).toMatch(/^\d{4}$/)
      expect(['full', 'non_deductible', 'conditional']).toContain(t.deductibility)
      expect(['NONE', 'LOW', 'MEDIUM', 'HIGH', 'VERY_HIGH']).toContain(t.risk_level)
      expect(typeof t.requires_review).toBe('boolean')
      expect(t.impact_score).toBeGreaterThanOrEqual(1)
      expect(t.impact_score).toBeLessThanOrEqual(10)
      expect(t.auto_match_confidence).toBeGreaterThanOrEqual(0.5)
      expect(t.auto_match_confidence).toBeLessThanOrEqual(1.0)
      expect(typeof t.default_private).toBe('boolean')
      expect(t.fallback_category).toBeTruthy()
      expect(t.description_sv).toBeTruthy()
      expect(typeof t.common).toBe('boolean')
      expect(Array.isArray(t.mcc_codes)).toBe(true)
      expect(Array.isArray(t.keywords)).toBe(true)
      expect(t.keywords.length).toBeGreaterThan(0)
    }
  })

  it('all AB-specific override accounts are valid 4-digit strings', () => {
    for (const t of BOOKING_TEMPLATES) {
      if (t.debit_account_ab) {
        expect(t.debit_account_ab).toMatch(/^\d{4}$/)
      }
      if (t.credit_account_ab) {
        expect(t.credit_account_ab).toMatch(/^\d{4}$/)
      }
    }
  })

  it('vat_rate is consistent with vat_treatment', () => {
    for (const t of BOOKING_TEMPLATES) {
      if (t.vat_treatment === 'standard_25') {
        expect(t.vat_rate).toBe(0.25)
      } else if (t.vat_treatment === 'reduced_12') {
        expect(t.vat_rate).toBe(0.12)
      } else if (t.vat_treatment === 'reduced_6') {
        expect(t.vat_rate).toBe(0.06)
      } else if (t.vat_treatment === 'reverse_charge' || t.vat_treatment === 'export' || t.vat_treatment === 'exempt' || t.vat_treatment === null) {
        expect(t.vat_rate).toBe(0)
      }
    }
  })
})

// ============================================================
// Lookup Functions
// ============================================================

describe('getTemplateById', () => {
  it('returns correct template for known ID', () => {
    const t = getTemplateById('it_saas_subscription')
    expect(t).toBeDefined()
    expect(t!.name_sv).toBe('Programvara / SaaS')
    expect(t!.debit_account).toBe('5420')
  })

  it('returns undefined for unknown ID', () => {
    expect(getTemplateById('nonexistent')).toBeUndefined()
  })
})

describe('getTemplatesByGroup', () => {
  it('returns templates for the premises group', () => {
    const templates = getTemplatesByGroup('premises')
    expect(templates.length).toBeGreaterThan(0)
    for (const t of templates) {
      expect(t.group).toBe('premises')
    }
  })

  it('returns empty array for non-existent group', () => {
    expect(getTemplatesByGroup('nonexistent' as never)).toEqual([])
  })
})

describe('getTemplatesByMcc', () => {
  it('returns templates for MCC 5541 (fuel)', () => {
    const templates = getTemplatesByMcc(5541)
    expect(templates.length).toBeGreaterThan(0)
    expect(templates.some((t) => t.id === 'vehicle_fuel')).toBe(true)
  })

  it('returns empty array for unknown MCC', () => {
    expect(getTemplatesByMcc(9999)).toEqual([])
  })
})

describe('getTemplateGroups', () => {
  it('returns all 17 groups', () => {
    const groups = getTemplateGroups()
    expect(groups).toHaveLength(17)
    for (const g of groups) {
      expect(g.group).toBeTruthy()
      expect(g.label_sv).toBeTruthy()
      expect(g.label_en).toBeTruthy()
      expect(Array.isArray(g.templates)).toBe(true)
    }
  })

  it('every template is in exactly one group', () => {
    const groups = getTemplateGroups()
    const allTemplates = groups.flatMap((g) => g.templates)
    expect(allTemplates).toHaveLength(60)
  })
})

// ============================================================
// Search
// ============================================================

describe('searchTemplates', () => {
  it('finds templates by Swedish name', () => {
    const results = searchTemplates('lokalhyra')
    expect(results.length).toBeGreaterThan(0)
    expect(results.some((t) => t.id === 'premises_rent')).toBe(true)
  })

  it('finds templates by English name', () => {
    const results = searchTemplates('software')
    expect(results.length).toBeGreaterThan(0)
    expect(results.some((t) => t.id === 'it_saas_subscription')).toBe(true)
  })

  it('finds templates by keywords', () => {
    const results = searchTemplates('spotify')
    expect(results.length).toBeGreaterThan(0)
  })

  it('returns empty for empty query', () => {
    expect(searchTemplates('')).toEqual([])
  })

  it('filters by entity type', () => {
    const results = searchTemplates('pension', 'enskild_firma')
    // Should include EF-specific and 'all', but not AB-only
    for (const t of results) {
      expect(t.entity_applicability).not.toBe('aktiebolag')
    }
  })

  it('supports multi-token search', () => {
    const results = searchTemplates('annonsering EU')
    expect(results.some((t) => t.id === 'marketing_online_ads_eu')).toBe(true)
  })
})

// ============================================================
// findMatchingTemplates
// ============================================================

describe('findMatchingTemplates', () => {
  it('matches by MCC code with high confidence', () => {
    const tx = makeTransaction({
      amount: -500,
      mcc_code: 5541,
      description: 'Gas station',
      merchant_name: 'OKQ8',
    })
    const matches = findMatchingTemplates(tx)
    expect(matches.length).toBeGreaterThan(0)
    expect(matches[0].template.id).toBe('vehicle_fuel')
    expect(matches[0].confidence).toBeGreaterThan(0.3)
  })

  it('matches by keywords in description', () => {
    const tx = makeTransaction({
      amount: -299,
      description: 'Google Ads campaign',
      merchant_name: 'Google',
    })
    const matches = findMatchingTemplates(tx)
    expect(matches.some((m) => m.template.id === 'marketing_online_ads_eu')).toBe(true)
  })

  it('returns empty for a transaction with no signals', () => {
    const tx = makeTransaction({
      amount: -100,
      description: 'XYZ123ABC',
      mcc_code: null,
      merchant_name: null,
    })
    const matches = findMatchingTemplates(tx)
    expect(matches).toEqual([])
  })

  it('filters by entity type', () => {
    const tx = makeTransaction({
      amount: -5000,
      description: 'Löneutbetalning',
    })
    const matches = findMatchingTemplates(tx, 'enskild_firma')
    // Personnel salary is AB-only, should not appear
    for (const m of matches) {
      expect(m.template.entity_applicability).not.toBe('aktiebolag')
    }
  })

  it('does not match expense templates for positive amounts', () => {
    const tx = makeTransaction({
      amount: 1000,
      description: 'Bensin okq8',
      mcc_code: 5541,
    })
    const matches = findMatchingTemplates(tx)
    // vehicle_fuel is an expense template, should not match positive amount
    expect(matches.every((m) => m.template.direction !== 'expense')).toBe(true)
  })

  it('returns max 10 results', () => {
    const tx = makeTransaction({
      amount: -100,
      description: 'software subscription cloud hosting domain',
      mcc_code: 5817,
    })
    const matches = findMatchingTemplates(tx)
    expect(matches.length).toBeLessThanOrEqual(10)
  })

  it('results are sorted by confidence descending', () => {
    const tx = makeTransaction({
      amount: -999,
      description: 'Google cloud hosting',
      mcc_code: 4816,
    })
    const matches = findMatchingTemplates(tx)
    for (let i = 1; i < matches.length; i++) {
      expect(matches[i - 1].confidence).toBeGreaterThanOrEqual(matches[i].confidence)
    }
  })
})

// ============================================================
// stripBankNoise — protects the matcher from bank-prefix noise
// ============================================================

describe('stripBankNoise', () => {
  it('strips "överföring via internet" before keyword matching', () => {
    expect(stripBankNoise('milersättning april överföring via internet')).toBe(
      'milersättning april'
    )
  })

  it('strips "autogiro" suffix', () => {
    expect(stripBankNoise('elräkning autogiro')).toBe('elräkning')
  })

  it('strips "bg-betalning" and "bgmax"', () => {
    expect(stripBankNoise('vattenfall bg-betalning')).toBe('vattenfall')
    expect(stripBankNoise('kund x bgmax')).toBe('kund x')
  })

  it('strips multiple noise phrases at once', () => {
    expect(stripBankNoise('swish till anna överföring')).toBe('anna')
  })

  it('preserves real merchant text after stripping', () => {
    expect(stripBankNoise('kortköp ica supermarket')).toBe('ica supermarket')
  })

  it('is a no-op when no noise phrases are present', () => {
    expect(stripBankNoise('lokalhyra mars 2026')).toBe('lokalhyra mars 2026')
  })
})

// ============================================================
// Milersättning / traktamente routing — regression guards for
// the "Överföring via internet" → 6230 Internet miscategorization
// ============================================================

describe('milersättning routing', () => {
  it('matches personnel_mileage_taxfree (7331) for "milersättning"', () => {
    const tx = makeTransaction({
      amount: -1496,
      description: 'milersättning april',
    })
    const matches = findMatchingTemplates(tx)
    expect(matches[0]?.template.id).toBe('personnel_mileage_taxfree')
    expect(matches[0]?.template.debit_account).toBe('7331')
  })

  it('does NOT match telecom_internet when description contains "överföring via internet"', () => {
    const tx = makeTransaction({
      amount: -1496,
      description: 'milersättning april Överföring via internet',
    })
    const matches = findMatchingTemplates(tx)
    // The fragile substring match used to fire telecom_internet (6230 + 25% VAT)
    // because the bank suffix contains the word "internet". After stripping
    // bank noise, only milersättning should match.
    expect(matches.find((m) => m.template.id === 'telecom_internet')).toBeUndefined()
    expect(matches[0]?.template.id).toBe('personnel_mileage_taxfree')
  })

  it('emits no VAT lines for milersättning (employee reimbursement, not a purchase)', () => {
    const template = getTemplateById('personnel_mileage_taxfree')
    expect(template).toBeDefined()
    const tx = makeTransaction({ amount: -1496 })
    const result = buildMappingResultFromTemplate(template!, tx, 'aktiebolag')
    expect(result.debit_account).toBe('7331')
    expect(result.vat_lines).toHaveLength(0)
  })

  it('"körersättning" also matches personnel_mileage_taxfree', () => {
    const tx = makeTransaction({
      amount: -1850,
      description: 'körersättning Q1',
    })
    const matches = findMatchingTemplates(tx)
    expect(matches[0]?.template.id).toBe('personnel_mileage_taxfree')
  })

  it('still resolves real internet bills via the telecom_internet template', () => {
    // Make sure we didn't break legitimate internet-bill matching by adding
    // noise stripping. The merchant signal carries the match.
    const tx = makeTransaction({
      amount: -399,
      description: 'Bahnhof bredband mars',
      merchant_name: 'Bahnhof',
    })
    const matches = findMatchingTemplates(tx)
    expect(matches[0]?.template.id).toBe('telecom_internet')
  })
})

describe('traktamente routing', () => {
  it('matches personnel_per_diem_sweden_taxfree (7321) for "traktamente"', () => {
    const tx = makeTransaction({
      amount: -290,
      description: 'traktamente Stockholm april',
    })
    const matches = findMatchingTemplates(tx)
    expect(matches[0]?.template.id).toBe('personnel_per_diem_sweden_taxfree')
    expect(matches[0]?.template.debit_account).toBe('7321')
  })

  it('matches utlandstraktamente → 7323', () => {
    const tx = makeTransaction({
      amount: -800,
      description: 'utlandstraktamente Tyskland',
    })
    const matches = findMatchingTemplates(tx)
    expect(matches[0]?.template.id).toBe('personnel_per_diem_abroad_taxfree')
    expect(matches[0]?.template.debit_account).toBe('7323')
  })

  it('emits no VAT lines for traktamente', () => {
    const template = getTemplateById('personnel_per_diem_sweden_taxfree')
    expect(template).toBeDefined()
    const tx = makeTransaction({ amount: -290 })
    const result = buildMappingResultFromTemplate(template!, tx, 'aktiebolag')
    expect(result.debit_account).toBe('7321')
    expect(result.vat_lines).toHaveLength(0)
  })
})

// ============================================================
// buildMappingResultFromTemplate
// ============================================================

describe('buildMappingResultFromTemplate', () => {
  const getTemplate = (id: string): BookingTemplate => {
    const t = getTemplateById(id)
    if (!t) throw new Error(`Template not found: ${id}`)
    return t
  }

  it('produces valid MappingResult for expense with 25% VAT', () => {
    const template = getTemplate('it_saas_subscription')
    const tx = makeTransaction({ amount: -1250 })
    const result = buildMappingResultFromTemplate(template, tx, 'enskild_firma')

    expect(result.debit_account).toBe('5420')
    expect(result.credit_account).toBe('1930')
    expect(result.template_id).toBe('it_saas_subscription')
    expect(result.rule).toBeNull()
    expect(result.confidence).toBe(1.0)
    expect(result.vat_lines).toHaveLength(1)
    expect(result.vat_lines[0].account_number).toBe('2641')
    expect(result.vat_lines[0].debit_amount).toBe(250) // 1250 * 0.25 / 1.25 = 250
  })

  it('produces valid MappingResult for expense with 12% VAT', () => {
    const template = getTemplate('travel_hotel')
    const tx = makeTransaction({ amount: -1120 })
    const result = buildMappingResultFromTemplate(template, tx, 'enskild_firma')

    expect(result.debit_account).toBe('5820')
    expect(result.vat_lines).toHaveLength(1)
    expect(result.vat_lines[0].account_number).toBe('2641')
    expect(result.vat_lines[0].debit_amount).toBe(120) // 1120 * 0.12 / 1.12 = 120
  })

  it('produces valid MappingResult for expense with 6% VAT', () => {
    const template = getTemplate('travel_transport')
    const tx = makeTransaction({ amount: -530 })
    const result = buildMappingResultFromTemplate(template, tx, 'enskild_firma')

    expect(result.vat_lines).toHaveLength(1)
    expect(result.vat_lines[0].account_number).toBe('2641')
    expect(result.vat_lines[0].debit_amount).toBe(30) // 530 * 0.06 / 1.06 = 30
  })

  it('produces reverse charge lines for EU purchases (fiktiv moms + basbelopp)', () => {
    const template = getTemplate('it_saas_eu')
    const tx = makeTransaction({ amount: -1000 })
    const result = buildMappingResultFromTemplate(template, tx, 'enskild_firma')

    // Four lines: fiktiv-moms pair + basbelopp pair. Without the basbelopp
    // pair the deklaration is rejected with FK004 (ruta 30-32 without 20-24).
    expect(result.vat_lines).toHaveLength(4)
    // Fiktiv ingående moms (EU: 2645)
    expect(result.vat_lines[0].account_number).toBe('2645')
    expect(result.vat_lines[0].debit_amount).toBe(250)
    // Fiktiv utgående moms (25%: 2614)
    expect(result.vat_lines[1].account_number).toBe('2614')
    expect(result.vat_lines[1].credit_amount).toBe(250)
    // Basbelopp EU services 25% → ruta 21
    expect(result.vat_lines[2].account_number).toBe('4535')
    expect(result.vat_lines[2].debit_amount).toBe(1000)
    // Motkonto basbelopp
    expect(result.vat_lines[3].account_number).toBe('4598')
    expect(result.vat_lines[3].credit_amount).toBe(1000)
  })

  it('defaults to eu_business supplier type when not set on template', () => {
    // it_cloud_hosting has no explicit reverse_charge_supplier_type
    const template = getTemplate('it_cloud_hosting')
    const tx = makeTransaction({ amount: -800 })
    const result = buildMappingResultFromTemplate(template, tx, 'enskild_firma')

    expect(result.vat_lines).toHaveLength(4)
    // Defaults to EU services → 4535
    expect(result.vat_lines[2].account_number).toBe('4535')
    expect(result.vat_lines[2].debit_amount).toBe(800)
  })

  it('uses 4531 basbelopp for non-EU supplier type', () => {
    const template: BookingTemplate = {
      ...getTemplate('it_cloud_hosting'),
      reverse_charge_supplier_type: 'non_eu_business',
    }
    const tx = makeTransaction({ amount: -1000 })
    const result = buildMappingResultFromTemplate(template, tx, 'enskild_firma')

    expect(result.vat_lines).toHaveLength(4)
    expect(result.vat_lines[0].account_number).toBe('2645') // non-EU still uses 2645
    expect(result.vat_lines[2].account_number).toBe('4531') // non-EU services → ruta 22
  })

  it('uses 4425 basbelopp and 2647 for domestic (swedish) reverse charge', () => {
    const template: BookingTemplate = {
      ...getTemplate('it_cloud_hosting'),
      reverse_charge_supplier_type: 'swedish_business',
    }
    const tx = makeTransaction({ amount: -1000 })
    const result = buildMappingResultFromTemplate(template, tx, 'enskild_firma')

    expect(result.vat_lines).toHaveLength(4)
    // Domestic RC uses 2647 (ML 16 kap) for the input pair
    expect(result.vat_lines[0].account_number).toBe('2647')
    // Domestic services (byggtjänster) → 4425, ruta 24
    expect(result.vat_lines[2].account_number).toBe('4425')
  })

  it('skips basbelopp emission when template already debits a basis account', () => {
    const template: BookingTemplate = {
      ...getTemplate('it_cloud_hosting'),
      debit_account: '4535', // user-customized template that books directly to basis
    }
    const tx = makeTransaction({ amount: -1000 })
    const result = buildMappingResultFromTemplate(template, tx, 'enskild_firma')

    // Only the fiktiv-moms pair — basbelopp would double-count.
    expect(result.vat_lines).toHaveLength(2)
    expect(result.vat_lines[0].account_number).toBe('2645')
    expect(result.vat_lines[1].account_number).toBe('2614')
  })

  it('produces no VAT lines for exempt expenses', () => {
    const template = getTemplate('premises_rent')
    const tx = makeTransaction({ amount: -10000 })
    const result = buildMappingResultFromTemplate(template, tx, 'enskild_firma')

    expect(result.vat_lines).toHaveLength(0)
  })

  it('produces no VAT lines for non-deductible templates', () => {
    const template = getTemplate('private_withdrawal_ef')
    const tx = makeTransaction({ amount: -5000 })
    const result = buildMappingResultFromTemplate(template, tx, 'enskild_firma')

    expect(result.vat_lines).toHaveLength(0)
    expect(result.default_private).toBe(true)
  })

  it('produces output VAT lines for income with 25% VAT', () => {
    const template = getTemplate('revenue_standard_25')
    const tx = makeTransaction({ amount: 12500 })
    const result = buildMappingResultFromTemplate(template, tx, 'enskild_firma')

    expect(result.debit_account).toBe('1930')
    expect(result.credit_account).toBe('3001')
    expect(result.vat_lines).toHaveLength(1)
    expect(result.vat_lines[0].account_number).toBe('2611')
    expect(result.vat_lines[0].credit_amount).toBe(2500) // 12500 * 0.25 / 1.25 = 2500
  })

  it('produces output VAT lines for income with 12% VAT', () => {
    const template = getTemplate('revenue_reduced_12')
    const tx = makeTransaction({ amount: 1120 })
    const result = buildMappingResultFromTemplate(template, tx, 'enskild_firma')

    expect(result.vat_lines).toHaveLength(1)
    expect(result.vat_lines[0].account_number).toBe('2621')
    expect(result.vat_lines[0].credit_amount).toBe(120)
  })

  it('resolves AB-specific accounts for aktiebolag', () => {
    const template = getTemplate('education_course')
    const tx = makeTransaction({ amount: -5000 })

    const efResult = buildMappingResultFromTemplate(template, tx, 'enskild_firma')
    expect(efResult.debit_account).toBe('6991')

    const abResult = buildMappingResultFromTemplate(template, tx, 'aktiebolag')
    expect(abResult.debit_account).toBe('7610')
  })

  it('resolves AB-specific private account', () => {
    const template = getTemplate('private_expense')
    const tx = makeTransaction({ amount: -300 })

    const efResult = buildMappingResultFromTemplate(template, tx, 'enskild_firma')
    expect(efResult.debit_account).toBe('2013')

    const abResult = buildMappingResultFromTemplate(template, tx, 'aktiebolag')
    expect(abResult.debit_account).toBe('2893')
  })

  it('includes template_id in the MappingResult', () => {
    const template = getTemplate('bank_fees')
    const tx = makeTransaction({ amount: -49 })
    const result = buildMappingResultFromTemplate(template, tx, 'enskild_firma')

    expect(result.template_id).toBe('bank_fees')
    expect(result.rule).toBeNull()
  })

  it('sets description with template name and transaction description', () => {
    const template = getTemplate('vehicle_fuel')
    const tx = makeTransaction({ amount: -800, description: 'OKQ8 tankstation' })
    const result = buildMappingResultFromTemplate(template, tx, 'enskild_firma')

    expect(result.description).toBe('Drivmedel & Laddning: OKQ8 tankstation')
  })

  // Foreign-currency transactions: the mall must always emit SEK amounts
  // (issue #442). Previously buildMappingResultFromTemplate used
  // Math.abs(transaction.amount) — which is in the source currency — to
  // compute VAT lines, producing a verifikation in mixed currencies.
  it('emits SEK amounts when transaction currency is USD (issue #442)', () => {
    const template = getTemplate('it_saas_subscription') // 25% input VAT
    const tx = makeTransaction({
      amount: -125,           // -125 USD
      currency: 'USD',
      amount_sek: -1250,      // pre-converted to SEK
      exchange_rate: 10,
    })
    const result = buildMappingResultFromTemplate(template, tx, 'enskild_firma')

    // VAT line debit must be 250 SEK (1250 * 0.25 / 1.25), not 25 USD
    expect(result.vat_lines).toHaveLength(1)
    expect(result.vat_lines[0].account_number).toBe('2641')
    expect(result.vat_lines[0].debit_amount).toBe(250)
  })

  it('falls back to amount * exchange_rate when amount_sek is missing', () => {
    const template = getTemplate('it_saas_subscription')
    const tx = makeTransaction({
      amount: -100,
      currency: 'EUR',
      amount_sek: null,
      exchange_rate: 11.5,
    })
    const result = buildMappingResultFromTemplate(template, tx, 'enskild_firma')

    // 100 * 11.5 = 1150 SEK; 1150 * 0.25 / 1.25 = 230 SEK
    expect(result.vat_lines[0].debit_amount).toBe(230)
  })

  it('emits SEK amounts for EU reverse-charge on a non-SEK transaction', () => {
    const template = getTemplate('it_saas_eu')
    const tx = makeTransaction({
      amount: -100,
      currency: 'USD',
      amount_sek: -1000,
      exchange_rate: 10,
    })
    const result = buildMappingResultFromTemplate(template, tx, 'enskild_firma')

    // Fiktiv-moms pair sized at 25% of 1000 SEK = 250, not 25 USD
    expect(result.vat_lines).toHaveLength(4)
    expect(result.vat_lines[0].debit_amount).toBe(250)   // 2645
    expect(result.vat_lines[1].credit_amount).toBe(250)  // 2614
    expect(result.vat_lines[2].debit_amount).toBe(1000)  // 4535 basbelopp
    expect(result.vat_lines[3].credit_amount).toBe(1000) // 4608
  })

  it('emits SEK amounts for output VAT on non-SEK income', () => {
    const template = getTemplate('revenue_standard_25')
    const tx = makeTransaction({
      amount: 100,
      currency: 'USD',
      amount_sek: 1000,
      exchange_rate: 10,
    })
    const result = buildMappingResultFromTemplate(template, tx, 'enskild_firma')

    // Output VAT at 25% on 1000 SEK = 200, not 20 USD
    expect(result.vat_lines).toHaveLength(1)
    expect(result.vat_lines[0].account_number).toBe('2611')
    expect(result.vat_lines[0].credit_amount).toBe(200)
  })
})

// ============================================================
// Template Curation Helpers
// ============================================================

describe('getCommonTemplates', () => {
  it('returns only templates with common: true', () => {
    const common = getCommonTemplates()
    expect(common.length).toBeGreaterThan(0)
    for (const t of common) {
      expect(t.common).toBe(true)
    }
  })

  it('filters by entity type', () => {
    const efCommon = getCommonTemplates('enskild_firma')
    for (const t of efCommon) {
      expect(t.entity_applicability).not.toBe('aktiebolag')
    }
  })

  it('filters by direction', () => {
    const expenses = getCommonTemplates(undefined, 'expense')
    for (const t of expenses) {
      expect(t.direction).toBe('expense')
    }
  })
})

describe('getAdvancedTemplates', () => {
  it('returns only templates with common: false', () => {
    const advanced = getAdvancedTemplates()
    expect(advanced.length).toBeGreaterThan(0)
    for (const t of advanced) {
      expect(t.common).toBe(false)
    }
  })

  it('common + advanced = all templates (for a given entity/direction)', () => {
    const common = getCommonTemplates()
    const advanced = getAdvancedTemplates()
    expect(common.length + advanced.length).toBe(BOOKING_TEMPLATES.length)
  })
})

describe('validateTemplateForEntity', () => {
  it('accepts template with entity_applicability "all"', () => {
    const template = getTemplateById('premises_rent')!
    const result = validateTemplateForEntity(template, 'aktiebolag')
    expect(result.valid).toBe(true)
  })

  it('accepts EF template for EF entity', () => {
    const template = getTemplateById('private_withdrawal_ef')!
    const result = validateTemplateForEntity(template, 'enskild_firma')
    expect(result.valid).toBe(true)
  })

  it('rejects EF template for AB entity', () => {
    const template = getTemplateById('private_withdrawal_ef')!
    const result = validateTemplateForEntity(template, 'aktiebolag')
    expect(result.valid).toBe(false)
    expect(result.error).toContain('enskild_firma')
  })

  it('rejects AB template for EF entity', () => {
    const template = getTemplateById('personnel_salary')!
    const result = validateTemplateForEntity(template, 'enskild_firma')
    expect(result.valid).toBe(false)
    expect(result.error).toContain('aktiebolag')
  })
})

// ============================================================
// New/Split Templates
// ============================================================

describe('new and split templates', () => {
  it('has marketing_online_ads_eu with reverse_charge', () => {
    const t = getTemplateById('marketing_online_ads_eu')
    expect(t).toBeDefined()
    expect(t!.vat_treatment).toBe('reverse_charge')
    expect(t!.common).toBe(true)
    expect(t!.requires_vat_registration_data).toBe(true)
  })

  it('has marketing_online_ads_domestic with standard_25', () => {
    const t = getTemplateById('marketing_online_ads_domestic')
    expect(t).toBeDefined()
    expect(t!.vat_treatment).toBe('standard_25')
    expect(t!.common).toBe(false)
  })

  it('has representation_internal with account 7622', () => {
    const t = getTemplateById('representation_internal')
    expect(t).toBeDefined()
    expect(t!.debit_account).toBe('7622')
    expect(t!.vat_treatment).toBeNull()
    expect(t!.common).toBe(true)
  })

  it('has shareholder_loan_received (AB, D:1930 K:2393)', () => {
    const t = getTemplateById('shareholder_loan_received')
    expect(t).toBeDefined()
    expect(t!.debit_account).toBe('1930')
    expect(t!.credit_account).toBe('2393')
    expect(t!.entity_applicability).toBe('aktiebolag')
    expect(t!.common).toBe(true)
  })

  it('has shareholder_loan_disbursed (AB, D:1680 K:1930)', () => {
    const t = getTemplateById('shareholder_loan_disbursed')
    expect(t).toBeDefined()
    expect(t!.debit_account).toBe('1680')
    expect(t!.credit_account).toBe('1930')
    expect(t!.entity_applicability).toBe('aktiebolag')
    expect(t!.common).toBe(false)
  })

  it('personnel_employer_tax uses debit account 2731 (liability clearing)', () => {
    const t = getTemplateById('personnel_employer_tax')
    expect(t).toBeDefined()
    expect(t!.debit_account).toBe('2731')
  })

  it('personnel_salary has special_rules_sv warning', () => {
    const t = getTemplateById('personnel_salary')
    expect(t).toBeDefined()
    expect(t!.special_rules_sv).toContain('nettolön')
    expect(t!.requires_review).toBe(true)
  })

  it('representation_external has updated deductibility note with VAT cap', () => {
    const t = getTemplateById('representation_external')
    expect(t).toBeDefined()
    expect(t!.deductibility_note_sv).toContain('46 kr/person')
  })
})

// ============================================================
// applySettlementAccount — bank-leg routing for non-1930 accounts
// ============================================================

describe('applySettlementAccount (bank-leg routing)', () => {
  it('routes the bank_interest_income debit leg to the transaction settlement account', () => {
    const template = getTemplateById('bank_interest_income')
    expect(template).toBeDefined()
    const tx = makeTransaction({ amount: 50, currency: 'SEK' })
    const base = buildMappingResultFromTemplate(template!, tx, 'enskild_firma')
    // Template hardcodes 1930 as the bank leg.
    expect(base.debit_account).toBe('1930')
    expect(base.credit_account).toBe('8310')

    // Interest that landed on a savings account mapped to 1931 must debit 1931,
    // not 1930 — otherwise the real bank transaction never reconciles.
    const routed = applySettlementAccount(base, '1931')
    expect(routed.debit_account).toBe('1931')
    expect(routed.credit_account).toBe('8310')
  })

  it('routes the bank_fees credit leg to the transaction settlement account', () => {
    const template = getTemplateById('bank_fees')
    expect(template).toBeDefined()
    const tx = makeTransaction({ amount: -29, currency: 'SEK' })
    const base = buildMappingResultFromTemplate(template!, tx, 'enskild_firma')
    expect(base.debit_account).toBe('6570')
    expect(base.credit_account).toBe('1930')

    const routed = applySettlementAccount(base, '1931')
    expect(routed.debit_account).toBe('6570')
    expect(routed.credit_account).toBe('1931')
  })

  it('is a no-op when the settlement account is 1930 (legacy/unresolved rows)', () => {
    const template = getTemplateById('bank_interest_income')!
    const tx = makeTransaction({ amount: 50, currency: 'SEK' })
    const base = buildMappingResultFromTemplate(template, tx, 'enskild_firma')
    const routed = applySettlementAccount(base, '1930')
    expect(routed.debit_account).toBe('1930')
    expect(routed.credit_account).toBe('8310')
  })
})
