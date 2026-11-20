/**
 * The AGI panel's three filing routes: the one-click `POST /agi/send-for-signing`
 * (submitAgiChain) and the advanced recovery steps `POST /agi/submit`
 * (submitAgiUnderlag) and `POST /agi/granskningsunderlag`
 * (createAgiSigningLink). The parity case runs the two advanced steps and the
 * one-click chain against the same Skatteverket answers and requires the same
 * declaration flips and settings writes, so the recovery path can no longer
 * drift from the chain (it used to flip agi_declarations by period).
 * Skatteverket is never called: the AGI client and the underlag builder are
 * mocked.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'

vi.mock('@/lib/utils', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/utils')>()),
  sleep: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('../lib/declaration-prep', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/declaration-prep')>()),
  buildAgiUnderlag: vi.fn(),
  refreshAgiUnderlag: vi.fn(),
}))
vi.mock('../lib/agi-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/agi-client')>()),
  agiPostUnderlag: vi.fn(),
  agiGetKontrollresultat: vi.fn(),
  agiSkapaGranskningsunderlag: vi.fn(),
}))
vi.mock('@/lib/entitlements/has-capability', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/entitlements/has-capability')>()),
  requireCapability: vi.fn().mockResolvedValue(null),
}))

import type { ExtensionContext } from '@/lib/extensions/types'
import { skatteverketExtension } from '../index'
import { buildAgiUnderlag, refreshAgiUnderlag } from '../lib/declaration-prep'
import { agiGetKontrollresultat, agiPostUnderlag, agiSkapaGranskningsunderlag } from '../lib/agi-client'

const KONTROLL_WITH_WARNING = {
  status: 'DONE_SUCCESS',
  kontrollrapport: {
    status: 'OK',
    antalFel: 0,
    antalVarningar: 1,
    redovisningsperioder: [{
      perioder: [{
        period: '202606',
        antalFel: 0,
        antalVarningar: 1,
        kontrollfel: [{
          felkategori: 'K',
          uppgiftsTyp: 'IU',
          textNyckel: 'IU_VARNING',
          specifikationsnummer: 1,
          identifierare: '199001011234',
          felmeddelande: 'Kontrollera beloppet för 199001011234.',
          felstatus: 'ARENDE',
        }],
      }],
    }],
  },
}

function context() {
  const db = createQueuedMockSupabase()
  // requireSkvWriteRole reads the caller's membership first.
  db.enqueue({ data: { role: 'owner' } })
  const settings = {
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue(undefined),
    clear: vi.fn().mockResolvedValue(undefined),
  }
  const ctx = {
    userId: 'user-1',
    companyId: 'company-1',
    extensionId: 'skatteverket',
    requestId: 'req-agi-steps',
    supabase: db.supabase,
    emit: vi.fn().mockResolvedValue(undefined),
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    settings,
  } as unknown as ExtensionContext
  return { ctx, db, settings }
}

function route(method: string, path: string) {
  const found = skatteverketExtension.apiRoutes?.find(
    (candidate) => candidate.method === method && candidate.path === path,
  )
  return found
}

function post(path: string, body: unknown): Request {
  return new Request(`https://test.local/api/extensions/ext/skatteverket${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

async function call(path: string, body: unknown, ctx: ExtensionContext) {
  const response = await route('POST', path)!.handler(post(path, body), ctx)
  return { status: response.status, json: await response.json() }
}

/** The settings writes without their timestamps, which differ per call. */
function settingsWrites(settings: { set: ReturnType<typeof vi.fn> }) {
  return settings.set.mock.calls.map(([key, value]) => {
    const { updatedAt: _updatedAt, ...rest } = JSON.parse(value as string)
    return [key, rest]
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(refreshAgiUnderlag).mockResolvedValue({ ok: true, outcome: 'unchanged' })
  vi.mocked(buildAgiUnderlag).mockResolvedValue({
    arbetsgivare: '165560000000',
    period: '202606',
    xml: '<Skatteverket/>',
    periodYear: 2026,
    periodMonth: 6,
    salaryRunId: 'run-1',
  } as never)
  vi.mocked(agiPostUnderlag).mockResolvedValue({ ok: true, data: { inlamningId: 42 } } as never)
  vi.mocked(agiGetKontrollresultat).mockResolvedValue({ ok: true, data: KONTROLL_WITH_WARNING } as never)
  vi.mocked(agiSkapaGranskningsunderlag).mockResolvedValue({
    ok: true,
    data: { tillstand: 'LOCKED_FOR_SIGNING', link: 'https://skatteverket.se/sign', meddelande: null },
  } as never)
})

describe('AGI panel filing routes', () => {
  it.each(['/agi/send-for-signing', '/agi/submit', '/agi/granskningsunderlag'])(
    '%s answers 400 without a salaryRunId',
    async (path) => {
      const { ctx } = context()
      const { status, json } = await call(path, {}, ctx)
      expect(status).toBe(400)
      expect(json.error).toContain('salaryRunId')
      expect(agiPostUnderlag).not.toHaveBeenCalled()
      expect(agiSkapaGranskningsunderlag).not.toHaveBeenCalled()
    },
  )

  // Issue #69: the panel's one-click chain and its advanced "Skicka in
  // underlag" both regenerate an unfiled underlag before posting it, whatever
  // agi_generated_at says; only the signing-link step posts nothing.
  it.each(['/agi/send-for-signing', '/agi/submit'])(
    '%s regenerates the run\'s underlag before posting it',
    async (path) => {
      const { ctx } = context()

      const { status } = await call(path, { salaryRunId: 'run-1' }, ctx)

      expect(status).toBe(200)
      expect(refreshAgiUnderlag).toHaveBeenCalledWith(ctx.supabase, 'company-1', 'user-1', 'run-1')
      expect(vi.mocked(refreshAgiUnderlag).mock.invocationCallOrder[0]).toBeLessThan(
        vi.mocked(agiPostUnderlag).mock.invocationCallOrder[0],
      )
    },
  )

  // The refresh replaced the stored XML: the answer says so, and the panel
  // tells the person to review the declaration in Mina sidor before signing.
  it.each(['/agi/send-for-signing', '/agi/submit'])(
    '%s answers underlag_regenerated when the stored XML was replaced',
    async (path) => {
      const { ctx } = context()
      vi.mocked(refreshAgiUnderlag).mockResolvedValue({ ok: true, outcome: 'replaced' })

      const { status, json } = await call(path, { salaryRunId: 'run-1' }, ctx)

      expect(status).toBe(200)
      expect(json.data.underlag_regenerated).toBe(true)
    },
  )

  it.each(['/agi/send-for-signing', '/agi/submit'])(
    '%s says nothing of a regeneration when the stored XML was unchanged',
    async (path) => {
      const { ctx } = context()

      const { status, json } = await call(path, { salaryRunId: 'run-1' }, ctx)

      expect(status).toBe(200)
      expect(json.data).not.toHaveProperty('underlag_regenerated')
    },
  )

  it('POST /agi/send-for-signing keeps its answer as it was when the XML was unchanged', async () => {
    const { ctx } = context()

    const { json } = await call('/agi/send-for-signing', { salaryRunId: 'run-1' }, ctx)

    expect(json.data).toEqual({ signing_url: 'https://skatteverket.se/sign', tillstand: 'LOCKED_FOR_SIGNING', period: '202606' })
  })

  it('POST /agi/granskningsunderlag regenerates nothing: it locks what step 1 posted', async () => {
    const { ctx } = context()

    const { status } = await call('/agi/granskningsunderlag', { salaryRunId: 'run-1' }, ctx)

    expect(status).toBe(200)
    expect(refreshAgiUnderlag).not.toHaveBeenCalled()
  })

  it('POST /agi/send-for-signing answers a refused regeneration with its sentence and posts nothing', async () => {
    const { ctx, db } = context()
    vi.mocked(refreshAgiUnderlag).mockResolvedValue({
      ok: false,
      code: 'AGI_PERIOD_CONFLICT',
      httpStatus: 409,
      error: 'En annan lönekörning är redan deklarerad för samma redovisningsperiod.',
    })

    const { status, json } = await call('/agi/send-for-signing', { salaryRunId: 'run-1' }, ctx)

    expect(status).toBe(409)
    expect(json).toMatchObject({ code: 'AGI_PERIOD_CONFLICT', error: expect.stringContaining('redovisningsperiod') })
    expect(agiPostUnderlag).not.toHaveBeenCalled()
    expect(db.findCall('agi_declarations', 'update')).toBeUndefined()
  })

  it('POST /agi/submit posts, waits for kontroll and returns the masked findings', async () => {
    const { ctx } = context()

    const { status, json } = await call('/agi/submit', { salaryRunId: 'run-1' }, ctx)

    expect(status).toBe(200)
    expect(json.data.inlamningId).toBe(42)
    const finding = json.data.kontrollrapport.redovisningsperioder[0].kontrollfel[0]
    expect(finding.felstatus).toBe('ARENDE')
    // The panel used to render Skatteverket's raw identifierare.
    expect(JSON.stringify(json)).not.toContain('199001011234')
    expect(agiSkapaGranskningsunderlag).not.toHaveBeenCalled()
  })

  it('POST /agi/submit answers a refusal at kontroll with the report and marks the run rejected', async () => {
    const { ctx, db } = context()
    vi.mocked(agiGetKontrollresultat).mockResolvedValue({
      ok: true,
      data: { ...KONTROLL_WITH_WARNING, status: 'DONE_REJECTED' },
    } as never)

    const { status, json } = await call('/agi/submit', { salaryRunId: 'run-1' }, ctx)

    expect(status).toBe(422)
    expect(json.code).toBe('AGI_KONTROLL_REJECTED')
    expect(json.details.kontrollrapport).toBeTruthy()
    expect(db.findCall('agi_declarations', 'update')).toEqual([{ status: 'rejected' }])
    expect(db.findCalls('agi_declarations', 'eq')).toContainEqual(['salary_run_id', 'run-1'])
  })

  it('POST /agi/submit answers a kontroll still processing as 409, never as success', async () => {
    const { ctx } = context()
    vi.mocked(agiGetKontrollresultat).mockResolvedValue({ ok: true, data: { status: 'PROCESSING' } } as never)

    const { status, json } = await call('/agi/submit', { salaryRunId: 'run-1' }, ctx)

    expect(status).toBe(409)
    expect(json.code).toBe('SKATTEVERKET_PROCESSING')
    // The panel's patience: eight reads.
    expect(agiGetKontrollresultat).toHaveBeenCalledTimes(8)
  })

  it('POST /agi/granskningsunderlag locks the run\'s period and flips only that run', async () => {
    const { ctx, db } = context()

    const { status, json } = await call('/agi/granskningsunderlag', { salaryRunId: 'run-1' }, ctx)

    expect(status).toBe(200)
    expect(json.data).toEqual({ link: 'https://skatteverket.se/sign', tillstand: 'LOCKED_FOR_SIGNING' })
    expect(agiSkapaGranskningsunderlag).toHaveBeenCalledWith(
      ctx.supabase, 'user-1', 'company-1', '165560000000', '202606', { lasPeriod: true },
    )
    expect(db.findCall('agi_declarations', 'update')).toEqual([{ status: 'pending_signature' }])
    expect(db.findCalls('agi_declarations', 'eq')).toContainEqual(['salary_run_id', 'run-1'])
    expect(agiPostUnderlag).not.toHaveBeenCalled()
  })

  it('POST /agi/granskningsunderlag refuses incorrect data with the sentence and no flip', async () => {
    const { ctx, db } = context()
    vi.mocked(agiSkapaGranskningsunderlag).mockResolvedValue({
      ok: true,
      data: { tillstand: 'INCORRECT_DATA', link: 'https://skatteverket.se/felrapport', meddelande: 'Fel i underlaget' },
    } as never)

    const { status, json } = await call('/agi/granskningsunderlag', { salaryRunId: 'run-1' }, ctx)

    expect(status).toBe(422)
    expect(json).toMatchObject({ error: 'Fel i underlaget', code: 'AGI_GRANSKNING_INCORRECT' })
    expect(db.findCall('agi_declarations', 'update')).toBeUndefined()
  })

  it('has no kontrollresultat route left: kontroll is polled on the server', () => {
    expect(route('GET', '/agi/kontrollresultat')).toBeUndefined()
  })

  it('parity: the two advanced steps write what the one-click chain writes', async () => {
    const chain = context()
    const chainCall = await call('/agi/send-for-signing', { salaryRunId: 'run-1' }, chain.ctx)
    expect(chainCall.status).toBe(200)

    const steps = context()
    const submitCall = await call('/agi/submit', { salaryRunId: 'run-1' }, steps.ctx)
    expect(submitCall.status).toBe(200)
    // A fresh request: the write-role gate reads the membership again.
    steps.db.enqueue({ data: { role: 'owner' } })
    const linkCall = await call('/agi/granskningsunderlag', { salaryRunId: 'run-1' }, steps.ctx)
    expect(linkCall.status).toBe(200)

    expect(linkCall.json.data.link).toBe(chainCall.json.data.signing_url)
    expect(steps.db.findCalls('agi_declarations', 'update')).toEqual(chain.db.findCalls('agi_declarations', 'update'))
    expect(steps.db.findCalls('agi_declarations', 'eq')).toEqual(chain.db.findCalls('agi_declarations', 'eq'))
    expect(steps.db.findCalls('agi_declarations', 'in')).toEqual(chain.db.findCalls('agi_declarations', 'in'))
    expect(settingsWrites(steps.settings)).toEqual(settingsWrites(chain.settings))
  })
})
