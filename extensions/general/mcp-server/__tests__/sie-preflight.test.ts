/**
 * gnubok_sie_preflight: the read-only "does this file look correct" scan
 * that runs before gnubok_import_sie. Uses the real SIE parser on inline
 * fixture files; only the Supabase lookups (company orgnr, duplicate
 * imports, stored mappings) are mocked.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { tools } from '../server'

const tool = tools.find((t) => t.name === 'gnubok_sie_preflight')!
const COMPANY_ID = '11111111-1111-4111-8111-111111111111'

// Current-year fiscal year: a past year would trigger the (correct)
// "omföring av årets resultat saknas" warning and turn verdict ok into
// ok_with_warnings.
const YEAR = new Date().getFullYear()
const VALID_SIE = [
  '#FLAGGA 0',
  '#FORMAT PC8',
  '#SIETYP 4',
  '#FNAMN "Testbolaget AB"',
  '#ORGNR 556000-0001',
  `#RAR 0 ${YEAR}0101 ${YEAR}1231`,
  '#KONTO 1930 "Bank"',
  '#KONTO 3001 "Försäljning"',
  `#VER A 1 ${YEAR}0115 "Faktura 1"`,
  '{',
  '#TRANS 1930 {} 1000.00',
  '#TRANS 3001 {} -1000.00',
  '}',
].join('\n')

const UNBALANCED_SIE = VALID_SIE.replace('#TRANS 3001 {} -1000.00', '#TRANS 3001 {} -900.00')

type MockConfig = {
  companyOrg?: string | null
  duplicateFile?: { id: string; imported_at: string } | null
  duplicatePeriod?: Record<string, unknown> | null
}

function mockSupabase(config: MockConfig = {}) {
  const makeChain = (table: string) => {
    const called: string[] = []
    const chain: Record<string | symbol, unknown> = new Proxy(
      {},
      {
        get(_t, prop: string | symbol) {
          if (prop === 'then') {
            return (resolve: (v: unknown) => void) => {
              if (table === 'companies') {
                resolve({
                  data: {
                    org_number: 'companyOrg' in config ? config.companyOrg : '5560000001',
                  },
                  error: null,
                })
              } else if (table === 'sie_imports') {
                if (called.includes('single')) {
                  resolve({ data: config.duplicateFile ?? null, error: null })
                } else {
                  resolve({
                    data: config.duplicatePeriod ? [config.duplicatePeriod] : [],
                    error: null,
                  })
                }
              } else {
                resolve({ data: [], error: null })
              }
            }
          }
          return (..._args: unknown[]) => {
            called.push(String(prop))
            return chain
          }
        },
      }
    )
    return chain
  }
  return { from: (table: string) => makeChain(table) }
}

async function run(args: Record<string, unknown>, config?: MockConfig) {
  return (await tool.execute(
    { filename: 'export.se', ...args },
    COMPANY_ID,
    'user-1',
    mockSupabase(config) as never
  )) as Record<string, unknown>
}

describe('gnubok_sie_preflight', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('is a read-only tool that stages nothing', () => {
    expect(tool).toBeDefined()
    expect(tool.annotations.readOnlyHint).toBe(true)
    expect(tool.annotations.destructiveHint).toBe(false)
  })

  it('passes a clean matching file with verdict ok and passthrough mappings', async () => {
    const result = await run({ file_content: VALID_SIE })

    expect(result.verdict).toBe('ok')
    const file = result.file as Record<string, unknown>
    expect(file.company_name).toBe('Testbolaget AB')
    expect(file.voucher_count).toBe(1)
    expect((result.org_number_match as Record<string, unknown>).match).toBe(true)
    expect(result.duplicate).toBeNull()
    // Mappings are shaped for direct passthrough to gnubok_import_sie.
    const mappings = result.mappings as Array<Record<string, unknown>>
    expect(mappings.length).toBeGreaterThan(0)
    expect(mappings[0]).toHaveProperty('sourceAccount')
    expect(mappings[0]).toHaveProperty('targetAccount')
  })

  it('flags an org-number mismatch as another company\'s bookkeeping', async () => {
    const result = await run({ file_content: VALID_SIE }, { companyOrg: '5599999999' })

    expect(result.verdict).toBe('ok_with_warnings')
    expect((result.org_number_match as Record<string, unknown>).match).toBe(false)
    expect(result.instructions).toContain('STOP')
  })

  it('reports unverified instead of ok when the company has no org number', async () => {
    const result = await run({ file_content: VALID_SIE }, { companyOrg: null })
    const match = result.org_number_match as Record<string, unknown>
    expect(match.verified).toBe(false)
    expect(match.match).toBeNull()
  })

  it('returns verdict invalid with the balance error for an unbalanced voucher', async () => {
    const result = await run({ file_content: UNBALANCED_SIE })

    expect(result.verdict).toBe('invalid')
    const validation = result.validation as { errors: string[] }
    expect(validation.errors.length).toBeGreaterThan(0)
    expect(result.instructions).toContain('do not import')
  })

  it('returns verdict duplicate when the same file hash is already imported', async () => {
    const result = await run(
      { file_content: VALID_SIE },
      { duplicateFile: { id: 'imp-1', imported_at: '2026-08-01T00:00:00Z' } }
    )

    expect(result.verdict).toBe('duplicate')
    expect((result.duplicate as Record<string, unknown>).kind).toBe('file')
  })

  it('returns verdict duplicate when the fiscal year overlaps a completed import', async () => {
    const result = await run(
      { file_content: VALID_SIE },
      {
        duplicatePeriod: {
          id: 'imp-2',
          fiscal_year_start: '2025-01-01',
          fiscal_year_end: '2025-12-31',
          imported_at: '2026-08-01T00:00:00Z',
        },
      }
    )

    expect(result.verdict).toBe('duplicate')
    expect((result.duplicate as Record<string, unknown>).kind).toBe('period')
  })

  it('decodes CP437 bytes from file_content_base64 so åäö survive', async () => {
    // 'Försäljning' and 'Testbolaget' with CP437 bytes: ö=0x94, ä=0x84.
    const cp437 = Buffer.from(
      VALID_SIE.replace(/ö/g, '\x94').replace(/ä/g, '\x84').replace(/å/g, '\x86'),
      'latin1'
    )
    const result = await run({ file_content_base64: cp437.toString('base64') })

    expect(result.verdict).toBe('ok')
    const mappings = result.mappings as Array<{ sourceName?: string }>
    expect(mappings.some((m) => m.sourceName === 'Försäljning')).toBe(true)
  })

  it('rejects a call with neither content field', async () => {
    await expect(run({})).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
  })

  it('refuses oversized inline content instead of risking silent mid-verifikat truncation', async () => {
    const huge = VALID_SIE + '\n' + '#KONTO 9999 "x"\n'.repeat(10_000)
    await expect(run({ file_content: huge })).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      message: expect.stringContaining('gnubok_create_sie_upload'),
    })
  })

  it('accepts oversized base64 WHEN a matching sha256 proves the bytes are complete', async () => {
    // The drop-card widget path: byte-exact content, hash-verified, so the
    // anti-retyping cap does not apply.
    const huge = Buffer.from(VALID_SIE + '\n' + '#KONTO 9999 "x"\n'.repeat(10_000), 'utf8')
    const { createHash } = await import('node:crypto')
    const result = await run({
      file_content_base64: huge.toString('base64'),
      sha256: createHash('sha256').update(huge).digest('hex'),
    })
    expect(result.verdict).toBeDefined()
  })

  it('verifies sha256 on the base64 path and rejects a mismatch as truncation', async () => {
    const bytes = Buffer.from(VALID_SIE, 'utf8')
    const { createHash } = await import('node:crypto')
    const good = createHash('sha256').update(bytes).digest('hex')

    const ok = await run({ file_content_base64: bytes.toString('base64'), sha256: good })
    expect(ok.verdict).toBe('ok')

    await expect(
      run({ file_content_base64: bytes.toString('base64'), sha256: 'a'.repeat(64) })
    ).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      message: expect.stringContaining('sha256 mismatch'),
    })
  })
})

describe('gnubok_create_sie_upload', () => {
  const uploadTool = tools.find((t) => t.name === 'gnubok_create_sie_upload')!

  it('is registered with the filename-only contract', () => {
    expect(uploadTool).toBeDefined()
    expect(
      (uploadTool.inputSchema as { required: string[] }).required
    ).toEqual(['filename'])
  })

  it('rejects a filename that is not a SIE file', async () => {
    await expect(
      uploadTool.execute({ filename: 'export.xlsx' }, COMPANY_ID, 'user-1', {} as never)
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
  })
})
