import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest'
import { createMockSupabase } from '@/tests/helpers'
import type { ExtensionContext } from '@/lib/extensions/types'

/**
 * Locks the /migrate NDJSON streaming contract (opt-in via
 * `Accept: application/x-ndjson`):
 *
 *  - each orchestrator onProgress call becomes one `progress` line with the
 *    real step label and anchor (the wizard's fake 55→100 jump is dead)
 *  - success ends with a terminal `done` line carrying the results, after
 *    acceptConsent ran
 *  - an orchestrator failure ends with a terminal `error` line carrying the
 *    SAME structured envelope the JSON path answers with (the 200 status is
 *    already committed when the stream opens)
 *  - a request WITHOUT the Accept header keeps the original JSON contract
 */

vi.mock('../lib/migration-orchestrator', () => ({
  executeMigration: vi.fn(),
}))

vi.mock('../lib/provider-client', () => ({
  createConsent: vi.fn(),
  getConsent: vi.fn(),
  listConsents: vi.fn(),
  generateOtc: vi.fn(),
  consumeOAuthState: vi.fn(),
  getAuthUrl: vi.fn(),
  exchangeAuthToken: vi.fn(),
  submitProviderToken: vi.fn(),
  acceptConsent: vi.fn().mockResolvedValue(undefined),
  deleteConsent: vi.fn(),
  resolveConsent: vi.fn(),
  fetchCompanyInfoDirect: vi.fn(),
  ProviderTokenInvalidError: class ProviderTokenInvalidError extends Error {},
  ConsentNotFoundError: class ConsentNotFoundError extends Error {},
}))

import { arcimMigrationExtension } from '../index'
import { executeMigration } from '../lib/migration-orchestrator'
import { getConsent, acceptConsent } from '../lib/provider-client'

const migrateRoute = (arcimMigrationExtension.apiRoutes ?? []).find(
  (r) => r.method === 'POST' && r.path === '/migrate',
)!

type RouteHandler = (request: Request, ctx?: ExtensionContext) => Promise<Response>
const handler = migrateRoute.handler as RouteHandler

function buildCtx(): ExtensionContext {
  const { supabase, mockResult } = createMockSupabase()
  // The SIE guard awaits `from('sie_imports').select(..,{count,head}).eq().eq()`.
  mockResult({ count: 1 })
  ;(supabase as unknown as { auth: unknown }).auth = {
    getUser: vi.fn().mockResolvedValue({ data: { user: { id: 'user-1' } } }),
  }
  return { supabase, companyId: 'company-1' } as unknown as ExtensionContext
}

function streamRequest() {
  return new Request('http://localhost/api/extensions/ext/arcim-migration/migrate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/x-ndjson' },
    body: JSON.stringify({ consentId: 'consent-1' }),
  })
}

async function readNdjson(res: Response): Promise<Record<string, unknown>[]> {
  const text = await res.text()
  return text
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line))
}

describe('POST /migrate: NDJSON streaming', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(getConsent as Mock).mockResolvedValue({ id: 'consent-1', status: 1, provider: 'visma' })
  })

  it('streams one progress line per orchestrator event, then a terminal done line with results', async () => {
    const results = {
      customers: { total: 5, imported: 5, updated: 0, skipped: 0, skipReasons: {} },
      stepErrors: [],
    }
    ;(executeMigration as Mock).mockImplementation(
      async (opts: { onProgress?: (p: { status: string; currentStep?: string; progress: number }) => void }) => {
        opts.onProgress?.({ status: 'fetching', currentStep: 'Ansluter till Visma eEkonomi...', progress: 5 })
        opts.onProgress?.({ status: 'importing', currentStep: 'Importerar kunder...', progress: 20 })
        opts.onProgress?.({ status: 'completed', currentStep: 'Klart!', progress: 100 })
        return results
      },
    )

    const res = await handler(streamRequest(), buildCtx())

    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('application/x-ndjson')

    const events = await readNdjson(res)
    expect(events).toHaveLength(4)
    expect(events[0]).toEqual({
      kind: 'progress',
      status: 'fetching',
      currentStep: 'Ansluter till Visma eEkonomi...',
      progress: 5,
    })
    expect(events[1]).toMatchObject({ kind: 'progress', currentStep: 'Importerar kunder...', progress: 20 })
    expect(events[3]).toEqual({ kind: 'done', success: true, results })
    expect(acceptConsent).toHaveBeenCalledWith('consent-1')
  })

  it('ends with a terminal error line carrying the structured envelope when the orchestrator fails', async () => {
    const vismaError = new Error('Visma API error: 403 Forbidden') as Error & {
      statusCode: number
      body: string
    }
    vismaError.statusCode = 403
    vismaError.body =
      '{"ErrorCode":4002,"DeveloperErrorMessage":"ForbiddenRequestException - No access to module: api_standard","ErrorId":"x","Errors":[]}'
    ;(executeMigration as Mock).mockImplementation(
      async (opts: { onProgress?: (p: { status: string; progress: number }) => void }) => {
        opts.onProgress?.({ status: 'fetching', progress: 5 })
        throw vismaError
      },
    )

    const res = await handler(streamRequest(), buildCtx())
    expect(res.status).toBe(200)

    const events = await readNdjson(res)
    const terminal = events[events.length - 1] as {
      kind: string
      error: { code: string; message: string }
    }
    expect(terminal.kind).toBe('error')
    expect(terminal.error.code).toBe('PROVIDER_API_MODULE_INACTIVE')
    expect(terminal.error.message).toContain('Appar och tillägg')
    expect(acceptConsent).not.toHaveBeenCalled()
  })

  it('keeps the single-JSON contract when the Accept header is absent', async () => {
    const results = { customers: { total: 1, imported: 1, updated: 0, skipped: 0, skipReasons: {} } }
    ;(executeMigration as Mock).mockResolvedValue(results)

    const res = await handler(
      new Request('http://localhost/api/extensions/ext/arcim-migration/migrate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ consentId: 'consent-1' }),
      }),
      buildCtx(),
    )

    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('application/json')
    expect(await res.json()).toEqual({ success: true, results })
  })
})
