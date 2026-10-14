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
// resolveRedovisningsperiod stays REAL: the status tests below exercise the
// fiscal_periods lookup behind it against the queued supabase double.
vi.mock('@/extensions/general/skatteverket/lib/declaration-prep', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return {
    ...actual,
    buildMomsuppgift: (...a: unknown[]) => mockBuildMomsuppgift(...a),
    resolveRedovisare: (...a: unknown[]) => mockResolveRedovisare(...a),
  }
})

// gnubok_vat_declaration_status is the shared read service's door: the
// service itself (company-scoped auth, räkenskapsår resolution, upstream
// errors) is covered in skatteverket/__tests__/declaration-status.test.ts.
const mockFetchVatDeclarationStatus = vi.fn()
vi.mock('@/extensions/general/skatteverket/lib/declaration-status', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return { ...actual, fetchVatDeclarationStatus: (...a: unknown[]) => mockFetchVatDeclarationStatus(...a) }
})

const mockKvittenser = vi.fn()
vi.mock('@/extensions/general/skatteverket/lib/agi-client', () => ({
  agiGetKvittenser: (...a: unknown[]) => mockKvittenser(...a),
}))

// Audit writes are exercised in the extension; mock them out here so the test
// supabase queue only has to account for staging reads.
vi.mock('@/extensions/general/skatteverket/lib/audit', () => ({
  writeSkatteverketAudit: vi.fn(),
}))

// The completeness verdict runs for real over the declaration buildMomsuppgift
// returns; only its per-verifikat ledger scan is stubbed.
vi.mock('@/lib/reports/rc-basis-gaps', () => ({ findRcBasisGaps: vi.fn(async () => []) }))

import { tools } from '../server'
import { SkatteverketAuthError } from '@/extensions/general/skatteverket/lib/api-client'
import {
  COMPLETE_VAT_DECLARATION,
  INCOMPLETE_VAT_DECLARATION,
} from '@/extensions/general/skatteverket/__tests__/vat-declaration-fixture'

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

describe('VAT tools: period arguments are checked before Skatteverket is called', () => {
  // tools/call enforces neither `required` nor the period_type enum, and the
  // handlers used to cast whatever arrived: a call without `year` reached
  // Skatteverket as redovisningsperiod "undefinedundefined" (7 requests from
  // 6 companies, each answered 400 and handed back as UNKNOWN_ERROR).
  const BAD_ARGS: Record<string, unknown>[] = [
    {},
    { period_type: 'monthly' },
    { period_type: 'monthly', year: 2026 },
    { period_type: 'quarterly', year: 2026, period: 5 },
    { period_type: 'weekly', year: 2026, period: 1 },
    { period_type: 'monthly', year: 'twenty', period: 3 },
  ]

  for (const tool of [validate, vatSubmit, vatStatus]) {
    it(`${tool.name} answers VALIDATION_ERROR with a working example and makes no SKV call`, async () => {
      for (const args of BAD_ARGS) {
        const { supabase } = createQueuedMockSupabase()
        let thrown: unknown
        try {
          await tool.execute(args, 'company-1', 'user-1', supabase as never, { type: 'api_key' })
        } catch (err) {
          thrown = err
        }
        const err = thrown as Error & { code?: string }
        expect(err?.code, JSON.stringify(args)).toBe('VALIDATION_ERROR')
        expect(err.message).toContain('A working call looks like')
      }
      expect(mockSkvRequest).not.toHaveBeenCalled()
      expect(mockBuildMomsuppgift).not.toHaveBeenCalled()
    })
  }

  it('accepts yearly without a period number: helårsmoms has one period per year', async () => {
    mockFetchVatDeclarationStatus.mockResolvedValue({
      ok: true, redovisare: '165560000000', redovisningsperiod: '202612', submitted: null, decided: null,
    })
    const { supabase } = createQueuedMockSupabase()
    await vatStatus.execute(
      { period_type: 'yearly', year: 2026 }, 'company-1', 'user-1', supabase as never, { type: 'api_key' },
    )
    expect(mockFetchVatDeclarationStatus).toHaveBeenCalledWith(
      supabase, 'user-1', 'company-1', { periodType: 'yearly', year: 2026, period: 1, state: 'both' },
    )
  })
})

describe('gnubok_vat_declaration_validate', () => {
  it('maps a SkatteverketAuthError(NOT_CONNECTED) to SKATTEVERKET_NOT_CONNECTED', async () => {
    mockBuildMomsuppgift.mockResolvedValue({ redovisare: '165560000000', redovisningsperiod: '202503', momsuppgift: {}, declaration: COMPLETE_VAT_DECLARATION })
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
    mockBuildMomsuppgift.mockResolvedValue({ redovisare: '165560000000', redovisningsperiod: '202503', momsuppgift: { summaMoms: 100 }, declaration: COMPLETE_VAT_DECLARATION })
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
    // The transport audits the call under the tool's existing label.
    expect(mockSkvRequest.mock.calls[0][5]).toEqual({
      endpoint: 'kontrollera', agRegistreradId: '165560000000', redovisningsperiod: '202503',
    })
  })
})

describe('gnubok_vat_declaration_submit', () => {
  it('validates via /kontrollera then stages: never touches /utkast', async () => {
    mockBuildMomsuppgift.mockResolvedValue({ redovisare: '165560000000', redovisningsperiod: '202503', momsuppgift: { summaMoms: 100 }, declaration: COMPLETE_VAT_DECLARATION })
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

describe('gnubok_vat_declaration_submit: completeness gate', () => {
  // The approval commit runs the same verdict (the submit chain) and would
  // consume the op; refusing here means nothing is staged that cannot file.
  it('refuses an incomplete declaration with VAT_DECLARATION_INCOMPLETE: nothing staged, no Skatteverket call', async () => {
    mockBuildMomsuppgift.mockResolvedValue({
      redovisare: '165560000000', redovisningsperiod: '202503', momsuppgift: { summaMoms: 0 },
      declaration: INCOMPLETE_VAT_DECLARATION,
    })
    const { supabase, findCalls } = createQueuedMockSupabase()

    const thrown = await vatSubmit
      .execute({ period_type: 'monthly', year: 2025, period: 3 }, 'company-1', 'user-1', supabase as never, { type: 'api_key' })
      .then(() => null, (err: unknown) => err as Error & { code?: string; remediation?: { tool?: string } })

    expect(thrown?.code).toBe('VAT_DECLARATION_INCOMPLETE')
    expect(thrown?.message).toMatch(/RC_BASIS_MISSING/)
    expect(thrown?.remediation?.tool).toBe('gnubok_vat_declaration_validate')
    expect(mockSkvRequest).not.toHaveBeenCalled()
    expect(findCalls('pending_operations', 'insert')).toEqual([])
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

  it('previews the payout month as the AGI period (agent feedback seq 948847)', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    // Earned in September, paid in October: declared for October.
    enqueue({ data: { id: 'sr-1', status: 'booked', period_year: 2026, period_month: 9, payment_date: '2026-10-06' } })
    enqueue({ data: { id: 'decl-1', status: 'generated', xml_content: '<agi/>' } })
    enqueue({ data: null }) // resolvePeriodStatusForDate: company_settings
    enqueue({ data: null }) // resolvePeriodStatusForDate: fiscal_periods
    enqueue({ data: { id: 'op-1' }, error: null }) // insert

    const result = (await agiSubmit.execute(
      { salary_run_id: 'sr-1' }, 'company-1', 'user-1', supabase as never, { type: 'api_key' },
    )) as { preview: Record<string, unknown> }

    expect(result.preview.period).toBe('2026-10')
    expect(result.preview.earned_period).toBe('2026-09')
  })

  it('throws when no AGI XML exists yet', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'sr-1', status: 'booked', period_year: 2026, period_month: 3, payment_date: '2026-03-25' } })
    enqueue({ data: null }) // no agi_declarations row
    await expect(
      agiSubmit.execute({ salary_run_id: 'sr-1' }, 'company-1', 'user-1', supabase as never, { type: 'api_key' }),
    ).rejects.toMatchObject({ code: 'AGI_SUBMIT_NOT_GENERATED' })
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

  it('reads the payout month, not the earned month (agent feedback seq 948847)', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueueStatusReads(enqueue, {
      id: 'sr-late',
      period_year: 2026,
      period_month: 9,
      payment_date: '2026-10-06',
      agi_generated_at: '2026-10-05T10:00:00Z',
      agi_submitted_at: null,
    }, null)
    enqueue({ data: null }) // agi_declarations fallback

    const result = (await agiStatus.execute(
      { salary_run_id: 'sr-late' }, 'company-1', 'user-1', supabase as never, { type: 'api_key' },
    )) as { period: string }

    expect(result.period).toBe('202610')
    const keyFilter = findCalls('extension_data', 'eq').find((args) => args[0] === 'key')
    expect(keyFilter?.[1]).toBe('agi_submission_202610')
    expect(mockKvittenser).toHaveBeenCalledWith(expect.anything(), '165560000000', '202610', expect.anything())
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

  // Production since July (#973, #2226): Skatteverket's gateway refuses the
  // APIGW client for the hantera API. The submit tool tells the agent to poll
  // this tool after signing; failing it with SKATTEVERKET_ACCESS_DENIED sent
  // the user off to fix a behörighet that was never the problem.
  it('survives the gateway refusing the APIGW client: local state plus kvittens_read unavailable', async () => {
    mockKvittenser.mockRejectedValue(
      new SkatteverketAuthError('Skatteverkets API-gateway nekade anropet.', 'ACCESS_DENIED', 'APIGW_CLIENT_REFUSED'),
    )
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueueStatusReads(enqueue, {
      id: 'sr-waiting',
      period_year: 2026,
      period_month: 9,
      agi_generated_at: '2026-09-21T07:50:00Z',
      agi_submitted_at: null,
    }, { status: 'awaiting_signing', salaryRunId: 'sr-waiting', updatedAt: '2026-09-21T07:58:00Z' })

    const result = (await agiStatus.execute(
      { salary_run_id: 'sr-waiting' }, 'company-1', 'user-1', supabase as never, { type: 'api_key' },
    )) as { filing_state: string; kvittenser: unknown; kvittens_read: string }

    expect(result.filing_state).toBe('awaiting_signing')
    expect(result.kvittenser).toBeNull()
    expect(result.kvittens_read).toBe('unavailable')
  })

  it('reports kvittens_read ok otherwise, and still throws on a dead session', async () => {
    const live = createQueuedMockSupabase()
    enqueueStatusReads(live.enqueue, {
      id: 'sr-fresh', period_year: 2026, period_month: 6, agi_generated_at: null, agi_submitted_at: null,
    }, null)
    const ok = (await agiStatus.execute(
      { salary_run_id: 'sr-fresh' }, 'company-1', 'user-1', live.supabase as never, { type: 'api_key' },
    )) as { kvittens_read: string }
    expect(ok.kvittens_read).toBe('ok')

    mockKvittenser.mockRejectedValue(new SkatteverketAuthError('Sessionen har gått ut.', 'SESSION_EXPIRED'))
    const dead = createQueuedMockSupabase()
    enqueueStatusReads(dead.enqueue, {
      id: 'sr-fresh', period_year: 2026, period_month: 6, agi_generated_at: null, agi_submitted_at: null,
    }, null)
    await expect(
      agiStatus.execute({ salary_run_id: 'sr-fresh' }, 'company-1', 'user-1', dead.supabase as never, { type: 'api_key' }),
    ).rejects.toBeTruthy()
  })
})

describe('gnubok_vat_declaration_status: the company-scoped read the v1 route and dashboard make', () => {
  // The tool used to read with the caller's own Skatteverket token only, so a
  // member who had not connected BankID personally got NOT_CONNECTED for a
  // company whose declaration v1 and the dashboard read fine (through another
  // member's token or the ombud grant). It now calls the same service.
  it('calls fetchVatDeclarationStatus with the period and state, and returns its answer', async () => {
    mockFetchVatDeclarationStatus.mockResolvedValue({
      ok: true, redovisare: '165560000000', redovisningsperiod: '202603',
      submitted: { kvittensnummer: 'K1' }, decided: null,
    })
    const { supabase } = createQueuedMockSupabase()

    const result = await vatStatus.execute(
      { period_type: 'yearly', year: 2026, period: 1, state: 'submitted' }, 'company-1', 'user-1', supabase as never, { type: 'api_key' },
    )

    expect(mockFetchVatDeclarationStatus).toHaveBeenCalledWith(
      supabase, 'user-1', 'company-1', { periodType: 'yearly', year: 2026, period: 1, state: 'submitted' },
    )
    expect(result).toEqual({
      redovisare: '165560000000', redovisningsperiod: '202603', submitted: { kvittensnummer: 'K1' }, decided: null,
    })
    // No door-local Skatteverket call or token read.
    expect(mockSkvRequest).not.toHaveBeenCalled()
  })

  it.each([
    ['SKATTEVERKET_NOT_CONNECTED', 401, 'Inte ansluten till Skatteverket.'],
    ['SKATTEVERKET_API_ERROR', 502, 'Skatteverket svarade med 500.'],
    ['VALIDATION_ERROR', 400, 'Organisationsnummer saknas i företagsinställningar'],
  ])('throws the service failure under its structured code: %s', async (code, httpStatus, error) => {
    mockFetchVatDeclarationStatus.mockResolvedValue({ ok: false, code, http_status: httpStatus, error })
    const { supabase } = createQueuedMockSupabase()

    await expect(
      vatStatus.execute({ period_type: 'quarterly', year: 2026, period: 1 }, 'company-1', 'user-1', supabase as never, { type: 'api_key' }),
    ).rejects.toMatchObject({ code, message: error })
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

describe('gnubok_vat_declaration_status: output schema matches what Skatteverket sends', () => {
  // inlämnat is a LIST of submissions. A client that validates
  // structuredContent refused the whole result while the schema said object
  // (feedback seq 694132); via gnubok_call_tool the same call worked.
  it('allows an array for submitted and decided', () => {
    const props = (vatStatus.outputSchema as { properties: Record<string, { type: string[] }> }).properties
    expect(props.submitted.type).toEqual(expect.arrayContaining(['object', 'array', 'null']))
    expect(props.decided.type).toEqual(expect.arrayContaining(['object', 'array', 'null']))
  })

  it('passes an array answer through unchanged', async () => {
    const submissions = [{ kvittensnummer: 'K1' }, { kvittensnummer: 'K2' }]
    mockFetchVatDeclarationStatus.mockResolvedValue({
      ok: true, redovisare: '165560000000', redovisningsperiod: '202606', submitted: submissions, decided: null,
    })
    const { supabase } = createQueuedMockSupabase()

    const result = await vatStatus.execute(
      { period_type: 'quarterly', year: 2026, period: 2, state: 'submitted' }, 'company-1', 'user-1', supabase as never, { type: 'api_key' },
    ) as { submitted: unknown }

    expect(result.submitted).toEqual(submissions)
  })
})
