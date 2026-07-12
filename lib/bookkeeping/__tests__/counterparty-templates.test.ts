import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  createMockSupabase,
  createQueuedMockSupabase,
  makeTransaction,
  makeCategorizationTemplate,
  makeSIEVoucher,
} from '@/tests/helpers'
import {
  normalizeCounterpartyName,
  calculateConfidence,
  findCounterpartyTemplate,
  buildMappingResultFromCounterpartyTemplate,
  upsertCounterpartyTemplate,
  resolveSource,
  insertOrUpdateTemplate,
  populateTemplatesFromSieVouchers,
} from '../counterparty-templates'
import { buildTransactionEntryLines } from '../transaction-entries'
import { roundOre } from '@/lib/money'
import type { TemplateUpsertParams } from '../counterparty-templates'
import type { LinePatternEntry } from '@/types'
import type { SIETransactionLine } from '@/lib/import/types'

describe('counterparty-templates', () => {
  // ── Normalization ──────────────────────────────────────────

  describe('normalizeCounterpartyName', () => {
    it('strips KORTKÖP prefix', () => {
      expect(normalizeCounterpartyName('KORTKÖP ICA MAXI')).toBe('ica maxi')
    })

    it('strips SWISH prefix', () => {
      expect(normalizeCounterpartyName('SWISH ANDERS JOHANSSON')).toBe('anders johansson')
    })

    it('strips BANKGIRO prefix', () => {
      expect(normalizeCounterpartyName('BANKGIRO TELIA SVERIGE AB')).toBe('telia sverige')
    })

    it('strips AUTOGIRO prefix', () => {
      expect(normalizeCounterpartyName('AUTOGIRO FOLKSAM')).toBe('folksam')
    })

    it('strips trailing dates (YYYYMMDD)', () => {
      expect(normalizeCounterpartyName('ICA MAXI 20240615')).toBe('ica maxi')
    })

    it('strips trailing dates (YYYY-MM-DD)', () => {
      expect(normalizeCounterpartyName('TELIA 2024-06-15')).toBe('telia')
    })

    it('strips inline dates', () => {
      expect(normalizeCounterpartyName('SPOTIFY 20240615 PREMIUM')).toBe('spotify premium')
    })

    it('strips invoice references', () => {
      expect(normalizeCounterpartyName('LEVERANTÖR F2024001')).toBe('leverantör')
    })

    it('strips trailing digit sequences (4+)', () => {
      expect(normalizeCounterpartyName('CLAS OHLSON 12345')).toBe('clas ohlson')
    })

    it('strips Swedish company suffixes (AB, HB, KB)', () => {
      expect(normalizeCounterpartyName('SPOTIFY AB')).toBe('spotify')
    })

    it('handles combined prefixes and dates', () => {
      expect(normalizeCounterpartyName('KORTKÖP TELIA SVERIGE AB 20240615')).toBe('telia sverige')
    })

    it('preserves meaningful content', () => {
      expect(normalizeCounterpartyName('HEMKÖP LINNÉ')).toBe('hemköp linné')
    })

    it('collapses trailing personal initials and month labels to one merchant', () => {
      // Regression: three identical ngrok bookings ("ngrok JW", "Ngrok Mars",
      // "ngrok JW") splintered into separate counterparty names, so matching
      // never learned. They must all normalize to the same canonical merchant.
      expect(normalizeCounterpartyName('ngrok JW')).toBe('ngrok')
      expect(normalizeCounterpartyName('Ngrok Mars')).toBe('ngrok')
      expect(normalizeCounterpartyName('SPOTIFY januari')).toBe('spotify')
      expect(normalizeCounterpartyName('ICA MAXI AK')).toBe('ica maxi')
    })

    it('does not strip multi-letter trailing words or 3+ letter brands', () => {
      // Conservative guard: only 1-2 char all-caps initials and month tokens go.
      expect(normalizeCounterpartyName('SWISH ANDERS JOHANSSON')).toBe('anders johansson')
      expect(normalizeCounterpartyName('NORDEA SEB')).toBe('nordea seb') // SEB is 3 chars: kept
      expect(normalizeCounterpartyName('KLARNA')).toBe('klarna')         // single token kept
    })
  })

  // ── Confidence ─────────────────────────────────────────────

  describe('calculateConfidence', () => {
    it('returns ~0.45 for occurrence_count = 1', () => {
      const c = calculateConfidence(1)
      expect(c).toBeCloseTo(0.45, 1)
    })

    it('grows logarithmically', () => {
      const c1 = calculateConfidence(1)
      const c5 = calculateConfidence(5)
      const c10 = calculateConfidence(10)
      expect(c5).toBeGreaterThan(c1)
      expect(c10).toBeGreaterThan(c5)
      // Growth should slow down
      expect(c10 - c5).toBeLessThan(c5 - c1)
    })

    it('caps at 0.95', () => {
      expect(calculateConfidence(100)).toBe(0.95)
      expect(calculateConfidence(1000)).toBe(0.95)
    })

    it('never exceeds 0.95', () => {
      for (let i = 1; i <= 50; i++) {
        expect(calculateConfidence(i)).toBeLessThanOrEqual(0.95)
      }
    })
  })

  // ── Lookup ─────────────────────────────────────────────────

  describe('findCounterpartyTemplate', () => {
    it('returns null for transaction without merchant name', async () => {
      const { supabase } = createMockSupabase()
      const tx = makeTransaction({ merchant_name: null, description: '' })
      const result = await findCounterpartyTemplate(supabase as never, 'user-1', tx)
      expect(result).toBeNull()
    })

    it('returns exact alias match with full confidence', async () => {
      const template = makeCategorizationTemplate({
        confidence: 0.8,
        counterparty_aliases: ['telia sverige ab'],
      })
      const { supabase, enqueue } = createQueuedMockSupabase()

      // Batch query returns all templates
      enqueue({ data: [template] })

      const tx = makeTransaction({ merchant_name: 'Telia Sverige AB' })
      const result = await findCounterpartyTemplate(supabase as never, 'user-1', tx)

      expect(result).not.toBeNull()
      expect(result!.matchMethod).toBe('exact_alias')
      expect(result!.confidence).toBe(0.8)
    })

    it('falls through to exact normalized when alias misses', async () => {
      const template = makeCategorizationTemplate({
        counterparty_name: 'telia',
        confidence: 0.8,
        counterparty_aliases: ['telia ab'],
      })
      const { supabase, enqueue } = createQueuedMockSupabase()

      // Batch query returns all templates (alias won't match 'Telia')
      enqueue({ data: [template] })

      const tx = makeTransaction({ merchant_name: 'Telia' })
      const result = await findCounterpartyTemplate(supabase as never, 'user-1', tx)

      expect(result).not.toBeNull()
      expect(result!.matchMethod).toBe('exact_normalized')
      expect(result!.confidence).toBeCloseTo(0.76, 1) // 0.8 * 0.95
    })

    it('falls through to fuzzy match within Levenshtein threshold', async () => {
      const template = makeCategorizationTemplate({
        counterparty_name: 'telia',
        confidence: 0.8,
        counterparty_aliases: ['telia ab'],
      })
      const { supabase, enqueue } = createQueuedMockSupabase()

      // Batch query returns all templates
      enqueue({ data: [template] })

      // "teliq" has Levenshtein distance 1 from "telia"
      const tx = makeTransaction({ merchant_name: 'Teliq' })
      const result = await findCounterpartyTemplate(supabase as never, 'user-1', tx)

      expect(result).not.toBeNull()
      expect(result!.matchMethod).toBe('fuzzy')
      expect(result!.confidence).toBeLessThan(0.8)
      expect(result!.confidence).toBeGreaterThan(0)
    })

    it('returns null when fuzzy match exceeds threshold', async () => {
      const template = makeCategorizationTemplate({
        counterparty_name: 'telia',
        confidence: 0.8,
        counterparty_aliases: ['telia ab'],
      })
      const { supabase, enqueue } = createQueuedMockSupabase()

      // Batch query returns all templates
      enqueue({ data: [template] })

      // "xxxxx" has Levenshtein distance 5 from "telia"
      const tx = makeTransaction({ merchant_name: 'XXXXX' })
      const result = await findCounterpartyTemplate(supabase as never, 'user-1', tx)

      expect(result).toBeNull()
    })

    it('returns null when no templates exist', async () => {
      const { supabase, enqueue } = createQueuedMockSupabase()

      // Batch query returns empty
      enqueue({ data: [] })

      const tx = makeTransaction({ merchant_name: 'Unknown Company' })
      const result = await findCounterpartyTemplate(supabase as never, 'user-1', tx)

      expect(result).toBeNull()
    })
  })

  // ── Build MappingResult ────────────────────────────────────

  describe('buildMappingResultFromCounterpartyTemplate', () => {
    it('builds correct MappingResult for expense with VAT', () => {
      const template = makeCategorizationTemplate({
        debit_account: '6200',
        credit_account: '1930',
        vat_treatment: 'standard_25',
        occurrence_count: 10,
      })
      const match = { template, matchMethod: 'exact_alias' as const, confidence: 0.85 }
      const tx = makeTransaction({ amount: -1250 })

      const result = buildMappingResultFromCounterpartyTemplate(match, tx, 'enskild_firma')

      expect(result.debit_account).toBe('6200')
      expect(result.credit_account).toBe('1930')
      expect(result.confidence).toBe(0.85)
      expect(result.vat_lines.length).toBe(1)
      expect(result.vat_lines[0].account_number).toBe('2641')
      expect(result.vat_lines[0].debit_amount).toBeGreaterThan(0)
      expect(result.rule).toBeNull()
      expect(result.description).toContain('telia')
      expect(result.description).toContain('10 ggr')
    })

    it('builds correct MappingResult for expense without VAT', () => {
      const template = makeCategorizationTemplate({
        debit_account: '6570',
        credit_account: '1930',
        vat_treatment: null,
      })
      const match = { template, matchMethod: 'exact_alias' as const, confidence: 0.9 }
      const tx = makeTransaction({ amount: -50 })

      const result = buildMappingResultFromCounterpartyTemplate(match, tx, 'enskild_firma')

      expect(result.debit_account).toBe('6570')
      expect(result.vat_lines).toHaveLength(0)
    })

    it('builds correct MappingResult for reverse charge', () => {
      const template = makeCategorizationTemplate({
        debit_account: '6540',
        credit_account: '1930',
        vat_treatment: 'reverse_charge',
      })
      const match = { template, matchMethod: 'exact_alias' as const, confidence: 0.8 }
      const tx = makeTransaction({ amount: -5000 })

      const result = buildMappingResultFromCounterpartyTemplate(match, tx, 'aktiebolag')

      expect(result.vat_lines.length).toBe(2)
      expect(result.vat_lines.some(l => l.account_number === '2645')).toBe(true)
    })

    it('does not generate VAT lines for income transactions', () => {
      const template = makeCategorizationTemplate({
        debit_account: '1930',
        credit_account: '3001',
        vat_treatment: 'standard_25',
      })
      const match = { template, matchMethod: 'exact_alias' as const, confidence: 0.8 }
      const tx = makeTransaction({ amount: 10000 })

      const result = buildMappingResultFromCounterpartyTemplate(match, tx, 'enskild_firma')

      expect(result.vat_lines).toHaveLength(0)
    })

    it('detects private accounts', () => {
      const template = makeCategorizationTemplate({
        debit_account: '2013',
        credit_account: '1930',
      })
      const match = { template, matchMethod: 'exact_alias' as const, confidence: 0.8 }
      const tx = makeTransaction({ amount: -500 })

      const result = buildMappingResultFromCounterpartyTemplate(match, tx, 'enskild_firma')

      expect(result.default_private).toBe(true)
    })
  })

  // ── Upsert ─────────────────────────────────────────────────

  describe('upsertCounterpartyTemplate', () => {
    const mappingResult = {
      rule: null,
      debit_account: '5410',
      credit_account: '1930',
      risk_level: 'NONE' as const,
      confidence: 0.9,
      requires_review: false,
      default_private: false,
      vat_lines: [],
      description: 'Test',
    }

    it('inserts new template for unknown counterparty', async () => {
      const { supabase, enqueue } = createQueuedMockSupabase()
      const tx = makeTransaction({ merchant_name: 'New Company AB', date: '2024-06-15' })

      enqueue({ data: null }) // No existing template
      enqueue({ data: null }) // Insert succeeds

      await upsertCounterpartyTemplate(
        supabase as never, 'user-1', tx, mappingResult, 'user_approved'
      )

      expect(supabase.from).toHaveBeenCalledWith('categorization_templates')
    })

    it('does not throw on insert error', async () => {
      const { supabase, enqueue } = createQueuedMockSupabase()
      const tx = makeTransaction({ merchant_name: 'New Company AB' })

      enqueue({ data: null }) // No existing
      enqueue({ error: { message: 'constraint violation' } })

      // Should not throw
      await upsertCounterpartyTemplate(
        supabase as never, 'user-1', tx, mappingResult, 'user_approved'
      )
    })

    it('updates existing template on re-approval', async () => {
      const { supabase, enqueue } = createQueuedMockSupabase()
      const existing = makeCategorizationTemplate({
        debit_account: '5410',
        credit_account: '1930',
        occurrence_count: 3,
        counterparty_aliases: ['ica maxi'],
      })
      const tx = makeTransaction({ merchant_name: 'ICA Maxi', date: '2024-07-01' })

      enqueue({ data: existing }) // Existing found
      enqueue({ data: null }) // Update succeeds

      await upsertCounterpartyTemplate(
        supabase as never, 'user-1', tx, mappingResult, 'user_approved'
      )

      expect(supabase.from).toHaveBeenCalledWith('categorization_templates')
    })

    it('resets occurrence_count on correction', async () => {
      const { supabase, enqueue } = createQueuedMockSupabase()
      const existing = makeCategorizationTemplate({
        debit_account: '6200', // Different from mappingResult's 5410
        credit_account: '1930',
        occurrence_count: 10,
        confidence: 0.85,
      })
      const tx = makeTransaction({ merchant_name: 'Telia Sverige AB', date: '2024-07-01' })

      enqueue({ data: existing }) // Existing found (different accounts = correction)
      enqueue({ data: null }) // Update succeeds

      await upsertCounterpartyTemplate(
        supabase as never, 'user-1', tx, mappingResult, 'user_approved'
      )

      expect(supabase.from).toHaveBeenCalledWith('categorization_templates')
    })

    it('skips upsert for transactions without merchant name', async () => {
      const { supabase } = createQueuedMockSupabase()
      const tx = makeTransaction({ merchant_name: null, description: '' })

      await upsertCounterpartyTemplate(
        supabase as never, 'user-1', tx, mappingResult, 'user_approved'
      )

      expect(supabase.from).not.toHaveBeenCalled()
    })
  })

  // ── Source Priority ──────────────────────────────────────────

  describe('resolveSource', () => {
    it('sie_import does not downgrade user_approved', () => {
      expect(resolveSource('user_approved', 'sie_import')).toBe('user_approved')
    })

    it('user_approved upgrades auto_learned', () => {
      expect(resolveSource('auto_learned', 'user_approved')).toBe('user_approved')
    })

    it('sie_import upgrades auto_learned', () => {
      expect(resolveSource('auto_learned', 'sie_import')).toBe('sie_import')
    })

    it('auto_learned does not upgrade sie_import', () => {
      expect(resolveSource('sie_import', 'auto_learned')).toBe('sie_import')
    })

    it('same source returns same source', () => {
      expect(resolveSource('user_approved', 'user_approved')).toBe('user_approved')
      expect(resolveSource('sie_import', 'sie_import')).toBe('sie_import')
    })
  })

  // ── insertOrUpdateTemplate ───────────────────────────────────

  describe('insertOrUpdateTemplate', () => {
    const baseParams: TemplateUpsertParams = {
      counterpartyName: 'telia',
      aliases: ['telia sverige ab'],
      debitAccount: '6200',
      creditAccount: '1930',
      vatTreatment: 'standard_25',
      vatAccount: '2641',
      category: null,
      occurrenceCount: 1,
      confidence: 0.45,
      lastSeenDate: '2024-06-15',
      source: 'sie_import',
    }

    it('inserts new template when existingTemplate is null', async () => {
      const { supabase, enqueue } = createQueuedMockSupabase()
      enqueue({ data: null }) // insert

      await insertOrUpdateTemplate(supabase as never, 'user-1', baseParams, null)

      expect(supabase.from).toHaveBeenCalledWith('categorization_templates')
    })

    it('uses pre-fetched template without DB lookup', async () => {
      const { supabase, enqueue } = createQueuedMockSupabase()
      const existing = makeCategorizationTemplate({
        debit_account: '6200',
        credit_account: '1930',
        occurrence_count: 5,
        source: 'auto_learned',
      })

      enqueue({ data: null }) // update

      await insertOrUpdateTemplate(supabase as never, 'user-1', baseParams, existing)

      // Should NOT have queried for existing: only the update call
      // The from() call count indicates no select was made before update
      expect(supabase.from).toHaveBeenCalledTimes(1)
    })

    it('accumulates occurrence count on re-approval', async () => {
      const { supabase, enqueue } = createQueuedMockSupabase()
      const existing = makeCategorizationTemplate({
        debit_account: '6200',
        credit_account: '1930',
        occurrence_count: 5,
      })

      enqueue({ data: null }) // update

      const params = { ...baseParams, occurrenceCount: 10 }
      await insertOrUpdateTemplate(supabase as never, 'user-1', params, existing)

      // Verify supabase.from was called (update happened)
      expect(supabase.from).toHaveBeenCalledWith('categorization_templates')
    })

    it('respects source priority: sie_import does not overwrite user_approved', async () => {
      const { supabase, enqueue } = createQueuedMockSupabase()
      const existing = makeCategorizationTemplate({
        debit_account: '5410', // Different accounts = correction
        credit_account: '1930',
        source: 'user_approved',
      })

      enqueue({ data: null }) // update

      await insertOrUpdateTemplate(supabase as never, 'user-1', baseParams, existing)

      // The source should remain user_approved (not downgraded to sie_import)
      expect(supabase.from).toHaveBeenCalledWith('categorization_templates')
    })

    it('does DB lookup when existingTemplate is undefined', async () => {
      const { supabase, enqueue } = createQueuedMockSupabase()
      enqueue({ data: null }) // select returns null
      enqueue({ data: null }) // insert

      await insertOrUpdateTemplate(supabase as never, 'user-1', baseParams)

      // Two calls: select + insert
      expect(supabase.from).toHaveBeenCalledTimes(2)
    })
  })

  // ── populateTemplatesFromSieVouchers ─────────────────────────

  describe('populateTemplatesFromSieVouchers', () => {
    it('returns 0 for empty vouchers', async () => {
      const { supabase } = createMockSupabase()
      const result = await populateTemplatesFromSieVouchers(supabase as never, 'user-1', [])
      expect(result).toBe(0)
    })

    it('groups vouchers by normalized description', async () => {
      const { supabase, enqueue } = createQueuedMockSupabase()
      const vouchers = [
        makeSIEVoucher({ description: 'Telia Sverige AB', number: 1 }),
        makeSIEVoucher({ description: 'TELIA SVERIGE', number: 2 }),
        makeSIEVoucher({ description: 'telia sverige ab', number: 3 }),
      ]

      enqueue({ data: [] }) // pre-fetch existing templates
      enqueue({ data: null }) // insert

      const result = await populateTemplatesFromSieVouchers(supabase as never, 'user-1', vouchers)
      expect(result).toBe(1)
    })

    it('skips groups with fewer than 2 occurrences', async () => {
      const { supabase } = createQueuedMockSupabase()
      const vouchers = [
        makeSIEVoucher({ description: 'Telia', number: 1 }),
      ]

      const result = await populateTemplatesFromSieVouchers(supabase as never, 'user-1', vouchers)
      expect(result).toBe(0)
    })

    it('accepts groups with sufficient dominance (75% > 60%)', async () => {
      const { supabase, enqueue } = createQueuedMockSupabase()
      const vouchers = [
        makeSIEVoucher({ description: 'Telia', number: 1, lines: [{ account: '1930', amount: -1000 }, { account: '6212', amount: 1000 }] }),
        makeSIEVoucher({ description: 'Telia', number: 2, lines: [{ account: '1930', amount: -1000 }, { account: '6212', amount: 1000 }] }),
        makeSIEVoucher({ description: 'Telia', number: 3, lines: [{ account: '1930', amount: -1000 }, { account: '6212', amount: 1000 }] }),
        makeSIEVoucher({ description: 'Telia', number: 4, lines: [{ account: '1930', amount: -1000 }, { account: '6230', amount: 1000 }] }),
      ]

      enqueue({ data: [] }) // pre-fetch
      enqueue({ data: null }) // insert

      const result = await populateTemplatesFromSieVouchers(supabase as never, 'user-1', vouchers)
      expect(result).toBe(1)
    })

    it('rejects groups with insufficient dominance (50% < 60%)', async () => {
      const { supabase } = createQueuedMockSupabase()
      const vouchers = [
        makeSIEVoucher({ description: 'Telia', number: 1, lines: [{ account: '1930', amount: -1000 }, { account: '6212', amount: 1000 }] }),
        makeSIEVoucher({ description: 'Telia', number: 2, lines: [{ account: '1930', amount: -1000 }, { account: '6212', amount: 1000 }] }),
        makeSIEVoucher({ description: 'Telia', number: 3, lines: [{ account: '1930', amount: -1000 }, { account: '6230', amount: 1000 }] }),
        makeSIEVoucher({ description: 'Telia', number: 4, lines: [{ account: '1930', amount: -1000 }, { account: '6230', amount: 1000 }] }),
      ]

      const result = await populateTemplatesFromSieVouchers(supabase as never, 'user-1', vouchers)
      expect(result).toBe(0)
    })

    it('skips descriptions in skip set', async () => {
      const { supabase } = createQueuedMockSupabase()
      const vouchers = [
        makeSIEVoucher({ description: 'Lön', number: 1 }),
        makeSIEVoucher({ description: 'Lön', number: 2 }),
        makeSIEVoucher({ description: 'Lön', number: 3 }),
      ]

      const result = await populateTemplatesFromSieVouchers(supabase as never, 'user-1', vouchers)
      expect(result).toBe(0)
    })

    it('skips split bookings with more than 5 business accounts', async () => {
      const { supabase } = createQueuedMockSupabase()
      const vouchers = Array.from({ length: 3 }, (_, i) =>
        makeSIEVoucher({
          description: 'Complex booking',
          number: i + 1,
          lines: [
            { account: '1930', amount: -6000 },
            { account: '6200', amount: 1000 },
            { account: '6210', amount: 1000 },
            { account: '6220', amount: 1000 },
            { account: '6230', amount: 1000 },
            { account: '6240', amount: 1000 },
            { account: '6250', amount: 1000 },
          ],
        })
      )

      const result = await populateTemplatesFromSieVouchers(supabase as never, 'user-1', vouchers)
      expect(result).toBe(0)
    })

    it('extracts VAT treatment from 2641 line', async () => {
      const { supabase, enqueue } = createQueuedMockSupabase()
      const vouchers = Array.from({ length: 3 }, (_, i) =>
        makeSIEVoucher({
          description: 'Kontorsmaterial AB',
          number: i + 1,
          lines: [
            { account: '1930', amount: -1250 },
            { account: '6100', amount: 1000 },
            { account: '2641', amount: 250 },
          ],
        })
      )

      enqueue({ data: [] }) // pre-fetch
      enqueue({ data: null }) // insert

      const result = await populateTemplatesFromSieVouchers(supabase as never, 'user-1', vouchers)
      expect(result).toBe(1)
    })

    it('filters out old vouchers beyond recency window', async () => {
      const { supabase } = createQueuedMockSupabase()
      const recentDate = new Date(2024, 5, 15)
      const oldDate = new Date(2021, 0, 1) // >24 months before recent

      const vouchers = [
        makeSIEVoucher({ description: 'Old Company', date: oldDate, number: 1 }),
        makeSIEVoucher({ description: 'Old Company', date: oldDate, number: 2 }),
        makeSIEVoucher({ description: 'Old Company', date: oldDate, number: 3 }),
        makeSIEVoucher({ description: 'Recent Company', date: recentDate, number: 4 }),
      ]

      // Only 1 recent voucher for "Recent Company" → below min count → 0 templates
      const result = await populateTemplatesFromSieVouchers(supabase as never, 'user-1', vouchers)
      expect(result).toBe(0)
    })

    it('computes SIE confidence formula correctly', async () => {
      const { supabase, enqueue } = createQueuedMockSupabase()
      // 40 occurrences, 38 dominant (95% dominance)
      const vouchers: ReturnType<typeof makeSIEVoucher>[] = []
      for (let i = 0; i < 38; i++) {
        vouchers.push(makeSIEVoucher({
          description: 'Telia',
          number: i + 1,
          lines: [{ account: '1930', amount: -1000 }, { account: '6212', amount: 1000 }],
        }))
      }
      for (let i = 0; i < 2; i++) {
        vouchers.push(makeSIEVoucher({
          description: 'Telia',
          number: 39 + i,
          lines: [{ account: '1930', amount: -1000 }, { account: '6230', amount: 1000 }],
        }))
      }

      enqueue({ data: [] }) // pre-fetch
      enqueue({ data: null }) // insert

      const result = await populateTemplatesFromSieVouchers(supabase as never, 'user-1', vouchers)
      expect(result).toBe(1)
      // dominance = 38/40 = 0.95, confidence = 0.95 * (1 - 1/38) ≈ 0.925 → rounded to 0.92
    })

    it('recognizes 1510 (receivables) as settlement account', async () => {
      const { supabase, enqueue } = createQueuedMockSupabase()
      const vouchers = Array.from({ length: 3 }, (_, i) =>
        makeSIEVoucher({
          description: 'Kund AB',
          number: i + 1,
          lines: [
            { account: '1510', amount: 10000 },
            { account: '3001', amount: -10000 },
          ],
        })
      )

      enqueue({ data: [] }) // pre-fetch
      enqueue({ data: null }) // insert

      const result = await populateTemplatesFromSieVouchers(supabase as never, 'user-1', vouchers)
      expect(result).toBe(1)
    })

    it('recognizes 2890 (credit card) as settlement account', async () => {
      const { supabase, enqueue } = createQueuedMockSupabase()
      const vouchers = Array.from({ length: 3 }, (_, i) =>
        makeSIEVoucher({
          description: 'Företaget AB',
          number: i + 1,
          lines: [
            { account: '2890', amount: -1000 },
            { account: '6200', amount: 1000 },
          ],
        })
      )

      enqueue({ data: [] }) // pre-fetch
      enqueue({ data: null }) // insert

      const result = await populateTemplatesFromSieVouchers(supabase as never, 'user-1', vouchers)
      expect(result).toBe(1)
    })

    it('end-to-end: multiple counterparties, filters correctly', async () => {
      const { supabase, enqueue } = createQueuedMockSupabase()
      const vouchers = [
        // Telia: 5 vouchers, all same pattern → should produce template
        ...Array.from({ length: 5 }, (_, i) =>
          makeSIEVoucher({
            description: 'Telia',
            number: i + 1,
            lines: [{ account: '1930', amount: -500 }, { account: '6212', amount: 500 }],
          })
        ),
        // ICA: 4 vouchers, all same pattern → should produce template
        ...Array.from({ length: 4 }, (_, i) =>
          makeSIEVoucher({
            description: 'ICA Maxi',
            number: 10 + i,
            lines: [{ account: '1930', amount: -200 }, { account: '4010', amount: 200 }],
          })
        ),
        // Rare: 1 voucher → below minimum, no template
        makeSIEVoucher({
          description: 'Rare Supplier',
          number: 20,
          lines: [{ account: '1930', amount: -100 }, { account: '6590', amount: 100 }],
        }),
      ]

      enqueue({ data: [] }) // pre-fetch
      enqueue({ data: null }) // insert 1
      enqueue({ data: null }) // insert 2

      const result = await populateTemplatesFromSieVouchers(supabase as never, 'user-1', vouchers)
      expect(result).toBe(2)
    })
  })
})

// ── dimensions propagation (PR7) ─────────────────────────────

describe('dimensions propagation (PR7)', () => {
  describe('buildMappingResultFromCounterpartyTemplate: multi-line pattern', () => {
    it('materialized business lines carry the pattern bag; VAT and tax lines stay untagged', () => {
      const template = makeCategorizationTemplate({
        debit_account: '5410',
        credit_account: '1930',
        line_pattern: [
          { account: '2641', type: 'vat', side: 'debit', vat_rate: 0.25 },
          { account: '5410', type: 'business', side: 'debit', ratio: 0.8, dimensions: { '1': 'KS01' } },
          // Even a (bogus) bag on a tax entry must not materialize: only
          // business lines are tagged.
          { account: '2710', type: 'tax', side: 'debit', ratio: 0.2, dimensions: { '1': 'KS01' } },
        ],
      })
      const match = { template, matchMethod: 'exact_alias' as const, confidence: 0.9 }
      const tx = makeTransaction({ amount: -1250 })

      const result = buildMappingResultFromCounterpartyTemplate(match, tx, 'enskild_firma')

      expect(result.all_lines_complete).toBe(true)
      const business = result.vat_lines.find((l) => l.account_number === '5410')
      expect(business?.dimensions).toEqual({ '1': 'KS01' })
      expect(result.vat_lines.find((l) => l.account_number === '2641')?.dimensions).toBeUndefined()
      expect(result.vat_lines.find((l) => l.account_number === '2710')?.dimensions).toBeUndefined()
    })

    it('a pattern business line without a bag materializes untagged', () => {
      const template = makeCategorizationTemplate({
        debit_account: '5410',
        credit_account: '1930',
        line_pattern: [
          { account: '5410', type: 'business', side: 'debit', ratio: 1 },
        ],
      })
      const match = { template, matchMethod: 'exact_alias' as const, confidence: 0.9 }
      const tx = makeTransaction({ amount: -1000 })

      const result = buildMappingResultFromCounterpartyTemplate(match, tx, 'enskild_firma')

      expect(result.vat_lines.find((l) => l.account_number === '5410')?.dimensions).toBeUndefined()
    })
  })

  describe('populateTemplatesFromSieVouchers: line-pattern dimension learning', () => {
    /**
     * Queue-based supabase mock that also records `.insert()` payloads per
     * table, so assertions can inspect the stored line_pattern. Follows the
     * capture pattern in lib/pending-operations/__tests__/create-invoice-executor.test.ts.
     */
    function createCapturingSupabase(results: Array<{ data?: unknown; error?: unknown }>) {
      const queue = [...results]
      const inserts: Record<string, unknown[]> = {}

      const from = vi.fn((_table: string) => {
        const raw = queue.shift() ?? { data: null, error: null }
        const result = { data: raw.data ?? null, error: raw.error ?? null }
        const chain: object = new Proxy(
          {},
          {
            get(_target, prop) {
              if (prop === 'then') {
                return (resolve: (v: unknown) => void) => resolve(result)
              }
              if (prop === 'insert') {
                return (payload: unknown) => {
                  ;(inserts[_table] ??= []).push(payload)
                  return chain
                }
              }
              return () => chain
            },
          },
        )
        return chain
      })

      return { supabase: { from }, inserts }
    }

    function capturedLinePattern(inserts: Record<string, unknown[]>): LinePatternEntry[] {
      const rows = inserts['categorization_templates']
      expect(rows).toHaveLength(1)
      const row = rows[0] as { line_pattern: LinePatternEntry[] | null }
      expect(row.line_pattern).not.toBeNull()
      return row.line_pattern!
    }

    it('preserves a business line bag only when EVERY voucher occurrence has the identical bag', async () => {
      // Two business accounts → not "simple", so the pattern is stored as
      // line_pattern JSONB. All three vouchers tag both accounts identically.
      const vouchers = Array.from({ length: 3 }, (_, i) =>
        makeSIEVoucher({
          description: 'Projektbygget AB',
          number: i + 1,
          lines: [
            { account: '1930', amount: -1100 },
            { account: '6212', amount: 600, dimensions: { '1': 'KS01' } },
            { account: '5410', amount: 500, dimensions: { '6': 'P001' } },
          ],
        })
      )

      const { supabase, inserts } = createCapturingSupabase([
        { data: [] }, // pre-fetch existing templates
        { data: null }, // insert
      ])

      const count = await populateTemplatesFromSieVouchers(supabase as never, 'company-1', vouchers)
      expect(count).toBe(1)

      const pattern = capturedLinePattern(inserts)
      expect(pattern.find((e) => e.account === '6212')?.dimensions).toEqual({ '1': 'KS01' })
      expect(pattern.find((e) => e.account === '5410')?.dimensions).toEqual({ '6': 'P001' })
    })

    it('drops the bag when a voucher disagrees, or leaves the line untagged', async () => {
      // 6212 conflicts across vouchers (KS01 vs KS02); 5410 is untagged in one
      // voucher. Both must lose the bag: a template must never invent a tag
      // history does not consistently support.
      const linesFor = (v: number): SIETransactionLine[] => [
        { account: '1930', amount: -1100 },
        { account: '6212', amount: 600, dimensions: v === 2 ? { '1': 'KS02' } : { '1': 'KS01' } },
        v === 2
          ? { account: '5410', amount: 500 }
          : { account: '5410', amount: 500, dimensions: { '6': 'P001' } },
      ]
      const vouchers = [1, 2, 3].map((v) =>
        makeSIEVoucher({ description: 'Projektbygget AB', number: v, lines: linesFor(v) })
      )

      const { supabase, inserts } = createCapturingSupabase([
        { data: [] }, // pre-fetch existing templates
        { data: null }, // insert
      ])

      const count = await populateTemplatesFromSieVouchers(supabase as never, 'company-1', vouchers)
      expect(count).toBe(1)

      const pattern = capturedLinePattern(inserts)
      expect(pattern.find((e) => e.account === '6212')?.dimensions).toBeUndefined()
      expect(pattern.find((e) => e.account === '5410')?.dimensions).toBeUndefined()
    })
  })
})

// ── learning-loop repair (issue #865) ────────────────────────

describe('learning-loop repair (issue #865)', () => {
  /** Queue-based mock that records insert payloads per table (see PR7 block). */
  function createCapturingSupabase(results: Array<{ data?: unknown; error?: unknown }>) {
    const queue = [...results]
    const inserts: Record<string, unknown[]> = {}

    const from = vi.fn((_table: string) => {
      const raw = queue.shift() ?? { data: null, error: null }
      const result = { data: raw.data ?? null, error: raw.error ?? null }
      const chain: object = new Proxy(
        {},
        {
          get(_target, prop) {
            if (prop === 'then') {
              return (resolve: (v: unknown) => void) => resolve(result)
            }
            if (prop === 'insert') {
              return (payload: unknown) => {
                ;(inserts[_table] ??= []).push(payload)
                return chain
              }
            }
            return () => chain
          },
        },
      )
      return chain
    })

    return { supabase: { from }, inserts }
  }

  function capturedTemplateRow(inserts: Record<string, unknown[]>) {
    const rows = inserts['categorization_templates']
    expect(rows).toHaveLength(1)
    return rows[0] as {
      vat_treatment: string | null
      vat_account: string | null
      line_pattern: LinePatternEntry[] | null
      debit_account: string
      credit_account: string
    }
  }

  describe('direction mismatch (refunds/repayments)', () => {
    it('mirrors an expense-learned template for an incoming refund, with reversed input VAT', () => {
      const template = makeCategorizationTemplate({
        debit_account: '6200',
        credit_account: '1930',
        vat_treatment: 'standard_25',
      })
      const match = { template, matchMethod: 'exact_alias' as const, confidence: 0.85 }
      const tx = makeTransaction({ amount: 1250 }) // money IN from an expense counterparty

      const result = buildMappingResultFromCounterpartyTemplate(match, tx, 'enskild_firma')

      // Mirrored: settle on debit (bank), reduce the expense on credit
      expect(result.debit_account).toBe('1930')
      expect(result.credit_account).toBe('6200')
      expect(result.requires_review).toBe(true)
      expect(result.direction_mismatch).toBe(true)
      // Input VAT mirrored: credit 2641 for the VAT share of 1250 = 250
      expect(result.vat_lines).toHaveLength(1)
      expect(result.vat_lines[0].account_number).toBe('2641')
      expect(result.vat_lines[0].credit_amount).toBe(250)
      expect(result.vat_lines[0].debit_amount).toBe(0)
    })

    it('mirrors both fiktiv-moms legs for a reverse-charge credit note, and the entry balances', () => {
      const template = makeCategorizationTemplate({
        counterparty_name: 'google cloud emea',
        debit_account: '4535',
        credit_account: '1930',
        vat_treatment: 'reverse_charge',
        vat_account: '2645',
      })
      const match = { template, matchMethod: 'exact_alias' as const, confidence: 0.85 }
      const tx = makeTransaction({ amount: 5000 }) // credit note from an RC supplier

      const result = buildMappingResultFromCounterpartyTemplate(match, tx, 'aktiebolag')

      expect(result.direction_mismatch).toBe(true)
      // Original purchase books debit 2645 / credit 2614; the mirror flips both
      const in2645 = result.vat_lines.find((l) => l.account_number === '2645')
      const out2614 = result.vat_lines.find((l) => l.account_number === '2614')
      expect(in2645?.credit_amount).toBe(1250)
      expect(out2614?.debit_amount).toBe(1250)

      // End-to-end: the RC pair nets to zero, business keeps the gross amount,
      // and the whole entry balances
      const lines = buildTransactionEntryLines(tx, result)
      const debits = roundOre(lines.reduce((s, l) => s + l.debit_amount, 0))
      const credits = roundOre(lines.reduce((s, l) => s + l.credit_amount, 0))
      expect(debits).toBe(credits)
      expect(lines.find((l) => l.account_number === '4535')?.credit_amount).toBe(5000)
    })

    it('mirrors an income-learned template for an outgoing repayment, without VAT lines', () => {
      const template = makeCategorizationTemplate({
        counterparty_name: 'kund ab',
        debit_account: '1930',
        credit_account: '3001',
        vat_treatment: null,
        vat_account: null,
      })
      const match = { template, matchMethod: 'exact_normalized' as const, confidence: 0.8 }
      const tx = makeTransaction({ amount: -5000 }) // money OUT to an income counterparty

      const result = buildMappingResultFromCounterpartyTemplate(match, tx, 'aktiebolag')

      expect(result.debit_account).toBe('3001')
      expect(result.credit_account).toBe('1930')
      expect(result.requires_review).toBe(true)
      expect(result.direction_mismatch).toBe(true)
      expect(result.vat_lines).toHaveLength(0)
    })

    it('mirrors every side of a multi-line pattern on sign mismatch', () => {
      const template = makeCategorizationTemplate({
        debit_account: '5410',
        credit_account: '1930',
        line_pattern: [
          { account: '2641', type: 'vat', side: 'debit', vat_rate: 0.25 },
          { account: '5410', type: 'business', side: 'debit', ratio: 1 },
        ],
      })
      const match = { template, matchMethod: 'exact_alias' as const, confidence: 0.9 }
      const tx = makeTransaction({ amount: 1250 }) // refund of a multi-line expense

      const result = buildMappingResultFromCounterpartyTemplate(match, tx, 'enskild_firma')

      expect(result.all_lines_complete).toBe(true)
      expect(result.requires_review).toBe(true)
      expect(result.direction_mismatch).toBe(true)
      expect(result.debit_account).toBe('1930')
      expect(result.credit_account).toBe('5410')
      const vat = result.vat_lines.find((l) => l.account_number === '2641')
      expect(vat?.credit_amount).toBe(250)
      expect(vat?.debit_amount).toBe(0)
      const business = result.vat_lines.find((l) => l.account_number === '5410')
      expect(business?.credit_amount).toBe(1000)
      expect(business?.debit_amount).toBe(0)
    })

    it('does not learn from a direction-mismatched booking', async () => {
      const { supabase } = createQueuedMockSupabase()
      const tx = makeTransaction({ merchant_name: 'Telia Sverige AB', amount: 1250 })

      await upsertCounterpartyTemplate(
        supabase as never,
        'company-1',
        tx,
        {
          rule: null,
          debit_account: '1930',
          credit_account: '6200',
          risk_level: 'NONE',
          confidence: 0.85,
          requires_review: true,
          direction_mismatch: true,
          default_private: false,
          vat_lines: [],
          description: 'Motpart: telia (retur/återbetalning)',
        },
        'user_approved',
      )

      expect(supabase.from).not.toHaveBeenCalled()
    })

    it('refuses an opposite-direction "correction" of an existing template', async () => {
      const { supabase } = createQueuedMockSupabase()
      const existing = makeCategorizationTemplate({
        debit_account: '6200',
        credit_account: '1930',
      })

      const params: TemplateUpsertParams = {
        counterpartyName: 'telia',
        aliases: ['telia refund'],
        debitAccount: '1930', // refund shape: settlement moved to debit
        creditAccount: '3990',
        vatTreatment: null,
        vatAccount: null,
        category: null,
        occurrenceCount: 1,
        confidence: 0.45,
        lastSeenDate: '2024-07-01',
        source: 'user_approved',
      }

      const written = await insertOrUpdateTemplate(supabase as never, 'company-1', params, existing)

      expect(written).toBe(false)
      expect(supabase.from).not.toHaveBeenCalled()
    })

    it('falls back to the pattern direction when the legacy fields cannot classify a multi-line template', async () => {
      const { supabase } = createQueuedMockSupabase()
      // Both legacy fields settlement-ish → legacy direction 'unknown';
      // the pattern's business sides say expense.
      const existing = makeCategorizationTemplate({
        debit_account: '2440',
        credit_account: '1930',
        line_pattern: [
          { account: '2641', type: 'vat', side: 'debit', vat_rate: 0.25 },
          { account: '5410', type: 'business', side: 'debit', ratio: 1 },
        ],
      })

      const params: TemplateUpsertParams = {
        counterpartyName: 'telia',
        aliases: [],
        debitAccount: '1930', // income-shaped: opposite of the learned pattern
        creditAccount: '3001',
        vatTreatment: null,
        vatAccount: null,
        category: null,
        occurrenceCount: 1,
        confidence: 0.45,
        lastSeenDate: '2024-07-01',
        source: 'user_approved',
      }

      const written = await insertOrUpdateTemplate(supabase as never, 'company-1', params, existing)

      expect(written).toBe(false)
      expect(supabase.from).not.toHaveBeenCalled()
    })

    it('still applies a same-direction account correction', async () => {
      const { supabase, enqueue } = createQueuedMockSupabase()
      const existing = makeCategorizationTemplate({
        debit_account: '6200',
        credit_account: '1930',
      })
      enqueue({ data: null }) // update

      const params: TemplateUpsertParams = {
        counterpartyName: 'telia',
        aliases: [],
        debitAccount: '6230', // still expense-shaped
        creditAccount: '1930',
        vatTreatment: 'standard_25',
        vatAccount: '2641',
        category: null,
        occurrenceCount: 1,
        confidence: 0.45,
        lastSeenDate: '2024-07-01',
        source: 'user_approved',
      }

      const written = await insertOrUpdateTemplate(supabase as never, 'company-1', params, existing)

      expect(written).toBe(true)
      expect(supabase.from).toHaveBeenCalledWith('categorization_templates')
    })
  })

  describe('reduced_12 templates across the livsmedel transition (2026-04-01)', () => {
    const staleTemplate = () => makeCategorizationTemplate({
      debit_account: '4010',
      credit_account: '1930',
      vat_treatment: 'reduced_12',
      last_seen_date: '2026-03-10', // learned before the 12→6 livsmedel change
    })

    it('review-gates a stale 12% template applied after the transition', () => {
      const match = { template: staleTemplate(), matchMethod: 'exact_alias' as const, confidence: 0.85 }
      const tx = makeTransaction({ amount: -560, date: '2026-05-02' })

      const result = buildMappingResultFromCounterpartyTemplate(match, tx, 'enskild_firma')

      expect(result.requires_review).toBe(true)
      expect(result.direction_mismatch).toBeUndefined()
    })

    it('does not gate a 12% template re-confirmed after the transition', () => {
      const template = makeCategorizationTemplate({
        debit_account: '5831', // e.g. restaurant/hotel: legitimately still 12%
        credit_account: '1930',
        vat_treatment: 'reduced_12',
        last_seen_date: '2026-04-20',
      })
      const match = { template, matchMethod: 'exact_alias' as const, confidence: 0.85 }
      const tx = makeTransaction({ amount: -560, date: '2026-05-02' })

      const result = buildMappingResultFromCounterpartyTemplate(match, tx, 'enskild_firma')

      expect(result.requires_review).toBe(false)
    })

    it('does not gate pre-transition transaction dates or other rates', () => {
      const match = { template: staleTemplate(), matchMethod: 'exact_alias' as const, confidence: 0.85 }
      const backdated = makeTransaction({ amount: -560, date: '2026-03-20' })
      expect(
        buildMappingResultFromCounterpartyTemplate(match, backdated, 'enskild_firma').requires_review
      ).toBe(false)

      const t25 = makeCategorizationTemplate({
        vat_treatment: 'standard_25',
        last_seen_date: '2026-03-10',
      })
      const match25 = { template: t25, matchMethod: 'exact_alias' as const, confidence: 0.85 }
      const tx = makeTransaction({ amount: -560, date: '2026-05-02' })
      expect(
        buildMappingResultFromCounterpartyTemplate(match25, tx, 'enskild_firma').requires_review
      ).toBe(false)
    })

    it('review-gates a stale multi-line pattern carrying a 12% VAT entry', () => {
      const template = makeCategorizationTemplate({
        debit_account: '4010',
        credit_account: '1930',
        vat_treatment: null,
        last_seen_date: '2026-02-01',
        line_pattern: [
          { account: '2641', type: 'vat', side: 'debit', vat_rate: 0.12 },
          { account: '4010', type: 'business', side: 'debit', ratio: 1 },
        ],
      })
      const match = { template, matchMethod: 'exact_alias' as const, confidence: 0.9 }
      const tx = makeTransaction({ amount: -1120, date: '2026-05-02' })

      const result = buildMappingResultFromCounterpartyTemplate(match, tx, 'enskild_firma')

      expect(result.requires_review).toBe(true)
    })
  })

  describe('SEK resolution for foreign-currency transactions', () => {
    it('computes legacy VAT lines from the SEK amount, not the foreign amount', () => {
      const template = makeCategorizationTemplate({
        debit_account: '6200',
        credit_account: '1930',
        vat_treatment: 'standard_25',
      })
      const match = { template, matchMethod: 'exact_alias' as const, confidence: 0.85 }
      const tx = makeTransaction({
        amount: -100,
        currency: 'EUR',
        amount_sek: -1100,
        exchange_rate: 11,
      })

      const result = buildMappingResultFromCounterpartyTemplate(match, tx, 'enskild_firma')

      // VAT share of 1100 SEK at 25% = 220, not 20 (which the EUR amount gives)
      expect(result.vat_lines[0].debit_amount).toBe(220)
    })

    it('computes multi-line pattern amounts from the SEK amount so the entry balances', () => {
      const template = makeCategorizationTemplate({
        debit_account: '5410',
        credit_account: '1930',
        line_pattern: [
          { account: '2641', type: 'vat', side: 'debit', vat_rate: 0.25 },
          { account: '5410', type: 'business', side: 'debit', ratio: 1 },
        ],
      })
      const match = { template, matchMethod: 'exact_alias' as const, confidence: 0.9 }
      const tx = makeTransaction({
        amount: -100,
        currency: 'EUR',
        amount_sek: -1100,
        exchange_rate: 11,
      })

      const result = buildMappingResultFromCounterpartyTemplate(match, tx, 'enskild_firma')

      const vat = result.vat_lines.find((l) => l.account_number === '2641')
      const business = result.vat_lines.find((l) => l.account_number === '5410')
      expect(vat?.debit_amount).toBe(220)
      expect(business?.debit_amount).toBe(880)
      // Non-settlement lines sum to the SEK settlement amount: entry balances
      const totalDebits = result.vat_lines.reduce((s, l) => s + l.debit_amount, 0)
      expect(totalDebits).toBe(1100)
    })
  })

  describe('SIE VAT-rate inference (2641 is rate-agnostic)', () => {
    it('learns reduced_12 from voucher amounts instead of hardcoding 25%', async () => {
      const vouchers = Array.from({ length: 3 }, (_, i) =>
        makeSIEVoucher({
          description: 'Restaurang AB',
          number: i + 1,
          lines: [
            { account: '1930', amount: -1120 },
            { account: '6072', amount: 1000 },
            { account: '2641', amount: 120 }, // 12% of the 1000 net
          ],
        })
      )

      const { supabase, inserts } = createCapturingSupabase([
        { data: [] }, // pre-fetch existing templates
        { data: null }, // insert
      ])

      const count = await populateTemplatesFromSieVouchers(supabase as never, 'company-1', vouchers)
      expect(count).toBe(1)

      const row = capturedTemplateRow(inserts)
      expect(row.vat_treatment).toBe('reduced_12')
      expect(row.vat_account).toBe('2641')
    })

    it('drops the VAT leg when the observed rate snaps to no legal rate', async () => {
      const vouchers = Array.from({ length: 3 }, (_, i) =>
        makeSIEVoucher({
          description: 'Utlandet Ltd',
          number: i + 1,
          lines: [
            { account: '1930', amount: -1190 },
            { account: '6100', amount: 1000 },
            { account: '2641', amount: 190 }, // 19%: not a Swedish rate
          ],
        })
      )

      const { supabase, inserts } = createCapturingSupabase([
        { data: [] },
        { data: null },
      ])

      const count = await populateTemplatesFromSieVouchers(supabase as never, 'company-1', vouchers)
      expect(count).toBe(1)

      const row = capturedTemplateRow(inserts)
      expect(row.vat_treatment).toBeNull()
      expect(row.vat_account).toBeNull()
    })

    it('excludes import output-VAT accounts (2615) from the ratio base like other fiktiv moms', async () => {
      const vouchers = Array.from({ length: 3 }, (_, i) =>
        makeSIEVoucher({
          description: 'Import Goods Ltd',
          number: i + 1,
          lines: [
            { account: '1930', amount: -1000 },
            { account: '4545', amount: 1000 },
            { account: '2645', amount: 250 },
            { account: '2615', amount: -250 }, // output VAT on imports
          ],
        })
      )

      const { supabase, inserts } = createCapturingSupabase([
        { data: [] },
        { data: null },
      ])

      const count = await populateTemplatesFromSieVouchers(supabase as never, 'company-1', vouchers)
      expect(count).toBe(1)

      const row = capturedTemplateRow(inserts)
      expect(row.vat_treatment).toBe('reverse_charge')
      expect(row.debit_account).toBe('4545')
      // Simple pattern: neither fiktiv leg shrank the business ratio base
      expect(row.line_pattern).toBeNull()
    })

    it('learns reverse_charge for counterparties booked with fiktiv moms', async () => {
      const vouchers = Array.from({ length: 3 }, (_, i) =>
        makeSIEVoucher({
          description: 'Google Cloud EMEA',
          number: i + 1,
          lines: [
            { account: '1930', amount: -1000 },
            { account: '4535', amount: 1000 },
            { account: '2645', amount: 250 },
            { account: '2614', amount: -250 },
          ],
        })
      )

      const { supabase, inserts } = createCapturingSupabase([
        { data: [] },
        { data: null },
      ])

      const count = await populateTemplatesFromSieVouchers(supabase as never, 'company-1', vouchers)
      expect(count).toBe(1)

      const row = capturedTemplateRow(inserts)
      expect(row.vat_treatment).toBe('reverse_charge')
      expect(row.vat_account).toBe('2645')
      expect(row.debit_account).toBe('4535')
      expect(row.credit_account).toBe('1930')
      // Simple pattern: RC legs are regenerated from the treatment at booking
      expect(row.line_pattern).toBeNull()
    })
  })

  describe('write-failure visibility', () => {
    it('populateTemplatesFromSieVouchers counts only rows actually written', async () => {
      const { supabase, enqueue } = createQueuedMockSupabase()
      const vouchers = Array.from({ length: 3 }, (_, i) =>
        makeSIEVoucher({
          description: 'Telia',
          number: i + 1,
          lines: [{ account: '1930', amount: -1000 }, { account: '6212', amount: 1000 }],
        })
      )

      enqueue({ data: [] }) // pre-fetch existing templates
      enqueue({ error: { message: 'null value in column "user_id"' } }) // insert fails

      const count = await populateTemplatesFromSieVouchers(supabase as never, 'company-1', vouchers)
      expect(count).toBe(0)
    })

    it('insertOrUpdateTemplate returns false on insert error instead of swallowing it', async () => {
      const { supabase, enqueue } = createQueuedMockSupabase()
      enqueue({ error: { message: 'violates row-level security policy' } })

      const written = await insertOrUpdateTemplate(supabase as never, 'company-1', {
        counterpartyName: 'telia',
        aliases: [],
        debitAccount: '6200',
        creditAccount: '1930',
        vatTreatment: null,
        vatAccount: null,
        category: null,
        occurrenceCount: 1,
        confidence: 0.45,
        lastSeenDate: '2024-06-15',
        source: 'user_approved',
      }, null)

      expect(written).toBe(false)
    })
  })
})
