/**
 * gnubok_sie_preflight and gnubok_import_sie read an upload_id's file from
 * the caller's own pending folder, documents/<company>/<user>/pending/, and
 * take upload_id only in the form gnubok_create_sie_upload issues it: a UUID.
 *
 * The service client is the real one (createServiceRoleClient, as
 * createServiceClientNoCookies builds it) over a fake fetch that records
 * each request path and answers by that path.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const store = vi.hoisted(() => ({ requested: [] as string[], objects: new Map<string, string>() }))

vi.mock('@/lib/auth/api-keys', async (importOriginal) => {
  const { createServiceRoleClient } = await import('@/lib/supabase/service-client')
  const storageFetch = async (input: RequestInfo | URL) => {
    const path = new URL(input instanceof Request ? input.url : String(input)).pathname
    store.requested.push(path)
    const body = store.objects.get(path)
    return body === undefined
      ? new Response(JSON.stringify({ statusCode: '404', error: 'not_found', message: 'Object not found' }), { status: 400 })
      : new Response(body, { status: 200 })
  }
  return {
    ...(await importOriginal<typeof import('@/lib/auth/api-keys')>()),
    createServiceClientNoCookies: () =>
      createServiceRoleClient('https://project.supabase.test', 'service-role-key', {
        global: { fetch: storageFetch as typeof fetch },
      }),
  }
})

import { createTableMockSupabase, type TableMockResolver } from '@/tests/helpers'
import { tools } from '../server'

const preflightTool = tools.find((t) => t.name === 'gnubok_sie_preflight')!
const importTool = tools.find((t) => t.name === 'gnubok_import_sie')!

const COMPANY = '11111111-1111-4111-8111-111111111111'
const USER = '44444444-4444-4444-8444-444444444444'
const UPLOAD = '66666666-6666-4666-8666-666666666666'
const OWN_KEY = `/storage/v1/object/documents/documents/${COMPANY}/${USER}/pending/${UPLOAD}_export.se`

const YEAR = new Date().getFullYear()
const OWN_FILE = [
  '#FLAGGA 0',
  '#SIETYP 4',
  '#FNAMN "Bolag A AB"',
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

type ChainCall = { method: string; args: unknown[] }
const has = (calls: ChainCall[], method: string) => calls.some((c) => c.method === method)

function callerSupabase() {
  // No import history and nothing else stored.
  const nothing: TableMockResolver = (calls) => (has(calls, 'single') || has(calls, 'maybeSingle') ? { data: null } : { data: [] })
  const { supabase } = createTableMockSupabase({
    companies: () => ({ data: { name: 'Bolag A AB', org_number: '5560000001', entity_type: 'aktiebolag' } }),
    company_settings: () => ({ data: { company_name: 'Bolag A AB', org_number: null } }),
    company_members: () => ({
      data: [{ id: 'm0', company_id: COMPANY, role: 'owner', companies: { id: COMPANY, name: 'Bolag A AB', org_number: '5560000001', archived_at: null } }],
    }),
    sie_imports: nothing,
    sie_account_mappings: nothing,
    journal_entries: nothing,
    fiscal_periods: nothing,
    'rpc:compute_prior_opening_balances': nothing,
  })
  return supabase
}

beforeEach(() => {
  vi.clearAllMocks()
  store.requested.length = 0
  store.objects.clear()
  store.objects.set(OWN_KEY, OWN_FILE)
})

describe('the SIE tools take only an upload_id the server issued', () => {
  it("reads the caller's own upload by its upload_id", async () => {
    const result = (await preflightTool.execute(
      { upload_id: UPLOAD, filename: 'export.se' },
      COMPANY,
      USER,
      callerSupabase() as never,
    )) as { file: { company_name: string } }

    expect(result.file.company_name).toBe('Bolag A AB')
    expect(store.requested).toEqual([OWN_KEY])
  })

  it.each([
    ['a name', 'upload-1'],
    ['a UUID with a suffix', `${UPLOAD}_x`],
    ['a UUID with a leading space', ` ${UPLOAD}`],
    ['a UUID followed by more segments', `${UPLOAD}/x`],
  ])('refuses %s as upload_id before Storage is asked', async (_form, uploadId) => {
    const calls = [
      () => preflightTool.execute({ upload_id: uploadId, filename: 'export.se' }, COMPANY, USER, callerSupabase() as never),
      () =>
        importTool.execute(
          { upload_id: uploadId, filename: 'export.se', mappings: [] },
          COMPANY,
          USER,
          callerSupabase() as never,
          { type: 'api_key' },
        ),
    ]
    for (const call of calls) {
      await expect(call()).rejects.toMatchObject({ code: 'VALIDATION_ERROR', issues: [{ field: 'upload_id' }] })
    }
    expect(store.requested).toEqual([])
  })
})
