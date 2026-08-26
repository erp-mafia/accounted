/**
 * Tests for the CP1252-mojibake tripwire on POST /import-sie.
 *
 * This handler receives SIE as an ALREADY-DECODED string (rawContent in JSON),
 * so an upstream that decoded CP437 bytes as windows-1252 has baked the
 * corruption in before the repo's own encoding detection could run: exactly
 * what the retired Arcim Sync gateway did on 2026-03-17, landing mojibake
 * ("L”neutbetalning", "BANKTJŽNSTER") in posted entries with no warning.
 *
 * The tripwire must WARN and NEVER BLOCK: the import proceeds untouched and
 * the warning rides on result.warnings, which the migration workspace UI
 * already renders. The mojibake literals below are the subject under test and
 * must stay byte-exact.
 */
import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest'
import { createMockRequest, parseJsonResponse } from '@/tests/helpers'
import type { ExtensionContext } from '@/lib/extensions/types'

vi.mock('@/lib/import/sie-import', () => ({
  loadMappings: vi.fn(),
  generateImportPreview: vi.fn(),
  executeSIEImport: vi.fn(),
}))

import { arcimMigrationExtension } from '../index'
import { executeSIEImport } from '@/lib/import/sie-import'

const importSieRoute = (arcimMigrationExtension.apiRoutes ?? []).find(
  (r) => r.method === 'POST' && r.path === '/import-sie',
)!

type RouteHandler = (request: Request, ctx?: ExtensionContext) => Promise<Response>
const handler = importSieRoute.handler as RouteHandler

const MOJIBAKE_SIE = [
  '#FLAGGA 0',
  '#SIETYP 4',
  '#FNAMN "Migrerad AB"',
  '#RAR 0 20240101 20241231',
  '#KONTO 1930 "F”retagskonto"',
  '#KONTO 4056 "Ink”p tj„nster inom EU"',
  '#VER A 1 20240115 "L”neutbetalning"',
  '{',
  '#TRANS 1930 {} -100.00',
  '#TRANS 4056 {} 100.00',
  '}',
].join('\n')

const CLEAN_SIE = MOJIBAKE_SIE
  .replace('F”retagskonto', 'Företagskonto')
  .replace('Ink”p tj„nster inom EU', 'Inköp tjänster inom EU')
  .replace('L”neutbetalning', 'Löneutbetalning')

const MAPPINGS = [
  { sourceAccount: '1930', sourceName: 'Företagskonto', targetAccount: '1930' },
  { sourceAccount: '4056', sourceName: 'Inköp tjänster inom EU', targetAccount: '4056' },
]

function buildCtx(userId: string | null) {
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
  const supabase = {
    auth: {
      getUser: vi.fn().mockResolvedValue({ data: { user: userId ? { id: userId } : null } }),
    },
  }
  const ctx = { supabase, companyId: 'company-1', log } as unknown as ExtensionContext
  return { ctx, log }
}

function importRequest(body: Record<string, unknown>) {
  return createMockRequest('http://localhost/api/extensions/ext/arcim-migration/import-sie', {
    method: 'POST',
    body,
  })
}

describe('POST /import-sie: mojibake tripwire', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // Fresh result object per call: the handler pushes onto result.warnings.
    ;(executeSIEImport as Mock).mockImplementation(async () => ({
      success: true,
      journalEntriesCreated: 1,
      errors: [],
      warnings: [],
    }))
  })

  it('returns 401 when unauthenticated', async () => {
    const { ctx } = buildCtx(null)
    const response = await handler(
      importRequest({ rawContent: CLEAN_SIE, mappings: MAPPINGS, options: {} }),
      ctx,
    )
    expect(response.status).toBe(401)
    expect(executeSIEImport).not.toHaveBeenCalled()
  })

  it('returns 400 when rawContent is missing', async () => {
    const { ctx } = buildCtx('user-1')
    const response = await handler(importRequest({ mappings: MAPPINGS, options: {} }), ctx)
    expect(response.status).toBe(400)
    expect(executeSIEImport).not.toHaveBeenCalled()
  })

  it('surfaces a Swedish warning on mojibaked content WITHOUT blocking the import', async () => {
    const { ctx, log } = buildCtx('user-1')
    const response = await handler(
      importRequest({ rawContent: MOJIBAKE_SIE, mappings: MAPPINGS, options: {} }),
      ctx,
    )
    const { status, body } = await parseJsonResponse<{ warnings: string[] }>(response)

    expect(status).toBe(200)
    // Warn, never block: the import ran despite the flagged content.
    expect(executeSIEImport).toHaveBeenCalledTimes(1)

    const tripwire = body.warnings.find((w) => w.includes('felaktigt teckenkodad'))
    expect(tripwire).toBeDefined()
    // The first flagged string (accounts are scanned first) is the example.
    expect(tripwire).toContain('F”retagskonto')
    // Must dodge the workspace UI's structured-card filters, or the warning
    // silently disappears from the "Remaining warnings" card.
    expect(tripwire).not.toContain('hoppades över')
    expect(tripwire).not.toContain('förts om till eget kapital')

    expect(log.warn).toHaveBeenCalledWith(
      'import-sie: CP1252 mojibake artifacts in SIE text',
      expect.objectContaining({ artifactCount: 3 }),
    )
  })

  it('adds no warning for clean content', async () => {
    const { ctx, log } = buildCtx('user-1')
    const response = await handler(
      importRequest({ rawContent: CLEAN_SIE, mappings: MAPPINGS, options: {} }),
      ctx,
    )
    const { status, body } = await parseJsonResponse<{ warnings: string[] }>(response)

    expect(status).toBe(200)
    expect(executeSIEImport).toHaveBeenCalledTimes(1)
    expect(body.warnings.some((w) => w.includes('felaktigt teckenkodad'))).toBe(false)
    expect(log.warn).not.toHaveBeenCalled()
  })
})
