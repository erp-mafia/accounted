/**
 * crm#1201: the SIE intake is bound to one company and says which.
 *
 * gnubok_create_sie_upload names the company its card imports into
 * (target_company); the preflight answers with the company it checked the
 * file against and, when the file's #ORGNR is another company this
 * connection reaches, names that company; gnubok_import_sie's refusal does
 * the same; an upload_id is not found from another company and says so.
 * The real SIE parser runs on an inline file; Supabase is a table router.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  createPendingDocumentUpload: vi.fn(),
  download: vi.fn(),
}))

vi.mock('@/lib/core/documents/document-service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/core/documents/document-service')>()),
  createPendingDocumentUpload: (...args: unknown[]) => mocks.createPendingDocumentUpload(...args),
}))

vi.mock('@/lib/auth/api-keys', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/api-keys')>()),
  createServiceClientNoCookies: () => ({
    storage: { from: () => ({ download: (...args: unknown[]) => mocks.download(...args) }) },
  }),
}))

import { createTableMockSupabase, type TableMockResolver } from '@/tests/helpers'
import { tools } from '../server'

const uploadTool = tools.find((t) => t.name === 'gnubok_create_sie_upload')!
const preflightTool = tools.find((t) => t.name === 'gnubok_sie_preflight')!
const importTool = tools.find((t) => t.name === 'gnubok_import_sie')!

const CURRENT = '11111111-1111-4111-8111-111111111111'
const SIBLING = '22222222-2222-4222-8222-222222222222'
const OTHER = '33333333-3333-4333-8333-333333333333'

const YEAR = new Date().getFullYear()
// The file belongs to the sibling company (556000-0002), not the current one.
const SIBLING_FILE = [
  '#FLAGGA 0',
  '#SIETYP 4',
  '#FNAMN "Syskonbolaget AB"',
  '#ORGNR 556000-0002',
  `#RAR 0 ${YEAR}0101 ${YEAR}1231`,
  '#KONTO 1930 "Bank"',
  '#KONTO 3001 "Försäljning"',
  `#VER A 1 ${YEAR}0115 "Faktura 1"`,
  '{',
  '#TRANS 1930 {} 1000.00',
  '#TRANS 3001 {} -1000.00',
  '}',
].join('\n')
const OWN_FILE = SIBLING_FILE.replace('#ORGNR 556000-0002', '#ORGNR 556000-0001')

type Row = Record<string, unknown>
type ChainCall = { method: string; args: unknown[] }

interface World {
  companies: Array<{ id: string; name: string; org_number: string | null; archived_at?: string | null }>
  displayNames?: Record<string, string>
  /** Make every read of these tables fail. */
  failing?: string[]
}

const has = (calls: ChainCall[], method: string) => calls.some((c) => c.method === method)
const argOf = (calls: ChainCall[], method: string, column: string) =>
  calls.find((c) => c.method === method && c.args[0] === column)?.args[1]

/** Answers by what each chain asked: one company by id, a list by .in(), the user's memberships. */
function routedSupabase(world: World) {
  const failing = (table: string, answer: TableMockResolver): TableMockResolver => (calls) =>
    world.failing?.includes(table) ? { data: null, error: { message: 'boom' } } : answer(calls)
  // No import history and nothing else stored: a single-row read finds
  // nothing, a list is empty.
  const nothing: TableMockResolver = (calls) => (has(calls, 'single') || has(calls, 'maybeSingle') ? { data: null } : { data: [] })
  const { supabase } = createTableMockSupabase({
    companies: failing('companies', (calls) => {
      if (has(calls, 'in')) {
        const ids = argOf(calls, 'in', 'id') as string[]
        return { data: world.companies.filter((c) => ids.includes(c.id)).map((c) => ({ id: c.id, org_number: c.org_number })) }
      }
      const company = world.companies.find((c) => c.id === argOf(calls, 'eq', 'id'))
      return { data: company ? { name: company.name, org_number: company.org_number } : null }
    }),
    company_settings: failing('company_settings', (calls) => {
      if (has(calls, 'in')) {
        const ids = argOf(calls, 'in', 'company_id') as string[]
        return { data: ids.map((id) => ({ company_id: id, company_name: world.displayNames?.[id] ?? null, org_number: null })) }
      }
      const id = argOf(calls, 'eq', 'company_id') as string
      return { data: { company_name: world.displayNames?.[id] ?? null, org_number: null } }
    }),
    company_members: failing('company_members', () => ({
      data: world.companies.map((c, i) => ({
        id: `m${i}`,
        company_id: c.id,
        role: 'owner',
        companies: { id: c.id, name: c.name, org_number: c.org_number, archived_at: c.archived_at ?? null },
      })),
    })),
    sie_imports: nothing,
    sie_account_mappings: nothing,
    journal_entries: nothing,
    fiscal_periods: nothing,
    'rpc:compute_prior_opening_balances': nothing,
  })
  return supabase
}

const WORLD: World = {
  companies: [
    { id: CURRENT, name: 'Nuvarande AB', org_number: '5560000001' },
    { id: SIBLING, name: 'Syskonbolaget AB', org_number: '5560000002' },
    { id: OTHER, name: 'Tredje AB', org_number: '5560000003' },
  ],
  displayNames: { [CURRENT]: 'Nuvarande Aktiebolag' },
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.createPendingDocumentUpload.mockResolvedValue({
    uploadId: 'upload-1',
    signedUrl: 'https://storage.example.test/upload?token=t',
    expiresAt: '2026-10-15T00:00:00.000Z',
  })
})

describe('gnubok_create_sie_upload names the company its card imports into', () => {
  it('returns target_company with the display name and org number, reserving the upload for that company', async () => {
    const result = (await uploadTool.execute({ filename: 'export.se' }, CURRENT, 'user-1', routedSupabase(WORLD) as never)) as Row

    expect(result.target_company).toEqual({ company_id: CURRENT, name: 'Nuvarande Aktiebolag', org_number: '5560000001' })
    expect(result.upload_id).toBe('upload-1')
    const [, companyId, userId] = mocks.createPendingDocumentUpload.mock.calls[0]
    expect([companyId, userId]).toEqual([CURRENT, 'user-1'])
  })

  it('keeps the upload when the company read fails, still naming the company id', async () => {
    const result = (await uploadTool.execute(
      { filename: 'export.se' },
      CURRENT,
      'user-1',
      routedSupabase({ ...WORLD, failing: ['companies'] }) as never,
    )) as Row

    expect(result.upload_id).toBe('upload-1')
    expect(result.target_company).toEqual({ company_id: CURRENT, name: null, org_number: null })
  })

  it('says the card imports into the company it names, at no extra description length', () => {
    expect(uploadTool.description).toContain('imports into the company it names')
  })
})

describe('gnubok_sie_preflight reports where the file would land', () => {
  it('answers with target_company and asks for the same company_id on the import', async () => {
    const result = (await preflightTool.execute(
      { filename: 'export.se', file_content: OWN_FILE },
      CURRENT,
      'user-1',
      routedSupabase(WORLD) as never,
    )) as Row

    expect(result.verdict).toBe('ok')
    expect(result.target_company).toEqual({ company_id: CURRENT, name: 'Nuvarande Aktiebolag', org_number: '5560000001' })
    expect(result.instructions).toContain('Nuvarande Aktiebolag')
    expect(result.instructions).toContain('same company_id')
  })

  it('names the reachable company whose org number the file carries, and points the card there', async () => {
    const result = (await preflightTool.execute(
      { filename: 'export.se', file_content: SIBLING_FILE },
      CURRENT,
      'user-1',
      routedSupabase(WORLD) as never,
    )) as Row

    expect(result.org_number_match).toMatchObject({
      match: false,
      file_org_number_companies: [{ company_id: SIBLING, name: 'Syskonbolaget AB' }],
    })
    expect(result.instructions).toContain('STOP')
    expect(result.instructions).toContain(`Syskonbolaget AB (${SIBLING})`)
    expect(result.instructions).toContain('gnubok_create_sie_upload again with that company_id')
    expect(result.instructions).toContain('confirm_org_number_mismatch=true')
    const notices = (result.validation as { notices: Array<{ code: string; blocking?: boolean; text: string }> }).notices
    const mismatch = notices.find((n) => n.code === 'sie_org_mismatch')!
    expect(mismatch.blocking).toBe(true)
    expect(mismatch.text).toContain('Numret tillhör Syskonbolaget AB')
  })

  it('names no company the connection does not reach (key allowlist)', async () => {
    const result = (await preflightTool.execute(
      { filename: 'export.se', file_content: SIBLING_FILE },
      CURRENT,
      'user-1',
      routedSupabase(WORLD) as never,
      { type: 'api_key', allowedCompanyIds: [CURRENT, OTHER] },
    )) as Row

    expect(result.org_number_match).toMatchObject({ match: false })
    expect(result.org_number_match).not.toHaveProperty('file_org_number_companies')
    expect(result.instructions).toContain('STOP')
    expect(result.instructions).not.toContain(SIBLING)
  })

  it('names no archived company, and stays a plain STOP when the lookup fails', async () => {
    const archived: World = {
      ...WORLD,
      companies: WORLD.companies.map((c) => (c.id === SIBLING ? { ...c, archived_at: '2026-01-01T00:00:00Z' } : c)),
    }
    const archivedResult = (await preflightTool.execute(
      { filename: 'export.se', file_content: SIBLING_FILE },
      CURRENT,
      'user-1',
      routedSupabase(archived) as never,
    )) as Row
    expect(archivedResult.org_number_match).not.toHaveProperty('file_org_number_companies')

    const failing = (await preflightTool.execute(
      { filename: 'export.se', file_content: SIBLING_FILE },
      CURRENT,
      'user-1',
      routedSupabase({ ...WORLD, failing: ['company_members'] }) as never,
    )) as Row
    expect(failing.org_number_match).toMatchObject({ match: false })
    expect(failing.instructions).toContain('STOP')
  })

  it('does not find an upload_id from another company, and says the upload belongs to its company', async () => {
    mocks.download.mockResolvedValue({ data: null, error: { message: 'not found' } })

    await expect(
      preflightTool.execute({ filename: 'export.se', upload_id: 'upload-1' }, SIBLING, 'user-1', routedSupabase(WORLD) as never),
    ).rejects.toMatchObject({
      code: 'NOT_FOUND',
      message: expect.stringContaining('company_id that upload was created for'),
    })
    // The pending key is the company's own prefix.
    expect(String(mocks.download.mock.calls[0][0])).toContain(`/${SIBLING}/user-1/pending/upload-1_`)
  })
})

describe('gnubok_import_sie refuses another organisation\'s file and says where it belongs', () => {
  const mappings = [
    { sourceAccount: '1930', sourceName: 'Bank', targetAccount: '1930', targetName: 'Bank', confidence: 1, matchType: 'exact', isOverride: false },
    { sourceAccount: '3001', sourceName: 'Försäljning', targetAccount: '3001', targetName: 'Försäljning', confidence: 1, matchType: 'exact', isOverride: false },
  ]

  it('names the reachable company with the file\'s org number in the refusal', async () => {
    await expect(
      importTool.execute(
        { filename: 'export.se', file_content: SIBLING_FILE, mappings },
        CURRENT,
        'user-1',
        routedSupabase(WORLD) as never,
        { type: 'api_key' },
      ),
    ).rejects.toMatchObject({
      code: 'SIE_IMPORT_ORG_NUMBER_MISMATCH',
      message: expect.stringContaining(`Syskonbolaget AB (${SIBLING}), which this connection also reaches`),
    })
  })

  it('keeps the plain refusal when no reachable company carries the number', async () => {
    const lonely: World = { companies: [WORLD.companies[0]] }
    const error = await importTool
      .execute({ filename: 'export.se', file_content: SIBLING_FILE, mappings }, CURRENT, 'user-1', routedSupabase(lonely) as never, { type: 'api_key' })
      .catch((e: unknown) => e as Error & { code: string })
    expect((error as { code: string }).code).toBe('SIE_IMPORT_ORG_NUMBER_MISMATCH')
    expect((error as Error).message).not.toContain('also reaches')
    expect((error as Error).message).toContain('confirm_org_number_mismatch=true')
  })
})
