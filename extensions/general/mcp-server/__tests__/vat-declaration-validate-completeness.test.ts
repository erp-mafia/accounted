/**
 * gnubok_vat_declaration_validate: arithmetic vs completeness.
 *
 * The tool used to be a pure proxy for Skatteverket's POST /kontrollera, which
 * lib/reports/vat-declaration-checks.ts documents as arithmetic-only:
 *
 *   "Skatteverket's 'validering' only confirms that the payload is internally
 *    arithmetically consistent: it does NOT confirm that the declaration
 *    reflects reality. A declaration of all zeros validates fine; one with
 *    output VAT but no underlying purchases validates fine too, until the
 *    gateway-level FK004 rule fires."
 *
 * So a green kontrollresultat was being handed to the agent as if it meant
 * "safe to file". The tool now also runs the local completeness checks and
 * reports the two verdicts under separate keys.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { VatDeclarationRutor } from '@/types'

const { mockFindRcBasisGaps } = vi.hoisted(() => ({
  mockFindRcBasisGaps: vi.fn(),
}))
const mockSkvRequest = vi.fn()
vi.mock('@/extensions/general/skatteverket/lib/api-client', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return { ...actual, skvRequest: (...a: unknown[]) => mockSkvRequest(...a) }
})

vi.mock('@/extensions/general/skatteverket/lib/declaration-prep', () => ({
  buildMomsuppgift: vi.fn(async () => ({
    redovisare: '165560000000',
    redovisningsperiod: '202601',
    momsuppgift: { summaMoms: 2500 },
  })),
  resolveRedovisare: vi.fn(async () => '165560000000'),
}))

vi.mock('@/extensions/general/skatteverket/lib/audit', () => ({
  writeSkatteverketAudit: vi.fn(),
}))

// The declaration figures are the unit under test here, so they are supplied
// directly instead of being reconstructed from a ledger fixture.
const mockCalculateVatDeclaration = vi.fn()
vi.mock('@/lib/reports/vat-declaration', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return {
    ...actual,
    calculateVatDeclaration: (...a: unknown[]) => mockCalculateVatDeclaration(...a),
  }
})

vi.mock('@/lib/reports/rc-basis-gaps', () => ({
  findRcBasisGaps: (...args: unknown[]) => mockFindRcBasisGaps(...args),
}))

import { tools } from '../server'

const validate = tools.find((t) => t.name === 'gnubok_vat_declaration_validate')!

/** Full SKV 4700 projection with ruta 49 derived, so SUMMA_MOMS_DRIFT stays quiet. */
function makeRutor(partial: Partial<VatDeclarationRutor> = {}): VatDeclarationRutor {
  const base: VatDeclarationRutor = {
    ruta05: 0, ruta06: 0, ruta07: 0, ruta08: 0,
    ruta10: 0, ruta11: 0, ruta12: 0,
    ruta20: 0, ruta21: 0, ruta22: 0, ruta23: 0, ruta24: 0,
    ruta30: 0, ruta31: 0, ruta32: 0,
    ruta35: 0, ruta36: 0, ruta37: 0, ruta38: 0,
    ruta39: 0, ruta40: 0, ruta41: 0, ruta42: 0,
    ruta48: 0, ruta49: 0,
    ruta50: 0, ruta60: 0, ruta61: 0, ruta62: 0,
    ...partial,
  }
  base.ruta49 =
    base.ruta10 + base.ruta11 + base.ruta12 +
    base.ruta30 + base.ruta31 + base.ruta32 +
    base.ruta60 + base.ruta61 + base.ruta62 -
    base.ruta48
  return base
}

/**
 * `rcInputAccountTotals` is the 2645/2647 pair the real calculateVatDeclaration
 * carries alongside the rutor. Omitting it here is not neutral: the tool then
 * runs RC_INPUT_VAT_MISMATCH against the ruta 48 aggregate instead of the
 * reverse-charge input accounts, which is exactly the weaker form.
 */
function setDeclaration(
  rutor: VatDeclarationRutor,
  rcInput?: Record<string, { debit: number; credit: number }>,
  rcBasisByRate?: { r25: number; r12: number; r6: number },
) {
  mockCalculateVatDeclaration.mockResolvedValue({
    rutor,
    ...(rcInput ? { rcInputAccountTotals: rcInput } : {}),
    ...(rcBasisByRate ? { rcBasisByRate } : {}),
  })
}

/** Period debit balances for 2645/2647, in the wire shape the declaration uses. */
const rcInput = (accounts: Record<string, number>) =>
  Object.fromEntries(
    ['2645', '2647'].map((a) => [a, { debit: accounts[a] ?? 0, credit: 0 }]),
  )

/** A period that would be filed cleanly: RC basis, fiktiv moms and input all present. */
const CLEAN = makeRutor({ ruta05: 10000, ruta10: 2500, ruta21: 5000, ruta30: 1250, ruta48: 1250 })

/** The FK004 shape: fiktiv moms in ruta 30 with no beskattningsunderlag behind it. */
const INCOMPLETE = makeRutor({ ruta05: 10000, ruta10: 2500, ruta30: 1250, ruta48: 1450 })

const ARGS = { period_type: 'monthly', year: 2026, period: 1 }
const supabase = {} as never

function skvOk(body: unknown = { kontrollResultat: { status: 'OK', resultat: [] } }) {
  mockSkvRequest.mockResolvedValue({ ok: true, status: 200, json: async () => body })
}

let prevEnv: string | undefined
beforeEach(() => {
  vi.clearAllMocks()
  mockFindRcBasisGaps.mockResolvedValue([])
  prevEnv = process.env.SKATTEVERKET_ENABLED
  process.env.SKATTEVERKET_ENABLED = 'true'
})
afterEach(() => {
  if (prevEnv === undefined) delete process.env.SKATTEVERKET_ENABLED
  else process.env.SKATTEVERKET_ENABLED = prevEnv
})

interface ValidateResult {
  arithmetic_ok: boolean
  completeness_ok: boolean
  completeness_checks: { code: string; status: string; message: string; rutor: string[] }[]
  summary: string
  kontrollresultat: unknown
}

async function run(): Promise<ValidateResult> {
  return (await validate.execute(ARGS, 'company-1', 'user-1', supabase, {
    type: 'api_key',
  })) as ValidateResult
}

describe('gnubok_vat_declaration_validate', () => {
  it('separates arithmetic (Skatteverket) from completeness (local) on an incomplete declaration', async () => {
    setDeclaration(INCOMPLETE)
    skvOk()

    const result = await run()

    // Skatteverket is happy: the boxes add up.
    expect(result.arithmetic_ok).toBe(true)
    // We are not: ruta 30 has no basbelopp in rutor 20-24.
    expect(result.completeness_ok).toBe(false)
    const codes = result.completeness_checks.map((c) => c.code)
    expect(codes).toContain('RC_BASIS_MISSING')
    expect(
      result.completeness_checks.find((c) => c.code === 'RC_BASIS_MISSING')?.status,
    ).toBe('ERROR')
    // The summary must not let a green SKV result read as an all-clear.
    expect(result.summary).toMatch(/Skatteverket/)
    expect(result.summary).toMatch(/ofullständig/)
  })

  it('reports both green on a clean period, and still calls only /kontrollera', async () => {
    setDeclaration(CLEAN)
    skvOk()

    const result = await run()

    expect(result.arithmetic_ok).toBe(true)
    expect(result.completeness_ok).toBe(true)
    expect(result.completeness_checks).toEqual([])
    expect(mockSkvRequest).toHaveBeenCalledTimes(1)
    expect(mockSkvRequest.mock.calls[0][4]).toMatch(/^\/kontrollera\//)
  })

  // The masking case: rutor 30-32 are compared against 2645/2647, so ordinary
  // debiterad ingående moms sitting in the same ruta 48 can no longer hide a
  // missing beräknad ingående moms on an otherwise well-formed declaration.
  it('reports incomplete when no 2645/2647 backs the fiktiv utgående moms, even though ruta 48 is larger', async () => {
    // Underlag correctly booked (ruta 21 = 200 000 against ruta 30 = 50 000), so
    // this is NOT FK004; ruta 48 carries 60 000 kr of ordinary 2641 only.
    const masked = makeRutor({ ruta21: 200000, ruta30: 50000, ruta48: 60000 })
    setDeclaration(masked, rcInput({}))
    skvOk()

    const result = await run()

    // Skatteverket still validates it: the boxes add up.
    expect(result.arithmetic_ok).toBe(true)
    const mismatch = result.completeness_checks.find((c) => c.code === 'RC_INPUT_VAT_MISMATCH')
    expect(mismatch?.status).toBe('WARNING')
    // \s, not a literal space: sv-SE groups thousands with a no-break space.
    expect(mismatch?.message).toMatch(/50\s000 kr saknas/)
    expect(result.completeness_checks.map((c) => c.code)).not.toContain('RC_BASIS_MISSING')
    // A WARNING does not block filing (isFilingBlocked reads ERROR only): the
    // shortfall is legally correct under limited avdragsrätt.
    expect(result.completeness_ok).toBe(true)

    // Without the pair the same declaration comes back with nothing to say,
    // which is what the ruta 48 comparison alone does.
    setDeclaration(masked)
    skvOk()
    expect((await run()).completeness_checks).toEqual([])
  })

  it('stays quiet when 2645 mirrors the fiktiv utgående moms exactly', async () => {
    setDeclaration(
      makeRutor({ ruta21: 200000, ruta30: 50000, ruta48: 110000 }),
      rcInput({ '2645': 50000 }),
    )
    skvOk()

    const result = await run()

    expect(result.completeness_checks).toEqual([])
    expect(result.completeness_ok).toBe(true)
  })

  it('uses declaration rate evidence when a correction gap is covered in aggregate', async () => {
    mockFindRcBasisGaps.mockResolvedValue([{}])
    setDeclaration(
      makeRutor({ ruta20: 5000, ruta30: 1250, ruta48: 1250 }),
      rcInput({ '2645': 1250 }),
      { r25: 5000, r12: 0, r6: 0 },
    )
    skvOk()

    const result = await run()

    expect(result.completeness_checks.find((c) => c.code === 'RC_BASIS_MISSING')?.status)
      .toBe('WARNING')
    expect(result.completeness_ok).toBe(true)
  })

  it('arithmetic_ok is false when Skatteverket returns an ERROR, independently of completeness', async () => {
    setDeclaration(CLEAN)
    skvOk({
      kontrollResultat: {
        status: 'ERROR',
        resultat: [{ kod: '49', status: 'ERROR', beskrivning: 'Summa moms stämmer inte' }],
      },
    })

    const result = await run()

    expect(result.arithmetic_ok).toBe(false)
    expect(result.completeness_ok).toBe(true)
    expect(result.summary).toMatch(/1 fel/)
  })

  it('reads an unwrapped kontrollresultat body too (no silent all-clear on a shape change)', async () => {
    setDeclaration(CLEAN)
    skvOk({ status: 'ERROR', resultat: [{ kod: '20', status: 'ERROR', beskrivning: 'fel' }] })

    const result = await run()

    expect(result.arithmetic_ok).toBe(false)
  })

  it('declares the two verdicts in its output schema and stays inside the description budget', () => {
    const schema = validate.outputSchema as {
      properties: Record<string, unknown>
      required: string[]
    }
    expect(schema.properties).toHaveProperty('arithmetic_ok')
    expect(schema.properties).toHaveProperty('completeness_ok')
    expect(schema.properties).toHaveProperty('completeness_checks')
    expect(schema.required).toContain('arithmetic_ok')
    expect(schema.required).toContain('completeness_ok')
    expect(validate.description.length).toBeLessThanOrEqual(280)
    // The description must not imply Skatteverket checked the underlag.
    expect(validate.description).toMatch(/completeness/i)
  })
})
