import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createMockSupabase, makeTransaction } from '@/tests/helpers'

// Mock Supabase
const { supabase: mockSupabase, mockResult } = createMockSupabase()

// Mock booking-templates (needed by evaluateMappingRules)
vi.mock('../booking-templates', () => ({
  findMatchingTemplates: vi.fn().mockReturnValue([]),
  buildMappingResultFromTemplate: vi.fn(),
}))

// Mock counterparty-templates (needed by evaluateMappingRules)
vi.mock('../counterparty-templates', () => ({
  findCounterpartyTemplate: vi.fn().mockResolvedValue(null),
  buildMappingResultFromCounterpartyTemplate: vi.fn(),
}))

describe('mapping-engine', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('saveUserMappingRule', () => {
    it('saves auto-learned rule without user description', async () => {
      const { saveUserMappingRule } = await import('../mapping-engine')

      mockResult({ data: null, error: null })

      await saveUserMappingRule(mockSupabase as never, 'user-1', 'ICA Maxi', '5410', '1930', false)

      // Verify insert was called via supabase.from().insert()
      expect(mockSupabase.from).toHaveBeenCalledWith('mapping_rules')
    })

    it('saves user-described rule with priority 5 and confidence 0.98', async () => {
      const { saveUserMappingRule } = await import('../mapping-engine')

      mockResult({ data: null, error: null })

      await saveUserMappingRule(
        mockSupabase as never,
        'user-1',
        'Restaurant XYZ',
        '6071',
        '1930',
        false,
        'business lunch with client',
        'restaurant_dining'
      )

      // Verify from was called (first for delete, then for insert)
      expect(mockSupabase.from).toHaveBeenCalledWith('mapping_rules')
    })

    it('does not throw on insert error (non-critical)', async () => {
      const { saveUserMappingRule } = await import('../mapping-engine')

      mockResult({ data: null, error: { message: 'DB error' } })

      // Should not throw
      await expect(
        saveUserMappingRule(mockSupabase as never, 'user-1', 'ICA Maxi', '5410', '1930', false)
      ).resolves.toBeUndefined()
    })

    it('escapes special regex characters in merchant name', async () => {
      const { saveUserMappingRule } = await import('../mapping-engine')

      mockResult({ data: null, error: null })

      // Merchant name with regex special chars
      await saveUserMappingRule(mockSupabase as never, 'user-1', 'Test (Pty) Ltd.', '5410', '1930', false)

      expect(mockSupabase.from).toHaveBeenCalledWith('mapping_rules')
    })
  })

  describe('evaluateMappingRules', () => {
    // Full mapping_rules row for pattern-matching tests; override per case.
    const makeRule = (overrides: Record<string, unknown>) => ({
      id: 'rule-1',
      user_id: null,
      rule_name: 'Pattern rule',
      rule_type: 'description',
      priority: 100,
      mcc_codes: null,
      merchant_pattern: null,
      description_pattern: null,
      amount_min: null,
      amount_max: null,
      debit_account: '6540',
      credit_account: '1930',
      vat_treatment: null,
      vat_debit_account: null,
      vat_credit_account: null,
      risk_level: 'LOW',
      default_private: false,
      requires_review: false,
      confidence_score: 0.9,
      capitalization_threshold: null,
      capitalized_debit_account: null,
      is_active: true,
      source: 'system',
      user_description: null,
      template_id: null,
      created_at: '2024-01-01',
      updated_at: '2024-01-01',
      ...overrides,
    })

    it('matches a description_pattern that only appears in original_description', async () => {
      // The ingest boundary strips the trailing channel phrase off the working
      // title; a rule written against the bank's full text must keep firing
      // via the immutable original.
      const { evaluateMappingRules } = await import('../mapping-engine')

      const tx = makeTransaction({
        amount: -100,
        merchant_name: null,
        description: 'Vercel Jul',
        original_description: 'Vercel Jul Överföring via internet',
      })
      mockResult({
        data: [makeRule({ description_pattern: 'Överföring via internet' })],
        error: null,
      })

      const result = await evaluateMappingRules(mockSupabase as never, 'user-1', tx)
      expect(result.debit_account).toBe('6540')
    })

    it('matches a merchant_pattern that only appears in original_description', async () => {
      const { evaluateMappingRules } = await import('../mapping-engine')

      const tx = makeTransaction({
        amount: -100,
        merchant_name: null,
        description: 'SPOTIFY AB',
        original_description: 'SPOTIFY AB Kortköp',
      })
      mockResult({
        data: [makeRule({ rule_type: 'merchant_name', merchant_pattern: 'Kortköp' })],
        error: null,
      })

      const result = await evaluateMappingRules(mockSupabase as never, 'user-1', tx)
      expect(result.debit_account).toBe('6540')
    })

    it('invalid-regex substring fallback also scans original_description', async () => {
      const { evaluateMappingRules } = await import('../mapping-engine')

      // 'fee (2026' is an invalid regex (unclosed group) and a literal
      // substring of the original only.
      const tx = makeTransaction({
        amount: -100,
        merchant_name: null,
        description: 'Stripe: Billing - Usage Fee',
        original_description: 'Stripe: Billing - Usage Fee (2026-07-26)',
      })
      mockResult({
        data: [makeRule({ description_pattern: 'fee (2026' })],
        error: null,
      })

      const result = await evaluateMappingRules(mockSupabase as never, 'user-1', tx)
      expect(result.debit_account).toBe('6540')
    })

    it('does not match when the pattern appears in neither description nor original', async () => {
      const { evaluateMappingRules } = await import('../mapping-engine')

      const tx = makeTransaction({
        amount: -100,
        merchant_name: null,
        description: 'Vercel Jul',
        original_description: 'Vercel Jul Överföring via internet',
      })
      mockResult({
        data: [makeRule({ description_pattern: 'Kortköp' })],
        error: null,
      })

      const result = await evaluateMappingRules(mockSupabase as never, 'user-1', tx)
      expect(result.debit_account).toBe('6991') // default expense fallback
    })

    it('returns default result when no rules match (expense)', async () => {
      const { evaluateMappingRules } = await import('../mapping-engine')

      const tx = makeTransaction({ amount: -100, merchant_name: 'Unknown' })
      mockResult({ data: [], error: null })

      const result = await evaluateMappingRules(mockSupabase as never, 'user-1', tx)

      expect(result.debit_account).toBe('6991')
      expect(result.credit_account).toBe('1930')
      expect(result.confidence).toBe(0.1)
      expect(result.requires_review).toBe(true)
    })

    it('returns VAT-neutral 3900 as default income account (not 3001)', async () => {
      const { evaluateMappingRules } = await import('../mapping-engine')

      const tx = makeTransaction({ amount: 500, merchant_name: 'Unknown' })
      mockResult({ data: [], error: null })

      const result = await evaluateMappingRules(mockSupabase as never, 'user-1', tx)

      expect(result.debit_account).toBe('1930')
      expect(result.credit_account).toBe('3900')
      expect(result.requires_review).toBe(true)
    })

    it('uses 2893 for default_private with aktiebolag entity type', async () => {
      const { evaluateMappingRules } = await import('../mapping-engine')

      const tx = makeTransaction({ amount: -500, merchant_name: 'Private Purchase' })
      mockResult({
        data: [
          {
            id: 'rule-private',
            user_id: null,
            rule_name: 'Private fallback',
            rule_type: 'merchant_name',
            priority: 100,
            mcc_codes: null,
            merchant_pattern: 'Private',
            description_pattern: null,
            amount_min: null,
            amount_max: null,
            debit_account: null,
            credit_account: null,
            vat_treatment: null,
            vat_debit_account: null,
            vat_credit_account: null,
            risk_level: 'LOW',
            default_private: true,
            requires_review: false,
            confidence_score: 0.8,
            capitalization_threshold: null,
            capitalized_debit_account: null,
            is_active: true,
            source: 'system',
            user_description: null,
            template_id: null,
            created_at: '2024-01-01',
            updated_at: '2024-01-01',
          },
        ],
        error: null,
      })

      const result = await evaluateMappingRules(mockSupabase as never, 'user-1', tx, 'aktiebolag')
      expect(result.debit_account).toBe('2893')
      expect(result.default_private).toBe(true)
    })

    it('uses 2013 for default_private with enskild_firma entity type', async () => {
      const { evaluateMappingRules } = await import('../mapping-engine')

      const tx = makeTransaction({ amount: -500, merchant_name: 'Private Purchase' })
      mockResult({
        data: [
          {
            id: 'rule-private',
            user_id: null,
            rule_name: 'Private fallback',
            rule_type: 'merchant_name',
            priority: 100,
            mcc_codes: null,
            merchant_pattern: 'Private',
            description_pattern: null,
            amount_min: null,
            amount_max: null,
            debit_account: null,
            credit_account: null,
            vat_treatment: null,
            vat_debit_account: null,
            vat_credit_account: null,
            risk_level: 'LOW',
            default_private: true,
            requires_review: false,
            confidence_score: 0.8,
            capitalization_threshold: null,
            capitalized_debit_account: null,
            is_active: true,
            source: 'system',
            user_description: null,
            template_id: null,
            created_at: '2024-01-01',
            updated_at: '2024-01-01',
          },
        ],
        error: null,
      })

      const result = await evaluateMappingRules(mockSupabase as never, 'user-1', tx, 'enskild_firma')
      expect(result.debit_account).toBe('2013')
    })

    it('applies year-based capitalization threshold from prisbasbelopp', async () => {
      const { evaluateMappingRules } = await import('../mapping-engine')

      // 2024 threshold = 28,650. This amount exceeds it.
      const tx = makeTransaction({
        amount: -30000,
        date: '2024-06-15',
        merchant_name: 'Equipment Store',
      })

      mockResult({
        data: [
          {
            id: 'rule-cap',
            user_id: null,
            rule_name: 'Equipment',
            rule_type: 'merchant_name',
            priority: 50,
            mcc_codes: null,
            merchant_pattern: 'Equipment',
            description_pattern: null,
            amount_min: null,
            amount_max: null,
            debit_account: '5410',
            credit_account: '1930',
            vat_treatment: null,
            vat_debit_account: null,
            vat_credit_account: null,
            risk_level: 'LOW',
            default_private: false,
            requires_review: false,
            confidence_score: 0.9,
            capitalization_threshold: null,
            capitalized_debit_account: '1250',
            is_active: true,
            source: 'system',
            user_description: null,
            template_id: null,
            created_at: '2024-01-01',
            updated_at: '2024-01-01',
          },
        ],
        error: null,
      })

      const result = await evaluateMappingRules(mockSupabase as never, 'user-1', tx)
      // 30,000 > 28,650 (2024 half-PBB) → should capitalize to 1250
      expect(result.debit_account).toBe('1250')
    })

    it('uses 2025 threshold for 2025 transactions', async () => {
      const { evaluateMappingRules } = await import('../mapping-engine')

      // 2025 threshold = 29,400. Amount of 29,000 is below it.
      const tx = makeTransaction({
        amount: -29000,
        date: '2025-03-15',
        merchant_name: 'Equipment Store',
      })

      mockResult({
        data: [
          {
            id: 'rule-cap',
            user_id: null,
            rule_name: 'Equipment',
            rule_type: 'merchant_name',
            priority: 50,
            mcc_codes: null,
            merchant_pattern: 'Equipment',
            description_pattern: null,
            amount_min: null,
            amount_max: null,
            debit_account: '5410',
            credit_account: '1930',
            vat_treatment: null,
            vat_debit_account: null,
            vat_credit_account: null,
            risk_level: 'LOW',
            default_private: false,
            requires_review: false,
            confidence_score: 0.9,
            capitalization_threshold: null,
            capitalized_debit_account: '1250',
            is_active: true,
            source: 'system',
            user_description: null,
            template_id: null,
            created_at: '2024-01-01',
            updated_at: '2024-01-01',
          },
        ],
        error: null,
      })

      const result = await evaluateMappingRules(mockSupabase as never, 'user-1', tx)
      // 29,000 < 29,400 (2025 half-PBB) → should NOT capitalize
      expect(result.debit_account).toBe('5410')
    })

    it('matches merchant_pattern rule', async () => {
      const { evaluateMappingRules } = await import('../mapping-engine')

      const tx = makeTransaction({
        amount: -299,
        merchant_name: 'ICA Maxi',
        description: 'ICA MAXI STOCKHOLM',
      })

      mockResult({
        data: [
          {
            id: 'rule-1',
            user_id: 'user-1',
            rule_name: 'Learned: ICA Maxi',
            rule_type: 'merchant_name',
            priority: 10,
            mcc_codes: null,
            merchant_pattern: 'ICA Maxi',
            description_pattern: null,
            amount_min: null,
            amount_max: null,
            debit_account: '5410',
            credit_account: '1930',
            vat_treatment: null,
            vat_debit_account: null,
            vat_credit_account: null,
            risk_level: 'NONE',
            default_private: false,
            requires_review: false,
            confidence_score: 0.95,
            capitalization_threshold: null,
            capitalized_debit_account: null,
            is_active: true,
            source: 'auto',
            user_description: null,
            template_id: null,
            created_at: '2024-01-01',
            updated_at: '2024-01-01',
          },
        ],
        error: null,
      })

      const result = await evaluateMappingRules(mockSupabase as never, 'user-1', tx)

      expect(result.debit_account).toBe('5410')
      expect(result.credit_account).toBe('1930')
      expect(result.confidence).toBe(0.95)
    })

    it('emits both fiktiv-moms and basbelopp lines for reverse_charge rules', async () => {
      const { evaluateMappingRules } = await import('../mapping-engine')

      const tx = makeTransaction({
        amount: -1000,
        merchant_name: 'AWS',
        description: 'AWS EU-WEST-1',
      })

      mockResult({
        data: [
          {
            id: 'rule-rc',
            user_id: 'user-1',
            rule_name: 'AWS reverse charge',
            rule_type: 'merchant_name',
            priority: 10,
            mcc_codes: null,
            merchant_pattern: 'AWS',
            description_pattern: null,
            amount_min: null,
            amount_max: null,
            debit_account: '5421',
            credit_account: '1930',
            vat_treatment: 'reverse_charge',
            vat_debit_account: null,
            vat_credit_account: null,
            risk_level: 'LOW',
            default_private: false,
            requires_review: false,
            confidence_score: 0.9,
            capitalization_threshold: null,
            capitalized_debit_account: null,
            is_active: true,
            source: 'system',
            user_description: null,
            template_id: null,
            created_at: '2024-01-01',
            updated_at: '2024-01-01',
          },
        ],
        error: null,
      })

      const result = await evaluateMappingRules(mockSupabase as never, 'user-1', tx)

      // Fiktiv-moms pair + basbelopp pair = 4 lines (FK004 guard)
      expect(result.vat_lines).toHaveLength(4)
      expect(result.vat_lines[0].account_number).toBe('2645')
      expect(result.vat_lines[0].debit_amount).toBe(250)
      expect(result.vat_lines[1].account_number).toBe('2614')
      expect(result.vat_lines[1].credit_amount).toBe(250)
      expect(result.vat_lines[2].account_number).toBe('4535')
      expect(result.vat_lines[2].debit_amount).toBe(1000)
      expect(result.vat_lines[3].account_number).toBe('4598')
      expect(result.vat_lines[3].credit_amount).toBe(1000)
    })

    it('skips basbelopp emission when rule already debits a basis account', async () => {
      const { evaluateMappingRules } = await import('../mapping-engine')

      const tx = makeTransaction({
        amount: -1000,
        merchant_name: 'AWS',
      })

      mockResult({
        data: [
          {
            id: 'rule-rc-basis',
            user_id: 'user-1',
            rule_name: 'AWS RC to basis',
            rule_type: 'merchant_name',
            priority: 10,
            mcc_codes: null,
            merchant_pattern: 'AWS',
            description_pattern: null,
            amount_min: null,
            amount_max: null,
            debit_account: '4535',
            credit_account: '1930',
            vat_treatment: 'reverse_charge',
            vat_debit_account: null,
            vat_credit_account: null,
            risk_level: 'LOW',
            default_private: false,
            requires_review: false,
            confidence_score: 0.9,
            capitalization_threshold: null,
            capitalized_debit_account: null,
            is_active: true,
            source: 'system',
            user_description: null,
            template_id: null,
            created_at: '2024-01-01',
            updated_at: '2024-01-01',
          },
        ],
        error: null,
      })

      const result = await evaluateMappingRules(mockSupabase as never, 'user-1', tx)

      // Only fiktiv-moms pair: basbelopp already covered by the expense line
      expect(result.vat_lines).toHaveLength(2)
      expect(result.vat_lines[0].account_number).toBe('2645')
      expect(result.vat_lines[1].account_number).toBe('2614')
    })

    // Journal entry lines are SEK; VAT from a rule match must be derived from
    // the transaction's SEK value, not the raw foreign amount. Sibling of the
    // buildMappingResultFromCategory FX fix (PR #1842).
    it('derives rule input VAT from the SEK value for a foreign transaction', async () => {
      const { evaluateMappingRules } = await import('../mapping-engine')

      const tx = makeTransaction({
        amount: -100,
        currency: 'EUR',
        exchange_rate: 11,
        merchant_name: 'Adobe',
        description: 'ADOBE SYSTEMS',
      })

      mockResult({
        data: [
          {
            id: 'rule-fx-vat',
            user_id: 'user-1',
            rule_name: 'Adobe standard VAT',
            rule_type: 'merchant_name',
            priority: 10,
            mcc_codes: null,
            merchant_pattern: 'Adobe',
            description_pattern: null,
            amount_min: null,
            amount_max: null,
            debit_account: '5420',
            credit_account: '1930',
            vat_treatment: 'standard_25',
            vat_debit_account: '2641',
            vat_credit_account: null,
            risk_level: 'LOW',
            default_private: false,
            requires_review: false,
            confidence_score: 0.9,
            capitalization_threshold: null,
            capitalized_debit_account: null,
            is_active: true,
            source: 'system',
            user_description: null,
            template_id: null,
            created_at: '2024-01-01',
            updated_at: '2024-01-01',
          },
        ],
        error: null,
      })

      const result = await evaluateMappingRules(mockSupabase as never, 'user-1', tx)

      // 100 EUR at 11 = 1100 kr gross; 25% extraction = 220 kr, not 20
      expect(result.vat_lines).toHaveLength(1)
      expect(result.vat_lines[0].account_number).toBe('2641')
      expect(result.vat_lines[0].debit_amount).toBe(220)
    })

    it('derives reverse-charge fiktiv moms and basbelopp from the SEK value (amount_sek wins)', async () => {
      const { evaluateMappingRules } = await import('../mapping-engine')

      const tx = makeTransaction({
        amount: -100,
        currency: 'USD',
        // bank settlement wins over exchange_rate, matching the gross line
        amount_sek: -950,
        exchange_rate: 10,
        merchant_name: 'AWS',
        description: 'AWS EU-WEST-1',
      })

      mockResult({
        data: [
          {
            id: 'rule-rc-fx',
            user_id: 'user-1',
            rule_name: 'AWS reverse charge',
            rule_type: 'merchant_name',
            priority: 10,
            mcc_codes: null,
            merchant_pattern: 'AWS',
            description_pattern: null,
            amount_min: null,
            amount_max: null,
            debit_account: '5421',
            credit_account: '1930',
            vat_treatment: 'reverse_charge',
            vat_debit_account: null,
            vat_credit_account: null,
            risk_level: 'LOW',
            default_private: false,
            requires_review: false,
            confidence_score: 0.9,
            capitalization_threshold: null,
            capitalized_debit_account: null,
            is_active: true,
            source: 'system',
            user_description: null,
            template_id: null,
            created_at: '2024-01-01',
            updated_at: '2024-01-01',
          },
        ],
        error: null,
      })

      const result = await evaluateMappingRules(mockSupabase as never, 'user-1', tx)

      // 950 kr gross: fiktiv moms 237.50, basbelopp 950 (not 25/100 off USD)
      expect(result.vat_lines).toHaveLength(4)
      expect(result.vat_lines[0].account_number).toBe('2645')
      expect(result.vat_lines[0].debit_amount).toBe(237.5)
      expect(result.vat_lines[1].account_number).toBe('2614')
      expect(result.vat_lines[1].credit_amount).toBe(237.5)
      expect(result.vat_lines[2].debit_amount).toBe(950)
      expect(result.vat_lines[3].credit_amount).toBe(950)
    })
  })

  // Both the halva-prisbasbeloppet threshold (IL 18 kap 4 §) and a rule's
  // amount_min/amount_max band are SEK figures. Before the fix they were
  // compared against the raw transaction amount, so a 3000 EUR laptop
  // (about 34 500 kr) read as under the 29 600 kr limit for 2026 and was
  // expensed to 5410 instead of capitalised to 1250.
  describe('SEK thresholds on foreign-currency transactions', () => {
    function makeRule(overrides: Record<string, unknown> = {}) {
      return {
        id: 'rule-cap',
        user_id: null,
        rule_name: 'Equipment',
        rule_type: 'merchant_name',
        priority: 50,
        mcc_codes: null,
        merchant_pattern: 'Equipment',
        description_pattern: null,
        amount_min: null,
        amount_max: null,
        debit_account: '5410',
        credit_account: '1930',
        vat_treatment: null,
        vat_debit_account: null,
        vat_credit_account: null,
        risk_level: 'LOW',
        default_private: false,
        requires_review: false,
        confidence_score: 0.9,
        capitalization_threshold: null,
        capitalized_debit_account: '1250',
        is_active: true,
        source: 'system',
        user_description: null,
        template_id: null,
        created_at: '2024-01-01',
        updated_at: '2024-01-01',
        ...overrides,
      }
    }

    it('capitalizes a SEK 34 500 laptop (over the 2026 half-PBB of 29 600)', async () => {
      const { evaluateMappingRules } = await import('../mapping-engine')

      const tx = makeTransaction({
        amount: -34500,
        currency: 'SEK',
        date: '2026-06-15',
        merchant_name: 'Equipment Store',
      })
      mockResult({ data: [makeRule()], error: null })

      const result = await evaluateMappingRules(mockSupabase as never, 'user-1', tx)

      expect(result.debit_account).toBe('1250')
      expect(result.requires_review).toBe(false)
    })

    it('expenses a SEK 20 000 laptop (under the 2026 half-PBB of 29 600)', async () => {
      const { evaluateMappingRules } = await import('../mapping-engine')

      const tx = makeTransaction({
        amount: -20000,
        currency: 'SEK',
        date: '2026-06-15',
        merchant_name: 'Equipment Store',
      })
      mockResult({ data: [makeRule()], error: null })

      const result = await evaluateMappingRules(mockSupabase as never, 'user-1', tx)

      expect(result.debit_account).toBe('5410')
      expect(result.requires_review).toBe(false)
    })

    it('capitalizes a 3000 EUR laptop when an exchange_rate is present', async () => {
      const { evaluateMappingRules } = await import('../mapping-engine')

      // 3000 EUR * 11.5 = 34 500 kr, over the 29 600 kr limit.
      const tx = makeTransaction({
        amount: -3000,
        currency: 'EUR',
        amount_sek: null,
        exchange_rate: 11.5,
        date: '2026-06-15',
        merchant_name: 'Equipment Store',
      })
      mockResult({ data: [makeRule()], error: null })

      const result = await evaluateMappingRules(mockSupabase as never, 'user-1', tx)

      expect(result.debit_account).toBe('1250')
      expect(result.requires_review).toBe(false)
    })

    it('capitalizes a 3000 EUR laptop when amount_sek is pre-computed', async () => {
      const { evaluateMappingRules } = await import('../mapping-engine')

      const tx = makeTransaction({
        amount: -3000,
        currency: 'EUR',
        amount_sek: -34500,
        exchange_rate: null,
        date: '2026-06-15',
        merchant_name: 'Equipment Store',
      })
      mockResult({ data: [makeRule()], error: null })

      const result = await evaluateMappingRules(mockSupabase as never, 'user-1', tx)

      expect(result.debit_account).toBe('1250')
    })

    it('does not silently expense a 3000 EUR laptop with no rate: declines to auto-classify', async () => {
      const { evaluateMappingRules } = await import('../mapping-engine')

      const tx = makeTransaction({
        amount: -3000,
        currency: 'EUR',
        amount_sek: null,
        exchange_rate: null,
        date: '2026-06-15',
        merchant_name: 'Equipment Store',
      })
      mockResult({ data: [makeRule()], error: null })

      const result = await evaluateMappingRules(mockSupabase as never, 'user-1', tx)

      // The rule alone would auto-book (confidence 0.9, requires_review false).
      // Without a SEK value the capitalization branch is a guess, so the
      // result must land under the 0.8 auto-book bar and explain itself.
      expect(result.requires_review).toBe(true)
      expect(result.confidence).toBeLessThan(0.8)
      expect(result.description).toContain('växelkurs saknas')
    })

    it('leaves rules that cannot capitalize untouched when no rate is available', async () => {
      const { evaluateMappingRules } = await import('../mapping-engine')

      const tx = makeTransaction({
        amount: -3000,
        currency: 'EUR',
        amount_sek: null,
        exchange_rate: null,
        date: '2026-06-15',
        merchant_name: 'Equipment Store',
      })
      mockResult({ data: [makeRule({ capitalized_debit_account: null })], error: null })

      const result = await evaluateMappingRules(mockSupabase as never, 'user-1', tx)

      // No capitalization decision to make: the missing rate is irrelevant.
      expect(result.debit_account).toBe('5410')
      expect(result.requires_review).toBe(false)
      expect(result.confidence).toBe(0.9)
    })

    it('evaluates a user amount band against SEK, not the foreign amount', async () => {
      const { evaluateMappingRules } = await import('../mapping-engine')

      // 3000 EUR = 34 500 kr, well over the rule's 5 000 kr ceiling. The raw
      // amount (3000) would have slipped under it.
      const tx = makeTransaction({
        amount: -3000,
        currency: 'EUR',
        amount_sek: null,
        exchange_rate: 11.5,
        date: '2026-06-15',
        merchant_name: 'Equipment Store',
      })
      mockResult({
        data: [
          makeRule({
            rule_name: 'Small equipment',
            amount_max: 5000,
            capitalized_debit_account: null,
          }),
        ],
        error: null,
      })

      const result = await evaluateMappingRules(mockSupabase as never, 'user-1', tx)

      // No match: falls through to the uncategorized default.
      expect(result.rule).toBeNull()
      expect(result.debit_account).toBe('6991')
      expect(result.requires_review).toBe(true)
    })

    it('matches a user amount band when the SEK value falls inside it', async () => {
      const { evaluateMappingRules } = await import('../mapping-engine')

      // 100 EUR * 11.5 = 1 150 kr, inside the 1 000-5 000 kr band.
      const tx = makeTransaction({
        amount: -100,
        currency: 'EUR',
        amount_sek: null,
        exchange_rate: 11.5,
        date: '2026-06-15',
        merchant_name: 'Equipment Store',
      })
      mockResult({
        data: [
          makeRule({
            rule_name: 'Small equipment',
            amount_min: 1000,
            amount_max: 5000,
            capitalized_debit_account: null,
          }),
        ],
        error: null,
      })

      const result = await evaluateMappingRules(mockSupabase as never, 'user-1', tx)

      expect(result.debit_account).toBe('5410')
      expect(result.confidence).toBe(0.9)
    })

    it('skips an amount-band rule when the transaction has no SEK value', async () => {
      const { evaluateMappingRules } = await import('../mapping-engine')

      const tx = makeTransaction({
        amount: -3000,
        currency: 'EUR',
        amount_sek: null,
        exchange_rate: null,
        date: '2026-06-15',
        merchant_name: 'Equipment Store',
      })
      mockResult({
        data: [
          makeRule({
            rule_name: 'Small equipment',
            amount_max: 5000,
            capitalized_debit_account: null,
          }),
        ],
        error: null,
      })

      const result = await evaluateMappingRules(mockSupabase as never, 'user-1', tx)

      // The band is unevaluable, so the rule does not apply. The transaction
      // lands in the uncategorized default where the user picks it up.
      expect(result.rule).toBeNull()
      expect(result.requires_review).toBe(true)
    })

    it('still applies SEK amount bands unchanged for SEK transactions', async () => {
      const { evaluateMappingRules } = await import('../mapping-engine')

      const tx = makeTransaction({
        amount: -3000,
        currency: 'SEK',
        date: '2026-06-15',
        merchant_name: 'Equipment Store',
      })
      mockResult({
        data: [
          makeRule({
            rule_name: 'Small equipment',
            amount_min: 1000,
            amount_max: 5000,
            capitalized_debit_account: null,
          }),
        ],
        error: null,
      })

      const result = await evaluateMappingRules(mockSupabase as never, 'user-1', tx)

      expect(result.debit_account).toBe('5410')
    })
  })
})
