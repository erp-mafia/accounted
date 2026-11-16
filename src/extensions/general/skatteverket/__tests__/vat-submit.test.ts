/**
 * Tests for the shared VAT submit chain (kontrollera -> utkast -> lås).
 * Covers the stage discriminator semantics that the one-click route and the
 * pending-operations commit service both rely on: validation errors abort
 * before any SKV write, draft failures are retry-safe, lock failures report
 * that the draft survived in Eget utrymme.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockSkvRequest = vi.fn()
vi.mock('../lib/api-client', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return { ...actual, skvRequest: (...a: unknown[]) => mockSkvRequest(...a) }
})

const mockBuildMomsuppgift = vi.fn()
vi.mock('../lib/declaration-prep', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return { ...actual, buildMomsuppgift: (...a: unknown[]) => mockBuildMomsuppgift(...a) }
})

vi.mock('../lib/audit', () => ({ writeSkatteverketAudit: vi.fn() }))

// The completeness verdict runs for real over the declaration the prep
// returns; only its per-verifikat ledger scan is stubbed.
const mockFindRcBasisGaps = vi.fn()
vi.mock('@/lib/reports/rc-basis-gaps', () => ({
  findRcBasisGaps: (...a: unknown[]) => mockFindRcBasisGaps(...a),
}))

import { submitVatDeclarationChain } from '../lib/vat-submit'
import type { ExtensionContext } from '@/lib/extensions/types'
import { COMPLETE_VAT_DECLARATION, INCOMPLETE_VAT_DECLARATION } from './vat-declaration-fixture'

const PARAMS = { periodType: 'monthly' as const, year: 2026, period: 6 }

const COMPLETE = COMPLETE_VAT_DECLARATION
const INCOMPLETE = INCOMPLETE_VAT_DECLARATION

function makeCtx() {
  return {
    supabase: {rpc:vi.fn().mockResolvedValue({data:'read-lease-token',error:null})},
    userId: 'user-1',
    companyId: 'company-1',
    settings: { set: vi.fn().mockResolvedValue(undefined) },
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  } as unknown as ExtensionContext
}

beforeEach(() => {
  vi.clearAllMocks()
  mockBuildMomsuppgift.mockResolvedValue({
    redovisare: '165560000000',
    redovisningsperiod: '202606',
    momsuppgift: { summaMoms: 150 },
    declaration: COMPLETE,
  })
  mockFindRcBasisGaps.mockResolvedValue([])
})

describe('submitVatDeclarationChain: completeness gate', () => {
  it.each([
    ['the one-click route (with kontrollera)', { validate: true }],
    ['the approval commit (no kontrollera)', {}],
  ])('an incomplete declaration stops before any call to Skatteverket: %s', async (_label, options) => {
    mockBuildMomsuppgift.mockResolvedValueOnce({
      redovisare: '165560000000',
      redovisningsperiod: '202606',
      momsuppgift: { summaMoms: 0 },
      declaration: INCOMPLETE,
    })

    const ctx = makeCtx()
    const result = await submitVatDeclarationChain(ctx, PARAMS, options)

    expect(result).toMatchObject({
      ok: false,
      stage: 'completeness',
      httpStatus: 422,
      draftSaved: false,
      kontrollresultat: null,
    })
    if (result.ok) throw new Error('unreachable')
    expect(result.error).toMatch(/ofullständig/)
    expect(result.completenessChecks).toContainEqual(
      expect.objectContaining({ code: 'RC_BASIS_MISSING', status: 'ERROR' }),
    )
    expect(mockSkvRequest).not.toHaveBeenCalled()
    expect((ctx.settings.set as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled()
  })

  it('scans the räkenskapsår the declaration was computed for', async () => {
    mockSkvRequest
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({}) }) // utkast
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ signeringsLank: 'https://skv.test/s' }) }) // lås

    await submitVatDeclarationChain(makeCtx(), { ...PARAMS, fiscalPeriodId: 'fp-1' })

    expect(mockBuildMomsuppgift).toHaveBeenCalledWith(expect.anything(), 'company-1', { ...PARAMS, fiscalPeriodId: 'fp-1' })
    expect(mockFindRcBasisGaps).toHaveBeenCalledWith(expect.anything(), 'company-1', 'monthly', 2026, 6, { fiscalPeriodId: 'fp-1' })
  })
})

describe('submitVatDeclarationChain', () => {
  it('validation ERRORs abort before any write at SKV', async () => {
    mockSkvRequest.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        kontrollResultat: {
          status: 'ERROR',
          resultat: [{ kod: '49', status: 'ERROR', beskrivning: 'Summan stämmer inte' }],
        },
      }),
    })

    const ctx = makeCtx()
    const result = await submitVatDeclarationChain(ctx, PARAMS, { validate: true })

    expect(result).toMatchObject({
      ok: false,
      stage: 'validation',
      httpStatus: 422,
      draftSaved: false,
    })
    // Only the kontrollera call: no utkast, no lås, no persisted state.
    expect(mockSkvRequest).toHaveBeenCalledTimes(1)
    expect(mockSkvRequest.mock.calls[0][4]).toBe('/kontrollera/165560000000/202606')
    expect((ctx.settings.set as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled()
  })

  it('validation warnings do not block: full chain runs to signing link', async () => {
    mockSkvRequest
      .mockResolvedValueOnce({
        ok: true, status: 200,
        json: async () => ({
          kontrollResultat: {
            status: 'WARNING',
            resultat: [{ kod: '10', status: 'WARNING', beskrivning: 'Ovanligt belopp' }],
          },
        }),
      }) // kontrollera
      .mockResolvedValueOnce({
        ok: true, status: 200,
        json: async () => ({ kontrollResultat: { status: 'OK' } }),
      }) // utkast
      .mockResolvedValueOnce({
        ok: true, status: 200,
        json: async () => ({ signeringsLank: 'https://skv.test/sign/abc' }),
      }) // lås

    const ctx = makeCtx()
    const result = await submitVatDeclarationChain(ctx, PARAMS, { validate: true })

    expect(result).toMatchObject({ ok: true, signingUrl: 'https://skv.test/sign/abc' })
    expect(mockSkvRequest).toHaveBeenCalledTimes(3)
    // Locked state persisted with the picker params for the kvittens cron.
    const setMock = ctx.settings.set as ReturnType<typeof vi.fn>
    const lastState = JSON.parse(setMock.mock.calls.at(-1)![1] as string)
    expect(lastState).toMatchObject({
      status: 'draft_locked',
      periodType: 'monthly',
      year: 2026,
      period: 6,
      signeringsLank: 'https://skv.test/sign/abc',
    })
  })

  it('skips kontrollera when validate is not requested', async () => {
    mockSkvRequest
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({}) }) // utkast
      .mockResolvedValueOnce({
        ok: true, status: 200,
        json: async () => ({ signeringsLank: 'https://skv.test/sign/xyz' }),
      }) // lås

    const result = await submitVatDeclarationChain(makeCtx(), PARAMS)

    expect(result).toMatchObject({ ok: true, signingUrl: 'https://skv.test/sign/xyz' })
    expect(mockSkvRequest).toHaveBeenCalledTimes(2)
    expect(mockSkvRequest.mock.calls[0][4]).toBe('/utkast/165560000000/202606')
  })

  it('utkast failure -> stage draft, nothing saved, retry-safe', async () => {
    mockSkvRequest.mockResolvedValueOnce({
      ok: false, status: 400, text: async () => 'bad rutor',
    })

    const ctx = makeCtx()
    const result = await submitVatDeclarationChain(ctx, PARAMS)

    expect(result).toMatchObject({
      ok: false, stage: 'draft', httpStatus: 400, draftSaved: false,
    })
    expect(mockSkvRequest).toHaveBeenCalledTimes(1) // never reached /las
    expect((ctx.settings.set as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled()
  })

  it('lås failure -> stage lock with draftSaved: true', async () => {
    mockSkvRequest
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({}) }) // utkast
      .mockResolvedValueOnce({ ok: false, status: 409, text: async () => 'redan låst' }) // lås

    const result = await submitVatDeclarationChain(makeCtx(), PARAMS)

    expect(result).toMatchObject({
      ok: false, stage: 'lock', httpStatus: 409, draftSaved: true,
    })
  })

  // crm#1866: the refused call's body used to be glued to the status as text,
  // so an envelope with both messages null read as an empty error.
  it('a refused utkast says what Skatteverket answered, as a sentence and in fields', async () => {
    mockSkvRequest.mockResolvedValueOnce({
      ok: false, status: 400,
      text: async () => JSON.stringify({ kod: 400, meddelandeTillAnvandare: null, meddelandeTillUtvecklare: null }),
    })

    const result = await submitVatDeclarationChain(makeCtx(), PARAMS)

    if (result.ok) throw new Error('unreachable')
    expect(result.error).toMatch(/^Skatteverket tog inte emot utkastet och angav ingen orsak \(svarskod 400\)\. /)
    expect(result.error).not.toContain('meddelandeTillAnvandare')
    expect(result.skv).toEqual({ skv_step: 'draft', skv_status: 400, skv_kod: 400 })
  })

  it('a refused kontrollera is read the same way, before anything is written', async () => {
    mockSkvRequest.mockResolvedValueOnce({
      ok: false, status: 404,
      text: async () => JSON.stringify({
        kod: 404, meddelandeTillAnvandare: 'Period saknas',
        meddelandeTillUtvecklare: 'Ingen redovisningsperiod för [202606] kunde hittas',
      }),
    })

    const result = await submitVatDeclarationChain(makeCtx(), PARAMS, { validate: true })

    expect(result).toMatchObject({ ok: false, stage: 'validation', httpStatus: 404, draftSaved: false })
    if (result.ok) throw new Error('unreachable')
    expect(result.error).toContain('Skatteverket tog inte emot deklarationen för kontroll: Period saknas.')
    expect(result.skv).toMatchObject({ skv_step: 'validate', skv_status: 404, skv_user_message: 'Period saknas' })
    expect(mockSkvRequest).toHaveBeenCalledTimes(1)
  })

  it('a refused lås says the draft is saved, what Skatteverket answered and what its kontroll of the draft found', async () => {
    mockSkvRequest
      .mockResolvedValueOnce({
        ok: true, status: 200,
        json: async () => ({
          kontrollResultat: {
            status: 'ERROR',
            resultat: [{ kod: '49', status: 'ERROR', beskrivning: 'Det måste finnas ett belopp i fält 49.' }],
          },
        }),
      }) // utkast
      .mockResolvedValueOnce({
        ok: false, status: 400,
        text: async () => JSON.stringify({ kod: 400, meddelandeTillAnvandare: null, meddelandeTillUtvecklare: null }),
      }) // lås

    const result = await submitVatDeclarationChain(makeCtx(), PARAMS)

    expect(result).toMatchObject({ ok: false, stage: 'lock', httpStatus: 400, draftSaved: true })
    if (result.ok) throw new Error('unreachable')
    expect(result.error).toBe(
      'Utkastet är sparat hos Skatteverket. Skatteverket låste inte utkastet för signering. ' +
        'Skatteverkets kontroll visade 1 fel: ruta 49 (Moms att betala eller få tillbaka): Det måste finnas ett belopp i fält 49. ' +
        'Försök igen om en stund. Går det fortfarande inte kan deklarationen lämnas direkt i Skatteverkets e-tjänst.',
    )
    expect(result.skv).toEqual({ skv_step: 'lock', skv_status: 400, skv_kod: 400 })
  })

  it('lås without signeringsLank -> stage lock 502 with draftSaved: true', async () => {
    mockSkvRequest
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({}) }) // utkast
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({}) }) // lås, no link

    const result = await submitVatDeclarationChain(makeCtx(), PARAMS)

    expect(result).toMatchObject({
      ok: false, stage: 'lock', httpStatus: 502, draftSaved: true,
    })
  })
})
