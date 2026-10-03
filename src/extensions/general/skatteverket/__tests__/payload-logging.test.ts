import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Skatteverket's public test personnummer, shaped as a 12-digit redovisare.
// For an enskild firma the redovisare and the AGI arbetsgivare ARE the owner's
// personnummer, so neither may reach a log line.
const PERSONNUMMER = '191212121212'
// A distinctive amount: if it shows up in a log line, the momsuppgift leaked.
const PAYLOAD_MARKER = 987654

const mockSkvRequest = vi.fn()
const mockAgiPostUnderlag = vi.fn()

vi.mock('../lib/api-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/api-client')>()
  return {
    ...actual,
    skvRequest: (...args: unknown[]) => mockSkvRequest(...args),
  }
})

vi.mock('../lib/agi-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/agi-client')>()
  return {
    ...actual,
    agiPostUnderlag: (...args: unknown[]) => mockAgiPostUnderlag(...args),
  }
})

vi.mock('../lib/declaration-prep', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/declaration-prep')>()
  return {
    ...actual,
    buildMomsuppgift: vi.fn(async () => ({
      redovisare: PERSONNUMMER,
      redovisningsperiod: '202606',
      momsuppgift: { momspliktigForsaljning: PAYLOAD_MARKER, momsUtgHog: PAYLOAD_MARKER },
    })),
    buildAgiUnderlag: vi.fn(async () => ({
      arbetsgivare: PERSONNUMMER,
      period: '202606',
      salaryRunId: 'run-1',
      xml: `<Arbetsgivare><AgRegistreradId>${PERSONNUMMER}</AgRegistreradId></Arbetsgivare>`,
      periodYear: 2026,
      periodMonth: 6,
    })),
  }
})

vi.mock('../lib/audit', () => ({
  writeSkatteverketAudit: vi.fn(),
}))

vi.mock('@/lib/entitlements/has-capability', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/entitlements/has-capability')>()
  return {
    ...actual,
    requireCapability: vi.fn().mockResolvedValue(null),
  }
})

import type { ExtensionContext } from '@/lib/extensions/types'
import { skatteverketExtension } from '../index'

function makeContext(): ExtensionContext {
  return {
    userId: 'user-1',
    companyId: 'company-1',
    extensionId: 'skatteverket',
    requestId: 'req-payload-logging',
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    supabase: {} as any,
    emit: vi.fn().mockResolvedValue(undefined),
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    settings: {
      get: vi.fn().mockResolvedValue(null),
      set: vi.fn().mockResolvedValue(undefined),
      clear: vi.fn().mockResolvedValue(undefined),
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any
}

function route(method: string, path: string) {
  const found = skatteverketExtension.apiRoutes?.find(
    (candidate) => candidate.method === method && candidate.path === path,
  )
  expect(found).toBeDefined()
  return found!
}

function postJson(path: string, body: unknown): Request {
  return new Request(`https://test.local/api/extensions/ext/skatteverket${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

const consoleMethods = ['log', 'info', 'warn', 'error', 'debug'] as const
let consoleSpies: Array<ReturnType<typeof vi.spyOn>> = []

/** Every argument any console method and the extension logger received, as text. */
function everythingLogged(ctx: ExtensionContext): string {
  const calls: unknown[][] = [
    ...consoleSpies.flatMap((spy) => spy.mock.calls as unknown[][]),
    ...Object.values(ctx.log).flatMap((fn) => vi.mocked(fn).mock.calls),
  ]
  return calls.map((args) => args.map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' ')).join('\n')
}

function expectNoPayloadLogged(ctx: ExtensionContext) {
  const logged = everythingLogged(ctx)
  expect(logged).not.toContain(PERSONNUMMER)
  expect(logged).not.toContain(String(PAYLOAD_MARKER))
}

describe('Skatteverket routes never log the declaration payload or the redovisare', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    consoleSpies = consoleMethods.map((method) => vi.spyOn(console, method).mockImplementation(() => {}))
  })

  afterEach(() => {
    for (const spy of consoleSpies) spy.mockRestore()
  })

  const vatBody = { periodType: 'monthly', year: 2026, period: 6 }

  it.each(['/declaration/validate', '/declaration/draft'])('%s logs nothing personal on success', async (path) => {
    mockSkvRequest.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ kontrollresultat: { resultat: [] } }),
    })
    const ctx = makeContext()

    const response = await route('POST', path).handler(postJson(path, vatBody), ctx)

    expect(response.status).toBe(200)
    expect(mockSkvRequest).toHaveBeenCalledTimes(1)
    expectNoPayloadLogged(ctx)
  })

  it.each(['/declaration/validate', '/declaration/draft'])(
    '%s logs only the status when Skatteverket refuses, even if the body echoes the redovisare',
    async (path) => {
      mockSkvRequest.mockResolvedValue({
        ok: false,
        status: 400,
        text: async () => `Felaktig redovisare ${PERSONNUMMER}, belopp ${PAYLOAD_MARKER}`,
      })
      const ctx = makeContext()

      const response = await route('POST', path).handler(postJson(path, vatBody), ctx)

      expect(response.status).toBe(400)
      expect(ctx.log.error).toHaveBeenCalledWith(expect.any(String), {
        redovisningsperiod: '202606',
        status: 400,
      })
      expectNoPayloadLogged(ctx)
    },
  )

  it('/agi/submit logs nothing personal on success', async () => {
    mockAgiPostUnderlag.mockResolvedValue({ ok: true, data: { inlamningId: 'inl-1' } })
    const ctx = makeContext()

    const response = await route('POST', '/agi/submit').handler(postJson('/agi/submit', { salaryRunId: 'run-1' }), ctx)

    expect(response.status).toBe(200)
    expect(mockAgiPostUnderlag).toHaveBeenCalledTimes(1)
    expectNoPayloadLogged(ctx)
  })

  it('/agi/submit logs only the status and kod when Skatteverket refuses', async () => {
    mockAgiPostUnderlag.mockResolvedValue({
      ok: false,
      status: 400,
      error: `Ogiltig arbetsgivare ${PERSONNUMMER}`,
      body: { kod: 'FEL_01' },
    })
    const ctx = makeContext()

    const response = await route('POST', '/agi/submit').handler(postJson('/agi/submit', { salaryRunId: 'run-1' }), ctx)

    expect(response.status).toBe(400)
    expect(ctx.log.error).toHaveBeenCalledWith(expect.any(String), {
      period: '202606',
      status: 400,
      kod: 'FEL_01',
    })
    expectNoPayloadLogged(ctx)
  })
})
