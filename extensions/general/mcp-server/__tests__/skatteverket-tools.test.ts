/**
 * Safety tests for the Skatteverket MCP tools (PR5).
 *
 * Five tools wrap the skatteverket extension lib: two read tools hit SKV live
 * (validate, status) and two submit tools stage high-risk ops whose commit
 * dispatches into the extension (covered separately in
 * lib/pending-operations/__tests__/skatteverket-executors.test.ts). The
 * cross-extension lib modules are mocked so no real SKV call is made.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { TOOL_SCOPE_MAP, findStageApproveConflict } from '@/lib/auth/api-keys'

const mockSkvRequest = vi.fn()
vi.mock('@/extensions/general/skatteverket/lib/api-client', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return { ...actual, skvRequest: (...a: unknown[]) => mockSkvRequest(...a) }
})

const mockBuildMomsuppgift = vi.fn()
const mockResolveRedovisare = vi.fn()
vi.mock('@/extensions/general/skatteverket/lib/declaration-prep', () => ({
  buildMomsuppgift: (...a: unknown[]) => mockBuildMomsuppgift(...a),
  resolveRedovisare: (...a: unknown[]) => mockResolveRedovisare(...a),
}))

const mockKvittenser = vi.fn()
vi.mock('@/extensions/general/skatteverket/lib/agi-client', () => ({
  agiGetKvittenser: (...a: unknown[]) => mockKvittenser(...a),
}))

// Audit writes are exercised in the extension; mock them out here so the test
// supabase queue only has to account for staging reads.
vi.mock('@/extensions/general/skatteverket/lib/audit', () => ({
  writeSkatteverketAudit: vi.fn(),
}))

import { tools } from '../server'
import { SkatteverketAuthError } from '@/extensions/general/skatteverket/lib/api-client'

const validate = tools.find((t) => t.name === 'gnubok_vat_declaration_validate')!
const vatSubmit = tools.find((t) => t.name === 'gnubok_vat_declaration_submit')!
const vatStatus = tools.find((t) => t.name === 'gnubok_vat_declaration_status')!
const agiSubmit = tools.find((t) => t.name === 'gnubok_agi_submit')!
const agiStatus = tools.find((t) => t.name === 'gnubok_agi_status')!

const ALL = [validate, vatSubmit, vatStatus, agiSubmit, agiStatus]

let prevEnv: string | undefined
beforeEach(() => {
  vi.clearAllMocks()
  prevEnv = process.env.SKATTEVERKET_ENABLED
  process.env.SKATTEVERKET_ENABLED = 'true'
})
afterEach(() => {
  if (prevEnv === undefined) delete process.env.SKATTEVERKET_ENABLED
  else process.env.SKATTEVERKET_ENABLED = prevEnv
})

describe('Skatteverket tools: catalog', () => {
  it('registers all five tools', () => {
    expect(ALL.every(Boolean)).toBe(true)
  })

  it('has Title Case titles with the Swedish law term inline', () => {
    expect(validate.title).toBe('Validate VAT Declaration (Momsdeklaration)')
    expect(vatSubmit.title).toBe('Submit VAT Declaration (Momsdeklaration)')
    expect(agiSubmit.title).toBe('Submit AGI Declaration (Arbetsgivardeklaration)')
  })

  it('all are openWorldHint (external system); reads are read-only, submits are not', () => {
    for (const t of ALL) expect(t.annotations.openWorldHint).toBe(true)
    expect(validate.annotations.readOnlyHint).toBe(true)
    expect(vatStatus.annotations.readOnlyHint).toBe(true)
    expect(agiStatus.annotations.readOnlyHint).toBe(true)
    expect(vatSubmit.annotations.readOnlyHint).toBe(false)
    expect(agiSubmit.annotations.readOnlyHint).toBe(false)
  })
})

describe('Skatteverket tools: EXTENSION_DISABLED gate', () => {
  it('every tool throws EXTENSION_DISABLED with the env off, making zero SKV calls', async () => {
    delete process.env.SKATTEVERKET_ENABLED
    const { supabase } = createQueuedMockSupabase()
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    for (const t of ALL) {
      const args = t.name.includes('agi') ? { salary_run_id: 'sr-1' } : { period_type: 'monthly', year: 2025, period: 3 }
      let thrown: unknown
      try {
        await t.execute(args, 'company-1', 'user-1', supabase as never, { type: 'api_key' })
      } catch (err) {
        thrown = err
      }
      expect((thrown as Error & { code?: string })?.code, t.name).toBe('EXTENSION_DISABLED')
    }
    expect(mockSkvRequest).not.toHaveBeenCalled()
    expect(mockKvittenser).not.toHaveBeenCalled()
    expect(fetchSpy).not.toHaveBeenCalled()
    fetchSpy.mockRestore()
  })
})

describe('gnubok_vat_declaration_validate', () => {
  it('maps a SkatteverketAuthError(NOT_CONNECTED) to SKATTEVERKET_NOT_CONNECTED', async () => {
    mockBuildMomsuppgift.mockResolvedValue({ redovisare: '165560000000', redovisningsperiod: '202503', momsuppgift: {} })
    mockSkvRequest.mockRejectedValue(new SkatteverketAuthError('ingen anslutning', 'NOT_CONNECTED'))
    const { supabase } = createQueuedMockSupabase()
    let thrown: unknown
    try {
      await validate.execute({ period_type: 'monthly', year: 2025, period: 3 }, 'company-1', 'user-1', supabase as never, { type: 'api_key' })
    } catch (err) {
      thrown = err
    }
    expect((thrown as Error & { code?: string })?.code).toBe('SKATTEVERKET_NOT_CONNECTED')
  })

  it('happy path returns kontrollresultat', async () => {
    mockBuildMomsuppgift.mockResolvedValue({ redovisare: '165560000000', redovisningsperiod: '202503', momsuppgift: { summaMoms: 100 } })
    mockSkvRequest.mockResolvedValue({ ok: true, status: 200, json: async () => ({ status: 'OK', resultat: [] }) })
    const { supabase } = createQueuedMockSupabase()
    const result = (await validate.execute(
      { period_type: 'monthly', year: 2025, period: 3 }, 'company-1', 'user-1', supabase as never, { type: 'api_key' },
    )) as { kontrollresultat: { status: string }; redovisningsperiod: string }
    expect(result.kontrollresultat.status).toBe('OK')
    expect(result.redovisningsperiod).toBe('202503')
    // Only /kontrollera was called: nothing was saved at SKV.
    expect(mockSkvRequest).toHaveBeenCalledTimes(1)
    expect(mockSkvRequest.mock.calls[0][4]).toMatch(/^\/kontrollera\//)
  })
})

describe('gnubok_vat_declaration_submit', () => {
  it('validates via /kontrollera then stages: never touches /utkast', async () => {
    mockBuildMomsuppgift.mockResolvedValue({ redovisare: '165560000000', redovisningsperiod: '202503', momsuppgift: { summaMoms: 100 } })
    mockSkvRequest.mockResolvedValue({ ok: true, status: 200, json: async () => ({ status: 'OK' }) })
    const { supabase, enqueue } = createQueuedMockSupabase()
    // stagePendingOperation: resolvePeriodStatusForDate (company_settings + fiscal_periods) then insert
    enqueue({ data: null })
    enqueue({ data: null })
    enqueue({ data: { id: 'op-1' }, error: null })

    const result = (await vatSubmit.execute(
      { period_type: 'monthly', year: 2025, period: 3 }, 'company-1', 'user-1', supabase as never, { type: 'api_key' },
    )) as { staged: boolean; risk_level: string; preview: { commit_action: string } }

    expect(result.staged).toBe(true)
    expect(result.risk_level).toBe('high')
    expect(result.preview.commit_action).toMatch(/signering/i)
    // Exactly one SKV call (the stage-time /kontrollera); no /utkast.
    expect(mockSkvRequest).toHaveBeenCalledTimes(1)
    expect(mockSkvRequest.mock.calls[0][4]).toMatch(/^\/kontrollera\//)
  })
})

describe('gnubok_agi_submit', () => {
  it('stages from local preconditions with zero SKV calls', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'sr-1', status: 'booked', period_year: 2026, period_month: 3, payment_date: '2026-03-25' } }) // salary_runs
    enqueue({ data: { id: 'decl-1', status: 'generated', xml_content: '<agi/>' } }) // agi_declarations
    enqueue({ data: null }) // resolvePeriodStatusForDate: company_settings
    enqueue({ data: null }) // resolvePeriodStatusForDate: fiscal_periods
    enqueue({ data: { id: 'op-1' }, error: null }) // insert

    const result = (await agiSubmit.execute(
      { salary_run_id: 'sr-1' }, 'company-1', 'user-1', supabase as never, { type: 'api_key' },
    )) as { staged: boolean; risk_level: string }

    expect(result.staged).toBe(true)
    expect(result.risk_level).toBe('high')
    expect(mockSkvRequest).not.toHaveBeenCalled()
    expect(mockKvittenser).not.toHaveBeenCalled()
  })

  it('throws when no AGI XML exists yet', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'sr-1', status: 'booked', period_year: 2026, period_month: 3, payment_date: '2026-03-25' } })
    enqueue({ data: null }) // no agi_declarations row
    await expect(
      agiSubmit.execute({ salary_run_id: 'sr-1' }, 'company-1', 'user-1', supabase as never, { type: 'api_key' }),
    ).rejects.toThrow(/AGI-underlag saknas/)
  })
})

describe('gnubok_agi_status: run-scoped filing state', () => {
  // The period-keyed extension_data record is shared by every salary run of
  // the month (a correction coexists with the run it corrects, migration
  // 20260414130000). The tool must resolve it per run via
  // lib/salary/agi-submission-state.ts, exactly like AGIPanel: a correction
  // run reports unfiled-for-this-run even though the ORIGINAL's record says
  // 'signed', so the filing action stays visible.
  const ORIGINAL_RECORD = {
    status: 'signed',
    kvittensnummer: 'KV-ORIG-1',
    salaryRunId: 'sr-original',
    signeradTid: '2026-07-01T09:00:00Z',
    updatedAt: '2026-07-01T09:00:00Z',
  }

  function enqueueStatusReads(
    enqueue: (r: { data?: unknown; error?: unknown }) => void,
    run: Record<string, unknown>,
    record: Record<string, unknown> | null,
  ) {
    enqueue({ data: run }) // salary_runs
    enqueue({ data: record ? { value: JSON.stringify(record) } : null }) // extension_data
  }

  beforeEach(() => {
    mockResolveRedovisare.mockResolvedValue('165560000000')
    // Nothing retrievable live: the run-scoping under test is purely local.
    mockKvittenser.mockResolvedValue({ ok: false, status: 404 })
  })

  it('a correction run reports generated (unfiled) although the period record is the original run\'s signed receipt', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueueStatusReads(enqueue, {
      id: 'sr-correction',
      period_year: 2026,
      period_month: 6,
      agi_generated_at: '2026-07-05T10:00:00Z',
      agi_submitted_at: null,
    }, ORIGINAL_RECORD)

    const result = (await agiStatus.execute(
      { salary_run_id: 'sr-correction' }, 'company-1', 'user-1', supabase as never, { type: 'api_key' },
    )) as {
      filing_state: string
      kvittensnummer: string | null
      local_state: Record<string, unknown> | null
    }

    // The correction has its own XML but no submission of its own: the
    // original's receipt must not render it as filed.
    expect(result.filing_state).toBe('generated')
    expect(result.kvittensnummer).toBeNull()
    expect(result.local_state).toBeNull()
  })

  it('the run that owns the record reports signed with its kvittensnummer', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueueStatusReads(enqueue, {
      id: 'sr-original',
      period_year: 2026,
      period_month: 6,
      agi_generated_at: '2026-06-28T08:00:00Z',
      agi_submitted_at: '2026-07-01T09:00:00Z',
    }, ORIGINAL_RECORD)

    const result = (await agiStatus.execute(
      { salary_run_id: 'sr-original' }, 'company-1', 'user-1', supabase as never, { type: 'api_key' },
    )) as {
      filing_state: string
      kvittensnummer: string | null
      local_state: Record<string, unknown> | null
    }

    expect(result.filing_state).toBe('signed')
    expect(result.kvittensnummer).toBe('KV-ORIG-1')
    expect(result.local_state).toMatchObject({ status: 'signed', salaryRunId: 'sr-original' })
  })

  it('cache deleted by the kvittens cron: the receipt is served from agi_declarations (#1597)', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueueStatusReads(enqueue, {
      id: 'sr-original',
      period_year: 2026,
      period_month: 6,
      agi_generated_at: '2026-06-28T08:00:00Z',
      agi_submitted_at: '2026-07-01T09:00:00Z',
    }, null)
    enqueue({
      data: {
        salary_run_id: 'sr-original',
        status: 'submitted',
        kvittensnummer: 'KV-ORIG-1',
        submitted_at: '2026-07-01T09:00:00Z',
        response_data: {
          signeradAv: '191212121212',
          signeradTid: '2026-07-01T09:00:00Z',
          submittedAtEstimated: false,
        },
      },
    }) // agi_declarations

    const result = (await agiStatus.execute(
      { salary_run_id: 'sr-original' }, 'company-1', 'user-1', supabase as never, { type: 'api_key' },
    )) as {
      filing_state: string
      kvittensnummer: string | null
      local_state: Record<string, unknown> | null
    }

    expect(result.filing_state).toBe('signed')
    expect(result.kvittensnummer).toBe('KV-ORIG-1')
    expect(result.local_state).toMatchObject({
      status: 'signed',
      signeradAv: '191212121212',
      submittedAtEstimated: false,
      source: 'declaration',
    })
  })

  it('a run with neither XML nor record reports none', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueueStatusReads(enqueue, {
      id: 'sr-fresh',
      period_year: 2026,
      period_month: 6,
      agi_generated_at: null,
      agi_submitted_at: null,
    }, null)

    const result = (await agiStatus.execute(
      { salary_run_id: 'sr-fresh' }, 'company-1', 'user-1', supabase as never, { type: 'api_key' },
    )) as { filing_state: string; kvittensnummer: string | null; local_state: unknown }

    expect(result.filing_state).toBe('none')
    expect(result.kvittensnummer).toBeNull()
    expect(result.local_state).toBeNull()
  })
})

describe('Skatteverket tools: scopes', () => {
  it('maps the five tools to the right scopes', () => {
    expect(TOOL_SCOPE_MAP.gnubok_vat_declaration_validate).toBe('compliance:read')
    expect(TOOL_SCOPE_MAP.gnubok_vat_declaration_status).toBe('compliance:read')
    expect(TOOL_SCOPE_MAP.gnubok_agi_status).toBe('compliance:read')
    expect(TOOL_SCOPE_MAP.gnubok_vat_declaration_submit).toBe('skatteverket:write')
    expect(TOOL_SCOPE_MAP.gnubok_agi_submit).toBe('skatteverket:write')
  })

  it('skatteverket:write is a staging scope → SoD conflict with approve', () => {
    expect(findStageApproveConflict(['skatteverket:write', 'pending_operations:approve'])).toBe('skatteverket:write')
    expect(findStageApproveConflict(['skatteverket:write'])).toBeNull()
  })
})
