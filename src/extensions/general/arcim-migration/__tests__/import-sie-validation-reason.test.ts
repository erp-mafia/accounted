/**
 * POST /import-sie must answer a SIEJobValidationError with the validator's
 * own sentence. Wrapped as SIE_IMPORT_UNEXPECTED (500) it reached the wizard
 * as "Importens resultat kunde inte bekräftas" with the reason buried in
 * details.reason, and three imports of one file failed without a word about
 * the voucher that refused it (Easy Online Stores, 2026-09-16).
 */
import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest'
import { createMockRequest, parseJsonResponse } from '@/tests/helpers'
import type { ExtensionContext } from '@/lib/extensions/types'

vi.mock('@/lib/import/sie-import', () => ({ loadMappings: vi.fn(), generateImportPreview: vi.fn() }))
vi.mock('@/lib/import/sie-jobs', async (load) => ({
  ...await load<typeof import('@/lib/import/sie-jobs')>(),
  submitSIEJob: vi.fn(),
}))
vi.mock('next/server', async (load) => ({ ...await load<typeof import('next/server')>(), after: vi.fn() }))
vi.mock('@/lib/import/sie-job-worker', () => ({ runSIEWorker: vi.fn() }))

import { arcimMigrationExtension } from '../index'
import { submitSIEJob, SIEJobValidationError } from '@/lib/import/sie-jobs'

type RouteHandler = (request: Request, ctx?: ExtensionContext) => Promise<Response>
const handler = (arcimMigrationExtension.apiRoutes ?? []).find(
  (r) => r.method === 'POST' && r.path === '/import-sie',
)!.handler as RouteHandler

const SIE = [
  '#FLAGGA 0', '#SIETYP 4', '#FNAMN "Migrerad AB"', '#RAR 0 20260101 20261231',
  '#KONTO 1930 "Företagskonto"', '#KONTO 3001 "Försäljning"',
  '#VER A 1 20260115 "Sale"', '{', '#TRANS 1930 {} 100.00', '#TRANS 3001 {} -100.00', '}',
].join('\n')
const MAPPINGS = [
  { sourceAccount: '1930', sourceName: 'Företagskonto', targetAccount: '1930' },
  { sourceAccount: '3001', sourceName: 'Försäljning', targetAccount: '3001' },
]

function buildCtx() {
  const supabase = { auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: 'user-1' } } }) } }
  return { supabase, companyId: 'company-1', requestId: 'req-7', log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } } as unknown as ExtensionContext
}

const request = (body: Record<string, unknown>) =>
  createMockRequest('http://localhost/api/extensions/ext/arcim-migration/import-sie', { method: 'POST', body })

describe('POST /import-sie: validation reason', () => {
  beforeEach(() => vi.clearAllMocks())

  it('answers 400 with the validator sentence, code and request id', async () => {
    ;(submitSIEJob as Mock).mockRejectedValueOnce(
      new SIEJobValidationError('SIE-verifikation LESSLIE3 (2025-01-02) ligger utanför räkenskapsåret.'),
    )
    const response = await handler(request({ rawContent: SIE, mappings: MAPPINGS, options: {} }), buildCtx())
    const { status, body } = await parseJsonResponse<{ error: { code: string; message: string; requestId: string } }>(response)
    expect(status).toBe(400)
    expect(body.error).toMatchObject({
      code: 'VALIDATION_ERROR',
      message: 'SIE-verifikation LESSLIE3 (2025-01-02) ligger utanför räkenskapsåret.',
      requestId: 'req-7',
    })
  })

  it('keeps the bilingual registry text and details for a code with its own entry', async () => {
    ;(submitSIEJob as Mock).mockRejectedValueOnce(new SIEJobValidationError(
      'Målkonton 9999 stöds inte i balans- och resultatrapporterna.',
      'SIE_IMPORT_UNSUPPORTED_ACCOUNT_CLASS',
      { account_numbers: ['9999'] },
    ))
    const response = await handler(request({ rawContent: SIE, mappings: MAPPINGS, options: {} }), buildCtx())
    const { status, body } = await parseJsonResponse<{ error: { code: string; message: string; message_en: string; details: unknown } }>(response)
    expect(status).toBe(400)
    expect(body.error.code).toBe('SIE_IMPORT_UNSUPPORTED_ACCOUNT_CLASS')
    expect(body.error.message).toContain('1000-8999')
    expect(body.error.message_en).toContain('1000-8999')
    expect(body.error.details).toEqual({ account_numbers: ['9999'] })
  })

  it('names the unmapped accounts in a structured envelope instead of the legacy tag', async () => {
    const response = await handler(
      request({ rawContent: SIE, mappings: [MAPPINGS[0], { ...MAPPINGS[1], targetAccount: '' }], options: {} }),
      buildCtx(),
    )
    const { status, body } = await parseJsonResponse<{ error: { code: string; details: { unmappedAccounts: unknown[] } } }>(response)
    expect(status).toBe(400)
    expect(body.error.code).toBe('SIE_IMPORT_UNMAPPED_ACCOUNTS')
    expect(body.error.details.unmappedAccounts).toEqual([{ account: '3001', name: 'Försäljning' }])
    expect(submitSIEJob).not.toHaveBeenCalled()
  })
})
