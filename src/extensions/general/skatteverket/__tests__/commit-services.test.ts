/**
 * Tests for the extension's registry-exposed commit services: specifically the
 * VAT "send for signing" chain (POST /utkast → PUT /las → signeringslänk), the
 * SKATTEVERKET_ENABLED flag gate, and SkatteverketAuthError → recoverable
 * mapping. The op-lifecycle translation is covered separately in
 * lib/pending-operations/__tests__/skatteverket-executors.test.ts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const mockSkvRequest = vi.fn()
vi.mock('../lib/api-client', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return { ...actual, skvRequest: (...a: unknown[]) => mockSkvRequest(...a) }
})

const mockBuildMomsuppgift = vi.fn()
const mockRefreshAgiUnderlag = vi.fn()
const mockBuildAgiUnderlag = vi.fn()
vi.mock('../lib/declaration-prep', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return {
    ...actual,
    buildMomsuppgift: (...a: unknown[]) => mockBuildMomsuppgift(...a),
    refreshAgiUnderlag: (...a: unknown[]) => mockRefreshAgiUnderlag(...a),
    buildAgiUnderlag: (...a: unknown[]) => mockBuildAgiUnderlag(...a),
  }
})

const mockAgiPostUnderlag = vi.fn()
const mockAgiGetKontrollresultat = vi.fn()
const mockAgiSkapaGranskningsunderlag = vi.fn()
vi.mock('../lib/agi-client', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return {
    ...actual,
    agiPostUnderlag: (...a: unknown[]) => mockAgiPostUnderlag(...a),
    agiGetKontrollresultat: (...a: unknown[]) => mockAgiGetKontrollresultat(...a),
    agiSkapaGranskningsunderlag: (...a: unknown[]) => mockAgiSkapaGranskningsunderlag(...a),
  }
})

vi.mock('../lib/audit', () => ({ writeSkatteverketAudit: vi.fn() }))

// The chain's completeness verdict runs for real; only its per-verifikat
// ledger scan is stubbed.
vi.mock('@/lib/reports/rc-basis-gaps', () => ({ findRcBasisGaps: vi.fn(async () => []) }))

vi.mock('@/lib/extensions/context-factory', () => ({
  createExtensionContext: () => ({
    supabase: {rpc:vi.fn().mockResolvedValue({data:'read-lease-token',error:null})},
    companyId: 'company-1',
    userId: 'user-1',
    settings: { set: vi.fn().mockResolvedValue(undefined) },
    log: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
  }),
}))

import { createQueuedMockSupabase } from '@/tests/helpers'
import { skatteverketExtension } from '../index'
import { SkatteverketAuthError, asSkvUnavailable } from '../lib/api-client'
import { NO_ANSWER } from './skv-no-answer-fixture'
import { vatDeclarationFixture } from './vat-declaration-fixture'

const MARCH = { type: 'monthly' as const, year: 2025, period: 3, start: '2025-03-01', end: '2025-03-31' }

type SkvSubmitFn = (
  supabase: unknown, userId: string, companyId: string, params: Record<string, unknown>,
) => Promise<{
  ok: boolean; code?: string; recoverable?: boolean; signing_url?: string; error?: string
  details?: Record<string, unknown>
}>

const commitSubmitVatDeclaration = skatteverketExtension.services!.commitSubmitVatDeclaration as unknown as SkvSubmitFn
const VAT_PARAMS = { period_type: 'monthly', year: 2025, period: 3 }

let prevEnv: string | undefined
beforeEach(() => {
  vi.clearAllMocks()
  prevEnv = process.env.SKATTEVERKET_ENABLED
  process.env.SKATTEVERKET_ENABLED = 'true'
  mockBuildMomsuppgift.mockResolvedValue({
    redovisare: '165560000000', redovisningsperiod: '202503', momsuppgift: { summaMoms: 150 },
    declaration: vatDeclarationFixture({ ruta05: 600, ruta10: 150, ruta49: 150 }, { period: MARCH }),
  })
})
afterEach(() => {
  if (prevEnv === undefined) delete process.env.SKATTEVERKET_ENABLED
  else process.env.SKATTEVERKET_ENABLED = prevEnv
})

// MCP gnubok_agi_submit at approval (issue #69): the chain regenerates an
// unfiled underlag first, so an op staged before a generator fix files the
// fixed XML, not the one stored at staging time.
describe('commitSubmitAgi', () => {
  const commitSubmitAgi = skatteverketExtension.services!.commitSubmitAgi as unknown as SkvSubmitFn

  beforeEach(() => {
    mockRefreshAgiUnderlag.mockResolvedValue({ ok: true, outcome: 'replaced' })
    mockBuildAgiUnderlag.mockResolvedValue({
      arbetsgivare: '165560000000', period: '202609', xml: '<Skatteverket>fresh</Skatteverket>',
      periodYear: 2026, periodMonth: 9, salaryRunId: 'run-1',
    })
    mockAgiPostUnderlag.mockResolvedValue({ ok: true, data: { inlamningId: 7 } })
    mockAgiGetKontrollresultat.mockResolvedValue({ ok: true, data: { status: 'DONE_SUCCESS' } })
    mockAgiSkapaGranskningsunderlag.mockResolvedValue({
      ok: true, data: { tillstand: 'LOCKED_FOR_SIGNING', link: 'https://skv.test/agi/sign', meddelande: null },
    })
  })

  it('regenerates the run\'s underlag before posting it, then returns the signing link', async () => {
    const { supabase } = createQueuedMockSupabase()

    const result = await commitSubmitAgi(supabase, 'user-1', 'company-1', { salary_run_id: 'run-1' })

    expect(result).toMatchObject({ ok: true, signing_url: 'https://skv.test/agi/sign' })
    expect(mockRefreshAgiUnderlag).toHaveBeenCalledWith(supabase, 'company-1', 'user-1', 'run-1')
    expect(mockRefreshAgiUnderlag.mock.invocationCallOrder[0]).toBeLessThan(mockAgiPostUnderlag.mock.invocationCallOrder[0])
    expect(mockAgiPostUnderlag.mock.calls[0][3]).toBe('<Skatteverket>fresh</Skatteverket>')
  })

  it('says the underlag was regenerated when the stored XML was replaced, with a note for the approver', async () => {
    const { supabase } = createQueuedMockSupabase()

    const result = await commitSubmitAgi(supabase, 'user-1', 'company-1', { salary_run_id: 'run-1' })

    expect(result).toMatchObject({ ok: true, underlag_regenerated: true, note: expect.stringContaining('Mina sidor') })
  })

  it('says nothing of a regeneration when the stored XML was unchanged', async () => {
    const { supabase } = createQueuedMockSupabase()
    mockRefreshAgiUnderlag.mockResolvedValue({ ok: true, outcome: 'unchanged' })

    const result = await commitSubmitAgi(supabase, 'user-1', 'company-1', { salary_run_id: 'run-1' })

    expect(result).toEqual({
      ok: true,
      signing_url: 'https://skv.test/agi/sign',
      arbetsgivare: '165560000000',
      period: '202609',
      inlamning_id: 7,
      tillstand: 'LOCKED_FOR_SIGNING',
    })
  })

  // crm#1944: the thrown text of a failed step is an upstream's or our own
  // internals. The approver reads a sentence; the text stays in the log.
  it('an unexpected failure answers a sentence, never the thrown text', async () => {
    const { supabase } = createQueuedMockSupabase()
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    mockAgiPostUnderlag.mockRejectedValue(
      new Error('Failed to clear existing tokens: Edge Error 1104 Script not found | db-host.example.co'),
    )

    const result = await commitSubmitAgi(supabase, 'user-1', 'company-1', { salary_run_id: 'run-1' })

    expect(result).toEqual({
      ok: false,
      code: 'SKATTEVERKET_INTERNAL_ERROR',
      http_status: 500,
      recoverable: false,
      error: 'Ett tekniskt fel uppstod i kontakten med Skatteverket. Försök igen om en stund.',
    })
    const logged = consoleError.mock.calls.flat().map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg))).join('\n')
    expect(logged).toContain('commit service failed')
    expect(logged).toContain('Failed to clear existing tokens')
    consoleError.mockRestore()
  })

  // Skatteverket's service being down says nothing about the AGI: the
  // operation waits and the same approval can be given again, as an approved
  // momsdeklaration does (#212). Until then the proposal was consumed.
  it.each(NO_ANSWER)('%s → the one no-answer answer, retryable, the operation is kept', async (_label, platform) => {
    const { supabase } = createQueuedMockSupabase()
    mockAgiPostUnderlag.mockRejectedValue(asSkvUnavailable(platform()))

    const result = await commitSubmitAgi(supabase, 'user-1', 'company-1', { salary_run_id: 'run-1' })

    expect(result).toEqual({
      ok: false, code: 'SKATTEVERKET_UNAVAILABLE', http_status: 503, recoverable: true,
      error: 'Skatteverket svarade inte i tid. Försök igen om en stund.',
    })
  })

  it('no answer at the signing link, after the underlag was taken, keeps the operation too', async () => {
    const { supabase } = createQueuedMockSupabase()
    mockAgiSkapaGranskningsunderlag.mockRejectedValue(asSkvUnavailable(NO_ANSWER[0][1]()))

    const result = await commitSubmitAgi(supabase, 'user-1', 'company-1', { salary_run_id: 'run-1' })

    expect(result).toMatchObject({ ok: false, code: 'SKATTEVERKET_UNAVAILABLE', http_status: 503, recoverable: true })
  })

  // What the client hands on for a gateway's 503 is not a sentence
  // (agi-client readErrorBody): the approver reads ours.
  it.each([
    [502, 'Skatteverket svarade med 502'],
    [503, '{"error":"Service Unavailable"}'],
    [504, 'Tekniskt fel'],
  ])('Skatteverket answering %i to the underlag → recoverable, the operation is kept', async (status, answer) => {
    const { supabase } = createQueuedMockSupabase()
    mockAgiPostUnderlag.mockResolvedValue({ ok: false, status, error: answer })

    const result = await commitSubmitAgi(supabase, 'user-1', 'company-1', { salary_run_id: 'run-1' })

    expect(result).toEqual({
      ok: false, code: 'SKATTEVERKET_UNAVAILABLE', http_status: 503, recoverable: true,
      error: 'Skatteverkets tjänst har ett tekniskt fel just nu. Försök igen om en stund.',
    })
  })

  it('Skatteverket answering 503 to the kontrollresultat, after the underlag was taken, keeps the operation', async () => {
    const { supabase } = createQueuedMockSupabase()
    mockAgiGetKontrollresultat.mockResolvedValue({ ok: false, status: 503, error: 'Skatteverket svarade med 503' })

    const result = await commitSubmitAgi(supabase, 'user-1', 'company-1', { salary_run_id: 'run-1' })

    expect(result).toMatchObject({ ok: false, code: 'SKATTEVERKET_UNAVAILABLE', http_status: 503, recoverable: true })
    expect(mockAgiSkapaGranskningsunderlag).not.toHaveBeenCalled()
  })

  it('Skatteverket answering 503 to the signing link → recoverable, the operation is kept', async () => {
    const { supabase } = createQueuedMockSupabase()
    mockAgiSkapaGranskningsunderlag.mockResolvedValue({ ok: false, status: 503, error: 'Skatteverket svarade med 503' })

    const result = await commitSubmitAgi(supabase, 'user-1', 'company-1', { salary_run_id: 'run-1' })

    expect(result).toMatchObject({ ok: false, code: 'SKATTEVERKET_UNAVAILABLE', http_status: 503, recoverable: true })
  })

  it.each([400, 500])('a %i from Skatteverket is still a refusal, in its own words: the operation is consumed', async (status) => {
    const { supabase } = createQueuedMockSupabase()
    mockAgiPostUnderlag.mockResolvedValue({ ok: false, status, error: 'Skatteverket tog inte emot underlaget.' })

    const result = await commitSubmitAgi(supabase, 'user-1', 'company-1', { salary_run_id: 'run-1' })

    expect(result).toMatchObject({
      ok: false, code: 'SKATTEVERKET_SUBMIT_REJECTED', http_status: status, recoverable: false,
      error: 'Skatteverket tog inte emot underlaget.',
    })
  })

  // Only a refused Skatteverket call carries Skatteverket's status. A step of
  // our own that answers 503 is a verdict on the run and consumes the proposal.
  it('a 503 that is not Skatteverket\'s (a refused regeneration) is not read as service down', async () => {
    const { supabase } = createQueuedMockSupabase()
    mockRefreshAgiUnderlag.mockResolvedValue({
      ok: false, code: 'AGI_GENERATION_FAILED', httpStatus: 503, error: 'AGI-underlaget kunde inte skapas.',
    })

    const result = await commitSubmitAgi(supabase, 'user-1', 'company-1', { salary_run_id: 'run-1' })

    expect(result).toMatchObject({
      ok: false, code: 'AGI_GENERATION_FAILED', http_status: 503, recoverable: false,
      error: 'AGI-underlaget kunde inte skapas.',
    })
    expect(mockAgiPostUnderlag).not.toHaveBeenCalled()
  })

  it('a lost Skatteverket connection stays recoverable: the user reconnects and approves again', async () => {
    const { supabase } = createQueuedMockSupabase()
    mockAgiPostUnderlag.mockRejectedValue(new SkatteverketAuthError('Ingen anslutning till Skatteverket.', 'NOT_CONNECTED'))

    const result = await commitSubmitAgi(supabase, 'user-1', 'company-1', { salary_run_id: 'run-1' })

    expect(result).toMatchObject({
      ok: false, code: 'SKATTEVERKET_NOT_CONNECTED', recoverable: true, error: 'Ingen anslutning till Skatteverket.',
    })
  })

  it('a refused regeneration is non-recoverable and posts nothing', async () => {
    const { supabase } = createQueuedMockSupabase()
    mockRefreshAgiUnderlag.mockResolvedValue({
      ok: false, code: 'AGI_INCOMPLETE_DATA', httpStatus: 400, error: 'AGI kräver telefon.',
    })

    const result = await commitSubmitAgi(supabase, 'user-1', 'company-1', { salary_run_id: 'run-1' })

    expect(result).toMatchObject({
      ok: false, code: 'AGI_INCOMPLETE_DATA', http_status: 400, recoverable: false, error: 'AGI kräver telefon.',
    })
    expect(mockAgiPostUnderlag).not.toHaveBeenCalled()
  })
})

describe('commitSubmitVatDeclaration', () => {
  it('flag off → recoverable EXTENSION_DISABLED, zero SKV calls', async () => {
    delete process.env.SKATTEVERKET_ENABLED
    const result = await commitSubmitVatDeclaration({}, 'user-1', 'company-1', VAT_PARAMS)
    expect(result).toMatchObject({ ok: false, code: 'EXTENSION_DISABLED', recoverable: true })
    expect(mockSkvRequest).not.toHaveBeenCalled()
  })

  it('happy path: POST /utkast then PUT /las → ok with signing_url', async () => {
    mockSkvRequest
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ kontrollResultat: { status: 'OK' } }) }) // utkast
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ signeringsLank: 'https://skv.test/sign/abc' }) }) // las

    const result = await commitSubmitVatDeclaration({}, 'user-1', 'company-1', VAT_PARAMS)

    expect(result).toMatchObject({ ok: true, signing_url: 'https://skv.test/sign/abc' })
    expect(mockSkvRequest).toHaveBeenCalledTimes(2)
    // call order: utkast (POST) before las (PUT)
    expect(mockSkvRequest.mock.calls[0][3]).toBe('POST')
    expect(mockSkvRequest.mock.calls[0][4]).toMatch(/^\/utkast\/165560000000\/202503$/)
    expect(mockSkvRequest.mock.calls[1][3]).toBe('PUT')
    expect(mockSkvRequest.mock.calls[1][4]).toMatch(/^\/las\/165560000000\/202503$/)
  })

  it('utkast rejected by SKV → non-recoverable, no /las call', async () => {
    mockSkvRequest.mockResolvedValueOnce({ ok: false, status: 400, text: async () => 'bad rutor' })
    const result = await commitSubmitVatDeclaration({}, 'user-1', 'company-1', VAT_PARAMS)
    expect(result).toMatchObject({ ok: false, recoverable: false, http_status: 400 })
    expect(mockSkvRequest).toHaveBeenCalledTimes(1) // never reached /las
  })

  // crm#1866: approval of a staged momsdeklaration met a 400 whose envelope
  // held no message. The approver read a JSON string and the stored operation
  // kept nothing of what Skatteverket answered.
  it('a refusal without a reason says so, and carries Skatteverket\'s status and kod in the details', async () => {
    mockSkvRequest.mockResolvedValueOnce({
      ok: false, status: 400,
      text: async () => JSON.stringify({ kod: 400, meddelandeTillAnvandare: null, meddelandeTillUtvecklare: null }),
    })

    const result = await commitSubmitVatDeclaration({}, 'user-1', 'company-1', VAT_PARAMS)

    expect(result).toEqual({
      ok: false,
      code: 'SKATTEVERKET_SUBMIT_REJECTED',
      http_status: 400,
      recoverable: false,
      error:
        'Skatteverket tog inte emot utkastet och angav ingen orsak (svarskod 400). Försök igen om en stund. ' +
        'Går det fortfarande inte kan deklarationen lämnas direkt i Skatteverkets e-tjänst.',
      details: { stage: 'draft', draft_saved: false, skv_step: 'draft', skv_status: 400, skv_kod: 400 },
    })
  })

  it('a refused lås carries the saved draft and its kontrollresultat in the details', async () => {
    const kontrollResultat = { status: 'OK', resultat: [] }
    mockSkvRequest
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ kontrollResultat }) }) // utkast
      .mockResolvedValueOnce({
        ok: false, status: 409,
        text: async () => JSON.stringify({ kod: 409, meddelandeTillAnvandare: 'Begäran kan ej utföras', meddelandeTillUtvecklare: null }),
      }) // las

    const result = await commitSubmitVatDeclaration({}, 'user-1', 'company-1', VAT_PARAMS)

    expect(result).toMatchObject({
      ok: false, code: 'SKATTEVERKET_SUBMIT_REJECTED', http_status: 409, recoverable: false,
      details: {
        stage: 'lock', draft_saved: true, skv_step: 'lock', skv_status: 409, skv_kod: 409,
        skv_user_message: 'Begäran kan ej utföras', kontrollresultat: kontrollResultat,
      },
    })
    expect(result.error).toMatch(/^Utkastet är sparat hos Skatteverket\. Skatteverket låste inte utkastet för signering: Begäran kan ej utföras\./)
  })

  // Skatteverket's service being down says nothing about the declaration:
  // the operation waits, and the same approval can be given again.
  it.each([502, 503, 504])('Skatteverket answering %i → recoverable, the operation is kept', async (status) => {
    mockSkvRequest.mockResolvedValueOnce({
      ok: false, status,
      text: async () => JSON.stringify({ kod: status, meddelandeTillAnvandare: 'Tekniskt fel', meddelandeTillUtvecklare: 'Service unavailable' }),
    })

    const result = await commitSubmitVatDeclaration({}, 'user-1', 'company-1', VAT_PARAMS)

    expect(result).toMatchObject({ ok: false, code: 'SKATTEVERKET_UNAVAILABLE', http_status: 503, recoverable: true })
    expect(result.error).toBe(
      'Skatteverket tog inte emot utkastet: Tekniskt fel. Skatteverkets detalj: Service unavailable. ' +
        'Skatteverkets tjänst har ett tekniskt fel just nu. Försök igen om en stund.',
    )
  })

  it('a 500 from Skatteverket is still a refusal: one that comes back every time is not cured by waiting', async () => {
    mockSkvRequest.mockResolvedValueOnce({
      ok: false, status: 500,
      text: async () => JSON.stringify({ kod: 500, meddelandeTillAnvandare: 'Tekniskt fel', meddelandeTillUtvecklare: 'Internal server error' }),
    })

    const result = await commitSubmitVatDeclaration({}, 'user-1', 'company-1', VAT_PARAMS)

    expect(result).toMatchObject({ ok: false, code: 'SKATTEVERKET_SUBMIT_REJECTED', http_status: 500, recoverable: false })
  })

  it('a lock that returns no signing link is our own 502, not Skatteverket\'s: the operation is consumed', async () => {
    mockSkvRequest
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({}) }) // utkast
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({}) }) // las, no link

    const result = await commitSubmitVatDeclaration({}, 'user-1', 'company-1', VAT_PARAMS)

    expect(result).toMatchObject({ ok: false, code: 'SKATTEVERKET_SUBMIT_REJECTED', http_status: 502, recoverable: false })
  })

  it.each(NO_ANSWER)('%s → the one no-answer answer, retryable, the operation is kept', async (_label, platform) => {
    mockSkvRequest.mockRejectedValueOnce(asSkvUnavailable(platform()))

    const result = await commitSubmitVatDeclaration({}, 'user-1', 'company-1', VAT_PARAMS)

    expect(result).toEqual({
      ok: false, code: 'SKATTEVERKET_UNAVAILABLE', http_status: 503, recoverable: true,
      error: 'Skatteverket svarade inte i tid. Försök igen om en stund.',
    })
  })

  // An op staged while the books passed, approved after they changed: the
  // chain's completeness verdict refuses it before any call to Skatteverket,
  // and the op is consumed (non-recoverable), not released back to pending.
  // VAT_PARAMS is the params shape every op already staged carries.
  it('books now incomplete → non-recoverable VAT_DECLARATION_INCOMPLETE with the findings, zero SKV calls', async () => {
    mockBuildMomsuppgift.mockResolvedValueOnce({
      redovisare: '165560000000', redovisningsperiod: '202503', momsuppgift: { summaMoms: 0 },
      declaration: vatDeclarationFixture({ ruta30: 250, ruta48: 250, ruta49: 0 }, { rc2645: 250, period: MARCH }),
    })

    const result = await commitSubmitVatDeclaration({}, 'user-1', 'company-1', VAT_PARAMS)

    expect(result).toMatchObject({
      ok: false, code: 'VAT_DECLARATION_INCOMPLETE', http_status: 422, recoverable: false,
    })
    expect(result.error).toMatch(/ofullständig/)
    expect(result.details?.completeness_checks).toContainEqual(
      expect.objectContaining({ code: 'RC_BASIS_MISSING', status: 'ERROR' }),
    )
    expect(mockSkvRequest).not.toHaveBeenCalled()
  })

  it('SkatteverketAuthError → recoverable SKATTEVERKET_NOT_CONNECTED', async () => {
    mockSkvRequest.mockRejectedValueOnce(new SkatteverketAuthError('ingen anslutning', 'NOT_CONNECTED'))
    const result = await commitSubmitVatDeclaration({}, 'user-1', 'company-1', VAT_PARAMS)
    expect(result).toMatchObject({ ok: false, code: 'SKATTEVERKET_NOT_CONNECTED', recoverable: true })
  })
})
