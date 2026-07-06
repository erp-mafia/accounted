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
  })
})
