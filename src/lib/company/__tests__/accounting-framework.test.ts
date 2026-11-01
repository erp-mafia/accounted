import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { eventBus } from '@/lib/events/bus'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  getFiscalPeriodFramework,
  previousYearFrameworkOf,
  isReliableFrameworkSource,
  listFiscalYearFrameworks,
  pickCurrentFiscalYear,
  resolveAccountingFramework,
  resolveCurrentAccountingFramework,
} from '../accounting-framework'
import { changeAccountingFramework } from '../accounting-framework-change'

const { supabase, enqueue, reset, findCall } = createQueuedMockSupabase()
const client = supabase as unknown as SupabaseClient

const Y2025 = { id: 'fp-2025', name: '2025', period_start: '2025-01-01', period_end: '2025-12-31', is_closed: true, locked_at: null }
const Y2026 = { id: 'fp-2026', name: '2026', period_start: '2026-01-01', period_end: '2026-12-31', is_closed: false, locked_at: null }

beforeEach(() => {
  vi.clearAllMocks()
  reset()
  eventBus.clear()
})

describe('resolveAccountingFramework', () => {
  it('reads the year\'s own row, not the company setting', async () => {
    enqueue({ data: { fiscal_period_id: 'fp-2025', framework: 'k2', source: 'election' } })
    await expect(resolveAccountingFramework(client, 'company-1', 'fp-2025')).resolves.toBe('k2')
    expect(supabase.from).toHaveBeenCalledTimes(1)
    expect(supabase.from).toHaveBeenCalledWith('fiscal_period_frameworks')
  })

  it('falls back to the company default for a year without a row', async () => {
    enqueue({ data: null }) // no row
    enqueue({ data: { accounting_framework: 'k3' } }) // companies
    const row = await getFiscalPeriodFramework(client, 'company-1', 'fp-old')
    expect(row).toMatchObject({ framework: 'k3', source: 'company_fallback', change_reason: null })
  })

  it('throws on a read error instead of guessing a framework', async () => {
    enqueue({ error: { message: 'boom' } })
    await expect(resolveAccountingFramework(client, 'company-1', 'fp-2026')).rejects.toThrow(/boom/)
  })

  it('carries the K3 to K2 switch reasons for the note', async () => {
    enqueue({
      data: {
        fiscal_period_id: 'fp-2026',
        framework: 'k2',
        source: 'election',
        previous_framework: 'k3',
        change_reason: 'Bolaget har minskat i storlek.',
        previously_applied_k2: false,
        special_reasons_confirmed: false,
        decided_at: '2026-03-01T10:00:00Z',
      },
    })
    const row = await getFiscalPeriodFramework(client, 'company-1', 'fp-2026')
    expect(row.change_reason).toBe('Bolaget har minskat i storlek.')
    expect(row.previous_framework).toBe('k3')
  })
})

describe('pickCurrentFiscalYear', () => {
  it('picks the year running today, then the latest started, then the earliest', () => {
    expect(pickCurrentFiscalYear([Y2025, Y2026], '2026-05-01')?.id).toBe('fp-2026')
    expect(pickCurrentFiscalYear([Y2025], '2026-05-01')?.id).toBe('fp-2025')
    expect(pickCurrentFiscalYear([Y2026], '2025-06-01')?.id).toBe('fp-2026')
    expect(pickCurrentFiscalYear([], '2026-05-01')).toBeNull()
  })
})

describe('resolveCurrentAccountingFramework', () => {
  it('resolves the framework of the year running on the given day', async () => {
    enqueue({ data: [Y2025, Y2026] }) // fiscal_periods
    enqueue({ data: { fiscal_period_id: 'fp-2026', framework: 'k3', source: 'election' } })
    await expect(resolveCurrentAccountingFramework(client, 'company-1', '2026-05-01')).resolves.toBe('k3')
    expect(findCall('fiscal_period_frameworks', 'eq')).toEqual(['company_id', 'company-1'])
  })

  it('uses the company default when the company has no fiscal year', async () => {
    enqueue({ data: [] })
    enqueue({ data: { accounting_framework: 'k2' } })
    await expect(resolveCurrentAccountingFramework(client, 'company-1', '2026-05-01')).resolves.toBe('k2')
  })
})

describe('listFiscalYearFrameworks', () => {
  it('lists each year with its own framework, oldest first', async () => {
    enqueue({ data: [Y2025, Y2026] })
    enqueue({
      data: [
        { fiscal_period_id: 'fp-2025', framework: 'k2', source: 'company_default', change_reason: null },
        { fiscal_period_id: 'fp-2026', framework: 'k3', source: 'election', change_reason: null },
      ],
    })
    enqueue({ data: { accounting_framework: 'k3' } })
    const years = await listFiscalYearFrameworks(client, 'company-1')
    expect(years.map((y) => [y.name, y.framework, y.source])).toEqual([
      ['2025', 'k2', 'company_default'],
      ['2026', 'k3', 'election'],
    ])
  })
})

describe('previousYearFrameworkOf', () => {
  it('treats a backfilled previous year as unreliable', async () => {
    enqueue({ data: { fiscal_period_id: 'fp-2025', framework: 'k3', source: 'company_default' } })
    const previous = await previousYearFrameworkOf(client, 'company-1', 'fp-2025')
    expect(previous).toMatchObject({ fiscal_period_id: 'fp-2025', framework: 'k3', reliable: false })
  })

  it('relies on an elected previous year', async () => {
    enqueue({ data: { fiscal_period_id: 'fp-2025', framework: 'k2', source: 'election' } })
    const previous = await previousYearFrameworkOf(client, 'company-1', 'fp-2025')
    expect(previous).toMatchObject({ framework: 'k2', reliable: true })
  })

  it('relies on a previous year taken from its locked årsredovisning', async () => {
    enqueue({ data: { fiscal_period_id: 'fp-2025', framework: 'k2', source: 'annual_report' } })
    const previous = await previousYearFrameworkOf(client, 'company-1', 'fp-2025')
    expect(previous).toMatchObject({ framework: 'k2', source: 'annual_report', reliable: true })
  })

  it('answers nulls when Accounted holds no previous year', async () => {
    const previous = await previousYearFrameworkOf(client, 'company-1', null)
    expect(previous).toEqual({ fiscal_period_id: null, framework: null, source: null, reliable: false })
  })
})

describe('isReliableFrameworkSource', () => {
  it('relies on an election, a locked årsredovisning and a year that followed one, never on a default', () => {
    expect(isReliableFrameworkSource('election')).toBe(true)
    expect(isReliableFrameworkSource('annual_report')).toBe(true)
    expect(isReliableFrameworkSource('previous_year')).toBe(true)
    expect(isReliableFrameworkSource('company_default')).toBe(false)
    expect(isReliableFrameworkSource('company_fallback')).toBe(false)
    expect(isReliableFrameworkSource(null)).toBe(false)
  })
})

describe('changeAccountingFramework', () => {
  const ctx = { supabase: client, companyId: 'company-1', userId: 'user-1' }

  it('refuses K3 for a form that does not offer it, before any write', async () => {
    enqueue({ data: { entity_type: 'enskild_firma', accounting_framework: 'k2' } })
    await expect(changeAccountingFramework(ctx, { framework: 'k3' })).rejects.toMatchObject({
      code: 'ACCOUNTING_FRAMEWORK_FORM_UNSUPPORTED',
    })
    expect(supabase.rpc).not.toHaveBeenCalled()
  })

  it('sets the year running today through the RPC and emits the event', async () => {
    const handler = vi.fn()
    eventBus.on('company.accounting_framework_changed', handler)
    enqueue({ data: { entity_type: 'aktiebolag', accounting_framework: 'k2' } })
    enqueue({ data: [Y2025, Y2026] })
    enqueue({
      data: {
        ok: true,
        changed: true,
        framework: 'k3',
        previous_framework: 'k2',
        k3_to_k2: false,
        fiscal_period_id: 'fp-2026',
        cascaded_period_ids: ['fp-2027'],
        company_framework: 'k3',
      },
    })
    const result = await changeAccountingFramework(ctx, { framework: 'k3' }, { todayIso: '2026-05-01' })
    expect(result).toMatchObject({ fiscal_period_id: 'fp-2026', framework: 'k3', changed: true, cascaded_period_ids: ['fp-2027'] })
    expect(supabase.rpc).toHaveBeenCalledWith('set_fiscal_period_framework', {
      p_company_id: 'company-1',
      p_fiscal_period_id: 'fp-2026',
      p_framework: 'k3',
      p_change_reason: null,
      p_previously_applied_k2: null,
      p_special_reasons_confirmed: null,
      p_user_id: 'user-1',
      p_dry_run: false,
      p_previous_year_framework: null,
    })
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ companyId: 'company-1', fiscalPeriodId: 'fp-2026', framework: 'k3', previousFramework: 'k2' }),
    )
  })

  it('maps a refusal of the RPC to its structured-error code and emits nothing', async () => {
    const handler = vi.fn()
    eventBus.on('company.accounting_framework_changed', handler)
    enqueue({ data: { entity_type: 'aktiebolag', accounting_framework: 'k3' } })
    enqueue({ data: { ok: false, code: 'FRAMEWORK_SPECIAL_REASONS_REQUIRED' } })
    await expect(
      changeAccountingFramework(ctx, { framework: 'k2', fiscal_period_id: 'fp-2026', change_reason: 'Skatteskäl' }),
    ).rejects.toMatchObject({ code: 'ACCOUNTING_FRAMEWORK_SPECIAL_REASONS_REQUIRED' })
    expect(handler).not.toHaveBeenCalled()
  })

  it('passes the stated framework of the previous årsredovisning to the RPC', async () => {
    enqueue({ data: { entity_type: 'aktiebolag', accounting_framework: 'k3' } })
    enqueue({
      data: { ok: true, changed: true, framework: 'k2', previous_framework: 'k3', k3_to_k2: false, fiscal_period_id: 'fp-2026', company_framework: 'k2' },
    })
    const result = await changeAccountingFramework(ctx, {
      framework: 'k2',
      fiscal_period_id: 'fp-2026',
      previous_year_framework: 'k2',
    })
    expect(result.k3_to_k2).toBe(false)
    expect(supabase.rpc).toHaveBeenCalledWith(
      'set_fiscal_period_framework',
      expect.objectContaining({ p_framework: 'k2', p_previous_year_framework: 'k2' }),
    )
  })

  it('maps K2 refused for a bostadsrättsförening to its code', async () => {
    enqueue({ data: { entity_type: 'aktiebolag', accounting_framework: 'k3' } })
    enqueue({ data: { ok: false, code: 'FRAMEWORK_K2_NOT_ALLOWED' } })
    await expect(changeAccountingFramework(ctx, { framework: 'k2', fiscal_period_id: 'fp-2026' })).rejects.toMatchObject({
      code: 'ACCOUNTING_FRAMEWORK_K2_NOT_ALLOWED',
    })
  })

  it('maps an unknown previous årsredovisning and a form the database refuses to their codes', async () => {
    enqueue({ data: { entity_type: 'aktiebolag', accounting_framework: 'k3' } })
    enqueue({ data: { ok: false, code: 'FRAMEWORK_PREVIOUS_YEAR_UNKNOWN' } })
    await expect(changeAccountingFramework(ctx, { framework: 'k2', fiscal_period_id: 'fp-2026' })).rejects.toMatchObject({
      code: 'ACCOUNTING_FRAMEWORK_PREVIOUS_YEAR_UNKNOWN',
    })
    enqueue({ data: { entity_type: 'aktiebolag', accounting_framework: 'k2' } })
    enqueue({ data: { ok: false, code: 'FRAMEWORK_FORM_UNSUPPORTED' } })
    await expect(changeAccountingFramework(ctx, { framework: 'k3', fiscal_period_id: 'fp-2026' })).rejects.toMatchObject({
      code: 'ACCOUNTING_FRAMEWORK_FORM_UNSUPPORTED',
    })
  })

  it('maps a closed year and a locked årsredovisning to their own codes', async () => {
    enqueue({ data: { entity_type: 'aktiebolag', accounting_framework: 'k2' } })
    enqueue({ data: { ok: false, code: 'FRAMEWORK_PERIOD_CLOSED' } })
    await expect(changeAccountingFramework(ctx, { framework: 'k3', fiscal_period_id: 'fp-2025' })).rejects.toMatchObject({
      code: 'ACCOUNTING_FRAMEWORK_PERIOD_CLOSED',
    })
    enqueue({ data: { entity_type: 'aktiebolag', accounting_framework: 'k2' } })
    enqueue({ data: { ok: false, code: 'FRAMEWORK_REPORT_LOCKED' } })
    await expect(changeAccountingFramework(ctx, { framework: 'k3', fiscal_period_id: 'fp-2026' })).rejects.toMatchObject({
      code: 'ACCOUNTING_FRAMEWORK_REPORT_LOCKED',
    })
  })

  it('a dry run asks the RPC to check only and emits nothing', async () => {
    const handler = vi.fn()
    eventBus.on('company.accounting_framework_changed', handler)
    enqueue({ data: { entity_type: 'aktiebolag', accounting_framework: 'k2' } })
    enqueue({ data: { ok: true, dry_run: true, changed: true, framework: 'k3', previous_framework: 'k2' } })
    const result = await changeAccountingFramework(ctx, { framework: 'k3', fiscal_period_id: 'fp-2026' }, { dryRun: true })
    expect(result.dry_run).toBe(true)
    expect((supabase.rpc as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][1]).toMatchObject({ p_dry_run: true })
    expect(handler).not.toHaveBeenCalled()
  })

  it('with no fiscal year only the company default changes', async () => {
    enqueue({ data: { entity_type: 'aktiebolag', accounting_framework: 'k2' } })
    enqueue({ data: [] }) // fiscal_periods
    enqueue({ data: null }) // update
    const result = await changeAccountingFramework(ctx, { framework: 'k3' })
    expect(result).toMatchObject({ fiscal_period_id: null, framework: 'k3', changed: true })
    expect(findCall('companies', 'update')).toEqual([{ accounting_framework: 'k3' }])
    expect(supabase.rpc).not.toHaveBeenCalled()
  })
})
