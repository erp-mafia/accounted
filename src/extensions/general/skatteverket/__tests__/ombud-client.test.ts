/**
 * Ombudshantering v2 client: base URL selection, role classification (by
 * code, default or env), list envelope tolerance, 404-as-empty on the list,
 * the 403 remap, deep-link roles, and the pure grant helpers.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const mockSkvRequestWithAuth = vi.fn()
const mockEnvironment = vi.fn(() => 'test')
vi.mock('../lib/api-client', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return {
    ...actual,
    skvRequestWithAuth: (...a: unknown[]) => mockSkvRequestWithAuth(...a),
    getSkatteverketEnvironment: () => mockEnvironment(),
  }
})

import {
  classifyOmbudRole,
  createUtseOmbudDeepLink,
  getOmbudApiBaseUrl,
  getOmbudRoleDescriptions,
  isAllowedDeepLinkUrl,
  isGrantActive,
  listOmbudGrants,
  normalizeHuvudman,
  OmbudApiError,
  summarizeGrants,
  grantCountsFor,
  grantPredatesOptIn,
} from '../lib/ombud-client'
import { SkatteverketAuthError } from '../lib/api-client'

const ENV_KEYS = ['SKATTEVERKET_OMBUD_API_BASE_URL', 'SKATTEVERKET_OMBUD_ROLL_LASOMBUD', 'SKATTEVERKET_OMBUD_ROLL_MOMS']
let savedEnv: Record<string, string | undefined>
const ACTOR = { companyId: 'company-1', userId: 'user-1' }

beforeEach(() => {
  vi.clearAllMocks()
  mockEnvironment.mockReturnValue('test')
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]))
  for (const k of ENV_KEYS) delete process.env[k]
  vi.spyOn(console, 'info').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k]
    else process.env[k] = savedEnv[k]
  }
})

describe('getOmbudApiBaseUrl', () => {
  it('follows the SKV environment and honours the override', () => {
    expect(getOmbudApiBaseUrl()).toBe('https://api.test.skatteverket.se/behorighet/ombudshantering/v2')
    mockEnvironment.mockReturnValue('prod')
    expect(getOmbudApiBaseUrl()).toBe('https://api.skatteverket.se/behorighet/ombudshantering/v2')
    process.env.SKATTEVERKET_OMBUD_API_BASE_URL = 'https://example.test/obr/'
    expect(getOmbudApiBaseUrl()).toBe('https://example.test/obr')
  })
})

describe('classifyOmbudRole', () => {
  it('matches on the code alone, never on the description text', () => {
    expect(classifyOmbudRole({ roll: 'skol', rollbeskrivning: 'whatever' })).toBe('lasombud')
    expect(classifyOmbudRole({ roll: 'momsdeklaration_ombud' })).toBe('moms_ombud')
    // The right wording under another code is another role.
    expect(classifyOmbudRole({ roll: 'X1', rollbeskrivning: 'Skattekonto, bara läsbehörighet' })).toBeNull()
    expect(classifyOmbudRole({ roll: 'X2', rollbeskrivning: 'Momsdeklaration, ombud' })).toBeNull()
    expect(classifyOmbudRole({ roll: 'X3', rollbeskrivning: 'Juridiskt läsombud' })).toBeNull()
    expect(classifyOmbudRole({ roll: 'X5', rollbeskrivning: 'Momsdeklaration, deklarationsombud' })).toBeNull()
    // Codes are exact: no case folding, no prefix match.
    expect(classifyOmbudRole({ roll: 'SKOL' })).toBeNull()
    expect(classifyOmbudRole({ roll: 'momsdeklaration' })).toBeNull()
  })

  it('a blank env override falls back to the default code', () => {
    process.env.SKATTEVERKET_OMBUD_ROLL_LASOMBUD = '  '
    expect(classifyOmbudRole({ roll: 'skol' })).toBe('lasombud')
  })
})

describe('listOmbudGrants', () => {
  it('accepts a bare array and an enveloped list', async () => {
    const post = { huvudman: '165560000000', roll: 'skol', rollbeskrivning: 'Skattekonto, bara läsbehörighet', giltigFrom: '2026-01-01' }
    mockSkvRequestWithAuth.mockResolvedValueOnce({ ok: true, status: 200, json: async () => [post] })
    expect(await listOmbudGrants({}, 'ombud_register')).toEqual([post])
    // The whole register belongs to no company: not audited in the company table.
    expect(mockSkvRequestWithAuth.mock.calls[0][3]).toEqual({
      unaudited: 'ombud_register',
      operation: 'ombud/autentisieratOmbud',
    })

    mockSkvRequestWithAuth.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ behorighetsposter: [post] }),
    })
    expect(await listOmbudGrants({ huvudman: '165560000000' }, ACTOR)).toEqual([post])
    expect(mockSkvRequestWithAuth.mock.calls[1][2]).toBe('/ombud/autentisieratOmbud?huvudman=165560000000')
    // One company's grants: audited against that company.
    expect(mockSkvRequestWithAuth.mock.calls[1][3]).toEqual({
      endpoint: 'ombud/autentisieratOmbud',
      ...ACTOR,
      agRegistreradId: '165560000000',
      expectJson: true,
    })
  })

  it('404 throws by default (wrong URI per the spec) and is empty only with emptyOn404', async () => {
    mockSkvRequestWithAuth.mockResolvedValueOnce({ ok: false, status: 404, text: async () => '{"message":"Not found"}' })
    await expect(listOmbudGrants({ huvudman: '165560000000' }, ACTOR)).rejects.toMatchObject({
      code: 'OBR_HTTP_ERROR',
      status: 404,
    })

    mockSkvRequestWithAuth.mockResolvedValueOnce({ ok: false, status: 404, text: async () => '{"message":"Not found"}' })
    expect(await listOmbudGrants({}, 'ombud_register', { emptyOn404: true })).toEqual([])
  })

  it('rejects an unparsable body and other HTTP errors as OmbudApiError', async () => {
    mockSkvRequestWithAuth.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ nope: 1 }) })
    await expect(listOmbudGrants({}, 'ombud_register')).rejects.toMatchObject({ name: 'OmbudApiError', code: 'OBR_BAD_RESPONSE' })

    mockSkvRequestWithAuth.mockResolvedValueOnce({ ok: false, status: 500, text: async () => 'boom' })
    await expect(listOmbudGrants({}, 'ombud_register')).rejects.toMatchObject({ code: 'OBR_HTTP_ERROR', status: 500 })
  })

  it('remaps the system-mode 403 (OMBUD_GRANT_MISSING) to OBR_FORBIDDEN', async () => {
    mockSkvRequestWithAuth.mockRejectedValueOnce(new SkatteverketAuthError('nope', 'OMBUD_GRANT_MISSING'))
    await expect(listOmbudGrants({}, 'ombud_register')).rejects.toMatchObject({ code: 'OBR_FORBIDDEN' })
    // Other auth errors pass through untouched (run-level, classified upstream).
    mockSkvRequestWithAuth.mockRejectedValueOnce(new SkatteverketAuthError('token', 'SYSTEM_AUTH_FAILED'))
    await expect(listOmbudGrants({}, 'ombud_register')).rejects.toBeInstanceOf(SkatteverketAuthError)
  })
})

describe('roles and deep links', () => {
  it('getOmbudRoleDescriptions parses the roller list', async () => {
    mockSkvRequestWithAuth.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ roller: [{ roll: 'skol', rollbeskrivning: 'Skattekonto, bara läsbehörighet' }] }),
    })
    expect(await getOmbudRoleDescriptions()).toEqual([{ roll: 'skol', rollbeskrivning: 'Skattekonto, bara läsbehörighet' }])
    expect(mockSkvRequestWithAuth.mock.calls[0][2]).toBe('/roller')
    expect(mockSkvRequestWithAuth.mock.calls[0][3]).toEqual({ unaudited: 'ombud_register', operation: 'roller' })
  })

  // accounted#18: 23:30 UTC is already the next day in Stockholm, in summer
  // (UTC+2) and in winter (UTC+1); the expiry is three weeks from that day.
  it.each([
    ['summer', '2026-07-01T23:30:00Z', '2026-07-23'],
    ['winter', '2026-01-15T23:30:00Z', '2026-02-06'],
  ])('createUtseOmbudDeepLink, %s: a link minted at %s expires on %s', async (_season, instant, expiresOn) => {
    process.env.SKATTEVERKET_OMBUD_ROLL_LASOMBUD = 'JLO'
    mockSkvRequestWithAuth.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ djuplank: 'https://sso.skatteverket.se/ombud?x=1' }),
    })
    const link = await createUtseOmbudDeepLink('165560000000', ACTOR, ['lasombud'], undefined, new Date(instant))
    expect(link.expiresOn).toBe(expiresOn)
  })

  it('createUtseOmbudDeepLink posts the env-overridden codes for the huvudman and returns the link', async () => {
    process.env.SKATTEVERKET_OMBUD_ROLL_LASOMBUD = 'JLO'
    process.env.SKATTEVERKET_OMBUD_ROLL_MOMS = 'MOMS'
    mockSkvRequestWithAuth.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ djuplank: 'https://sso.skatteverket.se/ombud?x=1' }),
    })

    const link = await createUtseOmbudDeepLink(
      '165560000000', ACTOR, ['lasombud', 'moms_ombud'], undefined, new Date('2026-09-01T10:00:00Z'),
    )

    expect(link).toEqual({
      djuplank: 'https://sso.skatteverket.se/ombud?x=1',
      roller: { lasombud: 'JLO', moms_ombud: 'MOMS' },
      expiresOn: '2026-09-22',
    })
    const [auth, method, path, audit, body, options] = mockSkvRequestWithAuth.mock.calls[0]
    expect(auth).toEqual({ mode: 'system' })
    expect(method).toBe('POST')
    expect(path).toBe('/ombud/autentisieratOmbud/huvudman/165560000000/djuplank/utseombud')
    expect(audit).toEqual({
      endpoint: 'system-connection/deeplink',
      ...ACTOR,
      agRegistreradId: '165560000000',
      expectJson: true,
    })
    expect(body).toEqual({ ombudsroller: ['JLO', 'MOMS'] })
    expect(options).toMatchObject({ accept: 'application/json' })
  })

  it('createUtseOmbudDeepLink rejects a response without djuplank', async () => {
    process.env.SKATTEVERKET_OMBUD_ROLL_LASOMBUD = 'JLO'
    mockSkvRequestWithAuth.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({}) })
    await expect(createUtseOmbudDeepLink('165560000000', ACTOR, ['lasombud'])).rejects.toBeInstanceOf(OmbudApiError)
  })

  it('createUtseOmbudDeepLink refuses a deep link that is not an https skatteverket.se URL (open redirect)', async () => {
    process.env.SKATTEVERKET_OMBUD_ROLL_LASOMBUD = 'JLO'
    for (const bad of [
      'http://sso.skatteverket.se/ombud',
      'https://evil.example/skatteverket.se',
      'https://skatteverket.se.evil.example/',
      'javascript:alert(1)',
      'not a url',
    ]) {
      mockSkvRequestWithAuth.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ djuplank: bad }) })
      await expect(createUtseOmbudDeepLink('165560000000', ACTOR, ['lasombud'])).rejects.toMatchObject({ code: 'OBR_BAD_RESPONSE' })
    }
    expect(isAllowedDeepLinkUrl('https://sso.skatteverket.se/ombud?x=1')).toBe(true)
    expect(isAllowedDeepLinkUrl('https://skatteverket.se/ombud')).toBe(true)
    expect(isAllowedDeepLinkUrl('https://www.test.skatteverket.se/x')).toBe(true)
  })
})

describe('pure helpers', () => {
  it('isGrantActive honours giltigFrom/giltigTom as date-only strings', () => {
    expect(isGrantActive({ giltigFrom: '2026-09-01' }, '2026-09-01')).toBe(true)
    expect(isGrantActive({ giltigFrom: '2026-09-02' }, '2026-09-01')).toBe(false)
    expect(isGrantActive({ giltigFrom: '2026-01-01', giltigTom: '2026-08-31' }, '2026-09-01')).toBe(false)
    expect(isGrantActive({ giltigFrom: '2026-01-01', giltigTom: '2026-09-01' }, '2026-09-01')).toBe(true)
    expect(isGrantActive({ giltigFrom: '2026-01-01', giltigTom: '' }, '2026-09-01')).toBe(true)
    expect(isGrantActive({ giltigFrom: '2026-01-01', giltigTom: null }, '2026-09-01')).toBe(true)
  })

  it('normalizeHuvudman reduces 12 or 13-character identities to 12 digits', () => {
    expect(normalizeHuvudman('165560000000')).toBe('165560000000')
    expect(normalizeHuvudman('16556000-0000')).toBe('165560000000')
    expect(normalizeHuvudman('5560000000')).toBeNull()
    expect(normalizeHuvudman('someone@example.com')).toBeNull()
  })

  it('summarizeGrants collapses posts per huvudman with only active, known roles deciding', () => {
    const summary = summarizeGrants(
      [
        { huvudman: '165560000000', roll: 'skol', rollbeskrivning: 'Skattekonto, bara läsbehörighet', giltigFrom: '2026-01-01' },
        { huvudman: '16556000-0000', roll: 'momsdeklaration_ombud', rollbeskrivning: 'Momsdeklaration, ombud', giltigFrom: '2026-12-01' },
        { huvudman: '165560000000', roll: 'DEKL', rollbeskrivning: 'Deklarationsombud', giltigFrom: '2026-01-01' },
        { huvudman: '195001011234', roll: 'momsdeklaration_ombud', rollbeskrivning: 'Momsdeklaration, ombud', giltigFrom: '2026-01-01' },
        { huvudman: 'bad', roll: 'skol', rollbeskrivning: 'Skattekonto, bara läsbehörighet', giltigFrom: '2026-01-01' },
      ],
      '2026-09-01',
    )
    expect(summary.get('165560000000')).toEqual({
      huvudman: '165560000000',
      lasombud: true,
      moms_ombud: false,
      roles: ['skol', 'momsdeklaration_ombud', 'DEKL'],
      recognized: true,
      // The future-dated moms post is not active, so it sets no signing day.
      signedFrom: { lasombud: '2026-01-01', moms_ombud: null },
    })
    expect(summary.get('195001011234')).toMatchObject({ lasombud: false, moms_ombud: true, recognized: true })
    expect(summary.size).toBe(2)

    // Only unknown roles: recognized stays false even though roles were listed.
    const unknown = summarizeGrants(
      [{ huvudman: '165560000000', roll: 'ZZ', rollbeskrivning: 'Något annat', giltigFrom: '2026-01-01' }],
      '2026-09-01',
    )
    expect(unknown.get('165560000000')).toMatchObject({ roles: ['ZZ'], recognized: false, lasombud: false })
  })

  it('grantCountsFor: without BankID proof only an active grant signed on or after the opt-in day counts', () => {
    const summary = summarizeGrants(
      [
        { huvudman: '165560000000', roll: 'skol', rollbeskrivning: 'Skattekonto, bara läsbehörighet', giltigFrom: '2026-03-01' },
        { huvudman: '165560000000', roll: 'skol', rollbeskrivning: 'Skattekonto, bara läsbehörighet', giltigFrom: '2026-06-15T00:00:00' },
        { huvudman: '165560000000', roll: 'momsdeklaration_ombud', rollbeskrivning: 'Momsdeklaration, ombud', giltigFrom: '2026-02-01' },
      ],
      '2026-09-01',
    ).get('165560000000')

    // The newest active post decides, compared on its date part.
    expect(summary?.signedFrom).toEqual({ lasombud: '2026-06-15', moms_ombud: '2026-02-01' })
    const unproven = (optInDay: string) => ({ optInDay, provenOn: { lasombud: null, moms_ombud: null } })
    expect(grantCountsFor(summary, 'lasombud', unproven('2026-06-15'))).toBe(true)
    expect(grantCountsFor(summary, 'lasombud', unproven('2026-06-16'))).toBe(false)
    expect(grantPredatesOptIn(summary, 'lasombud', unproven('2026-06-16'))).toBe(true)
    expect(grantCountsFor(summary, 'moms_ombud', unproven('2026-05-01'))).toBe(false)
    expect(grantPredatesOptIn(summary, 'moms_ombud', unproven('2026-05-01'))).toBe(true)
    // Nothing granted is neither counted nor "predating".
    expect(grantCountsFor(undefined, 'lasombud', unproven('2026-01-01'))).toBe(false)
    expect(grantPredatesOptIn(undefined, 'lasombud', unproven('2026-01-01'))).toBe(false)
  })

  it('grantCountsFor: an earlier grant counts with BankID proof of that behörighet around the opt-in (crm#1762)', () => {
    const summary = summarizeGrants(
      [
        { huvudman: '165560000000', roll: 'skol', rollbeskrivning: 'Skattekonto, bara läsbehörighet', giltigFrom: '2026-07-19' },
        { huvudman: '165560000000', roll: 'momsdeklaration_ombud', rollbeskrivning: 'Momsdeklaration, ombud', giltigFrom: '2026-07-19' },
      ],
      '2026-11-13',
    ).get('165560000000')
    const claim = (lasombud: string | null, moms_ombud: string | null = null, optInDay = '2026-11-09') => ({
      optInDay,
      provenOn: { lasombud, moms_ombud },
    })

    expect(grantCountsFor(summary, 'lasombud', claim('2026-11-09'))).toBe(true)
    expect(grantPredatesOptIn(summary, 'lasombud', claim('2026-11-09'))).toBe(false)
    // Each behörighet needs its own proof: a skattekonto read proves nothing about VAT.
    expect(grantCountsFor(summary, 'moms_ombud', claim('2026-11-09'))).toBe(false)
    expect(grantPredatesOptIn(summary, 'moms_ombud', claim('2026-11-09'))).toBe(true)
    expect(grantCountsFor(summary, 'moms_ombud', claim(null, '2026-11-09'))).toBe(true)
    // Proof older than the grant says nothing about who signed it.
    expect(grantCountsFor(summary, 'lasombud', claim('2026-07-18', null, '2026-08-01'))).toBe(false)
    expect(grantCountsFor(summary, 'lasombud', claim('2026-07-19', null, '2026-08-01'))).toBe(true)
    // Proof more than 30 days before the opt-in speaks for nobody now.
    expect(grantCountsFor(summary, 'lasombud', claim('2026-10-09'))).toBe(false)
    expect(grantCountsFor(summary, 'lasombud', claim('2026-10-10'))).toBe(true)
    // Proof lifts the signing-day rule, it grants nothing the register lacks.
    expect(grantCountsFor(undefined, 'lasombud', claim('2026-11-09'))).toBe(false)
  })
})

// The live register (Skatteverket test service, GET /roller and
// /ombud/autentisieratOmbud, 2026-11-03) has no role called "Juridiskt
// läsombud". Skattekonto reads are unlocked by `skol` ("Skattekonto, bara
// läsbehörighet"): a huvudman holding only momsdeklaration_ombud answers the
// saldo read with 403 felkod 6. The rows below keep the register's shape and
// role codes; the identities are placeholders.
describe("the register's real role codes (live test service, 2026-11-03)", () => {
  const LIVE_POSTS = [
    { ombud: '165560000167', roll: 'momsdeklaration_ombud', rollbeskrivning: 'Momsdeklaration, ombud', huvudman: '161100000001', giltigFrom: '2025-05-09' },
    { ombud: '165560000167', roll: 'es', rollbeskrivning: 'Firmatecknare', huvudman: '162700000002', giltigFrom: '2026-01-01' },
    { ombud: '165560000167', roll: 'skol', rollbeskrivning: 'Skattekonto, bara läsbehörighet', huvudman: '162700000002', giltigFrom: '2015-01-01' },
    { ombud: '165560000167', roll: 'esol', rollbeskrivning: 'Moms och AG, bara läsbehörighet', huvudman: '165100000003', giltigFrom: '2020-01-01' },
  ]

  it('classifies skol and momsdeklaration_ombud with no env set, and nothing else', () => {
    expect(classifyOmbudRole({ roll: 'skol', rollbeskrivning: 'Skattekonto, bara läsbehörighet' })).toBe('lasombud')
    expect(classifyOmbudRole({ roll: 'momsdeklaration_ombud', rollbeskrivning: 'Momsdeklaration, ombud' })).toBe('moms_ombud')
    expect(classifyOmbudRole({ roll: 'esol', rollbeskrivning: 'Moms och AG, bara läsbehörighet' })).toBeNull()
    expect(classifyOmbudRole({ roll: 'sk', rollbeskrivning: 'Firmatecknare skattekonto' })).toBeNull()
    expect(classifyOmbudRole({ roll: 'es', rollbeskrivning: 'Firmatecknare' })).toBeNull()
  })

  it('an env code still overrides the default, and then the default no longer counts', () => {
    process.env.SKATTEVERKET_OMBUD_ROLL_LASOMBUD = 'skol_prod'
    expect(classifyOmbudRole({ roll: 'skol_prod' })).toBe('lasombud')
    expect(classifyOmbudRole({ roll: 'skol', rollbeskrivning: 'Skattekonto, bara läsbehörighet' })).toBeNull()
    expect(classifyOmbudRole({ roll: 'momsdeklaration_ombud' })).toBe('moms_ombud')
  })

  it('summarizeGrants recognizes the skattekonto grant and the moms grant from the live response', () => {
    const summary = summarizeGrants(LIVE_POSTS, '2026-11-03')
    expect(summary.get('162700000002')).toMatchObject({ lasombud: true, moms_ombud: false, recognized: true })
    expect(summary.get('161100000001')).toMatchObject({ lasombud: false, moms_ombud: true, recognized: true })
    expect(summary.get('165100000003')).toMatchObject({ lasombud: false, moms_ombud: false, recognized: false })
  })

  it('a deep link pre-selects skol and momsdeklaration_ombud without asking /roller first', async () => {
    mockSkvRequestWithAuth.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ djuplank: 'https://sso.test.skatteverket.se/ombud?x=1' }),
    })
    const link = await createUtseOmbudDeepLink('165560000000', ACTOR)
    expect(link.roller).toEqual({ lasombud: 'skol', moms_ombud: 'momsdeklaration_ombud' })
    expect(mockSkvRequestWithAuth).toHaveBeenCalledTimes(1)
    expect(mockSkvRequestWithAuth.mock.calls[0][4]).toEqual({ ombudsroller: ['skol', 'momsdeklaration_ombud'] })
  })

  it('every register call names Content-Type: application/json, GETs included', async () => {
    mockSkvRequestWithAuth.mockResolvedValue({ ok: true, status: 200, json: async () => [] })
    await getOmbudRoleDescriptions()
    await listOmbudGrants({}, 'ombud_register')
    for (const call of mockSkvRequestWithAuth.mock.calls) {
      expect(call[1]).toBe('GET')
      expect(call[5]).toMatchObject({ accept: 'application/json', contentType: 'application/json' })
    }
  })
})
