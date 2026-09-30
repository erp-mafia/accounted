/**
 * Learned dimension bags that point at retired codes (dimensions D5).
 *
 * A counterparty template keeps what it learned forever; once a kostnadsställe
 * or projekt is archived, applying the learned bag turned the next booking of
 * a company with dimensions enabled into a DimensionValidationError. Learned
 * bags are now pruned to what the registry accepts wherever templates are
 * read for application; explicit picks never pass through the prune.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createTableMockSupabase, makeCategorizationTemplate, makeTransaction } from '@/tests/helpers'

const { logWarn } = vi.hoisted(() => ({ logWarn: vi.fn() }))
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: logWarn, error: vi.fn(), debug: vi.fn() }),
}))

import {
  pruneLearnedTemplateDimensions,
  findCounterpartyTemplatesBatch,
  loadCounterpartyTemplateMatch,
  buildMappingResultFromCounterpartyTemplate,
} from '../counterparty-templates'
import { buildTransactionEntryLines } from '../transaction-entries'

// KS01 is active; P001 is archived; P002 is active; dimension 20 has no
// registry row at all.
const REGISTRY = {
  company_settings: { data: { dimensions_enabled: true } },
  dimensions: {
    data: [
      { id: 'dim-1', sie_dim_no: 1 },
      { id: 'dim-6', sie_dim_no: 6 },
    ],
  },
  dimension_values: {
    data: [
      { dimension_id: 'dim-1', code: 'KS01', is_active: true },
      { dimension_id: 'dim-6', code: 'P001', is_active: false },
      { dimension_id: 'dim-6', code: 'P002', is_active: true },
    ],
  },
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('pruneLearnedTemplateDimensions', () => {
  it('drops an archived code from default_dimensions, keeps the active ones, and says so in a structured warning', async () => {
    const { supabase } = createTableMockSupabase(REGISTRY)
    const template = makeCategorizationTemplate({ id: 'tmpl-1', default_dimensions: { '1': 'KS01', '6': 'P001' } })

    const [pruned] = await pruneLearnedTemplateDimensions(supabase as never, 'company-1', [template])

    expect(pruned.default_dimensions).toEqual({ '1': 'KS01' })
    expect(logWarn).toHaveBeenCalledWith(
      'learned dimension codes dropped: no longer active in the registry',
      {
        companyId: 'company-1',
        templateId: 'tmpl-1',
        dropped: [{ sie_dim_no: '6', code: 'P001', reason: 'archived_value' }],
      },
    )
  })

  it('prunes line-pattern bags too: an unknown dimension goes, and an entry left with nothing loses its bag', async () => {
    const { supabase } = createTableMockSupabase(REGISTRY)
    const template = makeCategorizationTemplate({
      line_pattern: [
        { account: '2641', type: 'vat', side: 'debit', vat_rate: 0.25 },
        { account: '5410', type: 'business', side: 'debit', ratio: 0.5, dimensions: { '6': 'P001' } },
        { account: '6110', type: 'business', side: 'debit', ratio: 0.5, dimensions: { '1': 'KS01', '20': 'KUND42' } },
      ],
    })

    const [pruned] = await pruneLearnedTemplateDimensions(supabase as never, 'company-1', [template])

    expect(pruned.line_pattern).toEqual([
      { account: '2641', type: 'vat', side: 'debit', vat_rate: 0.25 },
      { account: '5410', type: 'business', side: 'debit', ratio: 0.5 },
      { account: '6110', type: 'business', side: 'debit', ratio: 0.5, dimensions: { '1': 'KS01' } },
    ])
    expect(logWarn.mock.calls[0][1].dropped).toEqual([
      { sie_dim_no: '6', code: 'P001', reason: 'archived_value' },
      { sie_dim_no: '20', code: 'KUND42', reason: 'unknown_dimension' },
    ])
  })

  it('leaves templates whose codes are all active untouched (same objects, no warning)', async () => {
    const { supabase } = createTableMockSupabase(REGISTRY)
    const template = makeCategorizationTemplate({ default_dimensions: { '1': 'KS01', '6': 'P002' } })

    const result = await pruneLearnedTemplateDimensions(supabase as never, 'company-1', [template])

    expect(result[0]).toBe(template)
    expect(logWarn).not.toHaveBeenCalled()
  })

  it('keeps the bags verbatim for a company without dimensions enabled (the engine accepts free text there)', async () => {
    const { supabase } = createTableMockSupabase({ ...REGISTRY, company_settings: { data: { dimensions_enabled: false } } })
    const template = makeCategorizationTemplate({ default_dimensions: { '6': 'P001' } })

    const result = await pruneLearnedTemplateDimensions(supabase as never, 'company-1', [template])

    expect(result[0]).toBe(template)
  })

  it('reads nothing when no template carries a learned bag', async () => {
    const { supabase } = createTableMockSupabase(REGISTRY)

    const result = await pruneLearnedTemplateDimensions(supabase as never, 'company-1', [
      makeCategorizationTemplate(),
      makeCategorizationTemplate({ default_dimensions: {} }),
    ])

    expect(result).toHaveLength(2)
    expect(supabase.from).not.toHaveBeenCalled()
  })

  it('fails open: a registry lookup that throws keeps the bags', async () => {
    const { supabase } = createTableMockSupabase(REGISTRY)
    supabase.from.mockImplementation(() => {
      throw new Error('connection reset')
    })
    const template = makeCategorizationTemplate({ default_dimensions: { '6': 'P001' } })

    const result = await pruneLearnedTemplateDimensions(supabase as never, 'company-1', [template])

    expect(result[0]).toBe(template)
    expect(logWarn).toHaveBeenCalledWith('learned dimension check failed, bags kept', {
      companyId: 'company-1',
      error: 'connection reset',
    })
  })
})

describe('reads that apply learned bags get them pruned', () => {
  it('findCounterpartyTemplatesBatch: the match carries only active codes, and so does the booked business line', async () => {
    const template = makeCategorizationTemplate({
      counterparty_name: 'telia',
      counterparty_aliases: ['telia sverige ab'],
      debit_account: '6200',
      credit_account: '1930',
      default_dimensions: { '1': 'KS01', '6': 'P001' },
    })
    const { supabase } = createTableMockSupabase({ ...REGISTRY, categorization_templates: { data: [template] } })
    const tx = makeTransaction({ id: 'tx-1', merchant_name: 'Telia Sverige AB', amount: -1250 })

    const matches = await findCounterpartyTemplatesBatch(supabase as never, 'company-1', [tx])
    const match = matches.get('tx-1')!

    expect(match.template.default_dimensions).toEqual({ '1': 'KS01' })
    const lines = buildTransactionEntryLines(tx, buildMappingResultFromCounterpartyTemplate(match, tx, 'aktiebolag'))
    expect(lines.find((l) => l.account_number === '6200')?.dimensions).toEqual({ '1': 'KS01' })
  })

  it('loadCounterpartyTemplateMatch: null for an id that is not an active template of the company', async () => {
    const { supabase } = createTableMockSupabase({ ...REGISTRY, categorization_templates: { data: null } })

    expect(await loadCounterpartyTemplateMatch(supabase as never, 'company-1', 'tmpl-x')).toBeNull()
  })

  it('loadCounterpartyTemplateMatch: the picked template as an exact match, learned bags pruned', async () => {
    const template = makeCategorizationTemplate({ id: 'tmpl-1', confidence: 0.9, default_dimensions: { '6': 'P001' } })
    const { supabase, findCall } = createTableMockSupabase({ ...REGISTRY, categorization_templates: { data: template } })

    const match = await loadCounterpartyTemplateMatch(supabase as never, 'company-1', 'tmpl-1')

    expect(match).toMatchObject({ matchMethod: 'exact_alias', confidence: 0.9 })
    expect(match!.template.default_dimensions).toEqual({})
    expect(findCall('categorization_templates', 'eq')).toEqual(['id', 'tmpl-1'])
  })
})
