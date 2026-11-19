/**
 * Proof that the local-test-mock guard finds a hand-rolled Supabase chain,
 * cronRequest or setActiveCompany in a test file, and leaves the shared
 * helpers and non-test code alone. Fixtures live in an OS temp directory the
 * test creates and deletes.
 */
import { describe, it, expect, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { findLocalTestMocks } from '../local-test-mock.mjs'

const tempDirs: string[] = []
afterAll(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true })
})

function repoWith(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'local-test-mock-'))
  tempDirs.push(root)
  for (const [rel, source] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true })
    fs.writeFileSync(path.join(root, rel), source)
  }
  return root
}

const CHAIN = `const handler = { get(_t: object, prop: string) { if (prop === 'then') return resolve } }\n`

describe('local-test-mock', () => {
  it('finds each local copy in a test file', () => {
    const root = repoWith({
      'src/app/api/x/__tests__/route.test.ts': CHAIN + 'function cronRequest(): Request {}\n',
      'tests/pg/y.pg.test.ts': 'async function setActiveCompany(userId: string, companyId: string) {}\n',
      'src/lib/z/z.test.ts': 'const cronRequest = () => new Request("http://x")\n',
    })
    expect(findLocalTestMocks(root)).toEqual({
      supabaseChain: ['src/app/api/x/__tests__/route.test.ts'],
      cronRequest: ['src/app/api/x/__tests__/route.test.ts', 'src/lib/z/z.test.ts'],
      setActiveCompany: ['tests/pg/y.pg.test.ts'],
    })
  })

  it('leaves the shared helpers, their callers and production code alone', () => {
    const root = repoWith({
      'tests/helpers.ts': CHAIN + 'export function createCronRequest(path: string) {}\n',
      'tests/pg/fixtures.ts': 'export async function setActiveCompany(userId: string, companyId: string) {}\n',
      'src/lib/company/context.ts': 'export async function setActiveCompany(supabase, userId, companyId) {}\n',
      'src/app/api/x/__tests__/route.test.ts': "await GET(createCronRequest('/api/x/cron'))\n",
    })
    expect(findLocalTestMocks(root)).toEqual({ supabaseChain: [], cronRequest: [], setActiveCompany: [] })
  })
})
