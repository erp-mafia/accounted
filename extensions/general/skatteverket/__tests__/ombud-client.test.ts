/**
 * Ombudshantering v2 client: base URL selection, role classification (pinned
 * code vs. description text), list envelope tolerance, 404-as-empty on the
 * list, the 403 remap, deep-link role resolution, and the pure grant helpers.
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
  isGrantActive,
  listOmbudGrants,
  normalizeHuvudman,
  OmbudApiError,
  resolveOmbudRoleCodes,
  summarizeGrants,
} from '../lib/ombud-client'
import { SkatteverketAuthError } from '../lib/api-client'

const ENV_KEYS = ['SKATTEVERKET_OMBUD_API_BASE_URL', 'SKATTEVERKET_OMBUD_ROLL_LASOMBUD', 'SKATTEVERKET_OMBUD_ROLL_MOMS']
let savedEnv: Record<string, string | undefined>

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
  it('matches by description text when no code is pinned', () => {
    expect(classifyOmbudRole({ roll: 'X1', rollbeskrivning: 'Juridiskt läsombud' })).toBe('lasombud')
    expect(classifyOmbudRole({ roll: 'X2', rollbeskrivning: 'Momsdeklaration, ombud' })).toBe('moms_ombud')
    expect(classifyOmbudRole({ roll: 'X3', rollbeskrivning: 'Deklarationsombud' })).toBeNull()
    expect(classifyOmbudRole({ roll: 'X4' })).toBeNull()
  })

  it('a pinned code wins and disables the text fallback for that key', () => {
    process.env.SKATTEVERKET_OMBUD_ROLL_LASOMBUD = 'JLO'
    expect(classifyOmbudRole({ roll: 'JLO', rollbeskrivning: 'whatever' })).toBe('lasombud')
    // Same wording, different code: not the pinned role.
    expect(classifyOmbudRole({ roll: 'OTHER', rollbeskrivning: 'Juridiskt läsombud' })).toBeNull()
    // The un-pinned key still falls back to text.
    expect(classifyOmbudRole({ roll: 'M', rollbeskrivning: 'Momsdeklaration, ombud' })).toBe('moms_ombud')
  })
})

describe('listOmbudGrants', () => {
  it('accepts a bare array and an enveloped list', async () => {
    const post = { huvudman: '165560000000', roll: 'JLO', rollbeskrivning: 'Juridiskt läsombud', giltigFrom: '2026-01-01' }
    mockSkvRequestWithAuth.mockResolvedValueOnce({ ok: true, status: 200, json: async () => [post] })
    expect(await listOmbudGrants()).toEqual([post])

    mockSkvRequestWithAuth.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ behorighetsposter: [post] }),
    })
    expect(await listOmbudGrants({ huvudman: '165560000000' })).toEqual([post])
    expect(mockSkvRequestWithAuth.mock.calls[1][2]).toBe('/ombud/autentisieratOmbud?huvudman=165560000000')
  })

  it('treats 404 as an empty register', async () => {
    mockSkvRequestWithAuth.mockResolvedValueOnce({ ok: false, status: 404, text: async () => '{"message":"Not found"}' })
    expect(await listOmbudGrants()).toEqual([])
  })

  it('rejects an unparsable body and other HTTP errors as OmbudApiError', async () => {
    mockSkvRequestWithAuth.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ nope: 1 }) })
    await expect(listOmbudGrants()).rejects.toMatchObject({ name: 'OmbudApiError', code: 'OBR_BAD_RESPONSE' })

    mockSkvRequestWithAuth.mockResolvedValueOnce({ ok: false, status: 500, text: async () => 'boom' })
    await expect(listOmbudGrants()).rejects.toMatchObject({ code: 'OBR_HTTP_ERROR', status: 500 })
  })

  it('remaps the system-mode 403 (OMBUD_GRANT_MISSING) to OBR_FORBIDDEN', async () => {
    mockSkvRequestWithAuth.mockRejectedValueOnce(new SkatteverketAuthError('nope', 'OMBUD_GRANT_MISSING'))
    await expect(listOmbudGrants()).rejects.toMatchObject({ code: 'OBR_FORBIDDEN' })
    // Other auth errors pass through untouched (run-level, classified upstream).
    mockSkvRequestWithAuth.mockRejectedValueOnce(new SkatteverketAuthError('token', 'SYSTEM_AUTH_FAILED'))
    await expect(listOmbudGrants()).rejects.toBeInstanceOf(SkatteverketAuthError)
  })
})

describe('roles and deep links', () => {
  it('getOmbudRoleDescriptions parses the roller list', async () => {
    mockSkvRequestWithAuth.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ roller: [{ roll: 'JLO', rollbeskrivning: 'Juridiskt läsombud' }] }),
    })
    expect(await getOmbudRoleDescriptions()).toEqual([{ roll: 'JLO', rollbeskrivning: 'Juridiskt läsombud' }])
    expect(mockSkvRequestWithAuth.mock.calls[0][2]).toBe('/roller')
  })

  it('resolveOmbudRoleCodes uses pinned codes without a network call', async () => {
    process.env.SKATTEVERKET_OMBUD_ROLL_LASOMBUD = 'JLO'
    process.env.SKATTEVERKET_OMBUD_ROLL_MOMS = 'MOMS'
    expect(await resolveOmbudRoleCodes(['lasombud', 'moms_ombud'])).toEqual({ lasombud: 'JLO', moms_ombud: 'MOMS' })
    expect(mockSkvRequestWithAuth).not.toHaveBeenCalled()
  })

  it('resolveOmbudRoleCodes looks unpinned codes up in /roller and refuses to guess', async () => {
    mockSkvRequestWithAuth.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => [
        { roll: 'A1', rollbeskrivning: 'Juridiskt läsombud' },
        { roll: 'B2', rollbeskrivning: 'Deklarationsombud' },
      ],
    })
    await expect(resolveOmbudRoleCodes(['lasombud', 'moms_ombud'])).rejects.toMatchObject({
      code: 'OBR_ROLE_UNRESOLVED',
    })

    mockSkvRequestWithAuth.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => [
        { roll: 'A1', rollbeskrivning: 'Juridiskt läsombud' },
        { roll: 'C3', rollbeskrivning: 'Momsdeklaration, ombud' },
      ],
    })
    expect(await resolveOmbudRoleCodes(['lasombud', 'moms_ombud'])).toEqual({ lasombud: 'A1', moms_ombud: 'C3' })
  })

  it('createUtseOmbudDeepLink posts the resolved codes for the huvudman and returns the link', async () => {
    process.env.SKATTEVERKET_OMBUD_ROLL_LASOMBUD = 'JLO'
    process.env.SKATTEVERKET_OMBUD_ROLL_MOMS = 'MOMS'
    mockSkvRequestWithAuth.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ djuplank: 'https://sso.skatteverket.se/ombud?x=1' }),
    })

    const link = await createUtseOmbudDeepLink('165560000000', ['lasombud', 'moms_ombud'], undefined, new Date('2026-09-01T10:00:00Z'))

    expect(link).toEqual({
      djuplank: 'https://sso.skatteverket.se/ombud?x=1',
      roller: { lasombud: 'JLO', moms_ombud: 'MOMS' },
      expiresOn: '2026-09-22',
    })
    const [auth, method, path, body, options] = mockSkvRequestWithAuth.mock.calls[0]
    expect(auth).toEqual({ mode: 'system' })
    expect(method).toBe('POST')
    expect(path).toBe('/ombud/autentisieratOmbud/huvudman/165560000000/djuplank/utseombud')
    expect(body).toEqual({ ombudsroller: ['JLO', 'MOMS'] })
    expect(options).toMatchObject({ accept: 'application/json' })
  })

  it('createUtseOmbudDeepLink rejects a response without djuplank', async () => {
    process.env.SKATTEVERKET_OMBUD_ROLL_LASOMBUD = 'JLO'
    mockSkvRequestWithAuth.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({}) })
    await expect(createUtseOmbudDeepLink('165560000000', ['lasombud'])).rejects.toBeInstanceOf(OmbudApiError)
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
        { huvudman: '165560000000', roll: 'JLO', rollbeskrivning: 'Juridiskt läsombud', giltigFrom: '2026-01-01' },
        { huvudman: '16556000-0000', roll: 'MOMS', rollbeskrivning: 'Momsdeklaration, ombud', giltigFrom: '2026-12-01' },
        { huvudman: '165560000000', roll: 'DEKL', rollbeskrivning: 'Deklarationsombud', giltigFrom: '2026-01-01' },
        { huvudman: '195001011234', roll: 'MOMS', rollbeskrivning: 'Momsdeklaration, ombud', giltigFrom: '2026-01-01' },
        { huvudman: 'bad', roll: 'JLO', rollbeskrivning: 'Juridiskt läsombud', giltigFrom: '2026-01-01' },
      ],
      '2026-09-01',
    )
    expect(summary.get('165560000000')).toEqual({
      huvudman: '165560000000',
      lasombud: true,
      moms_ombud: false,
      roles: ['JLO', 'MOMS', 'DEKL'],
    })
    expect(summary.get('195001011234')).toMatchObject({ lasombud: false, moms_ombud: true })
    expect(summary.size).toBe(2)
  })
})
