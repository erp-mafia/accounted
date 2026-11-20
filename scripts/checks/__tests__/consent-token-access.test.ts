/**
 * Proof that the consent-token-access guard flags every token read and write
 * of provider_consent_tokens outside the sealed accessor, and nothing else.
 * Fixtures live in an OS temp directory the test creates and deletes.
 */
import { describe, it, expect, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { findConsentTokenAccess, findConsentTokenAccessInSource } from '../consent-token-access.mjs'

const tempDirs: string[] = []
afterAll(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true })
})

function fixture(files: Record<string, string>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'consent-token-access-'))
  tempDirs.push(root)
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(root, rel)
    fs.mkdirSync(path.dirname(full), { recursive: true })
    fs.writeFileSync(full, content)
  }
  return root
}

describe('consent-token-access guard', () => {
  it.each([
    ['an upsert', `await db.from('provider_consent_tokens').upsert({ access_token: t })`, 1],
    ['a multi-line update', `await db\n  .from('provider_consent_tokens')\n  .update({ access_token: t })\n  .eq('consent_id', id)`, 2],
    ['an insert', `db.from("provider_consent_tokens").insert(row)`, 1],
  ])('flags %s as a write', (_label, source, line) => {
    expect(findConsentTokenAccessInSource(source)).toEqual([{ kind: 'write', line }])
  })

  it.each([
    ['select *', `db.from('provider_consent_tokens').select('*').eq('consent_id', id)`],
    ['an empty select', `db.from('provider_consent_tokens').select()`],
    ['a token column', `db.from('provider_consent_tokens').select('consent_id, access_token')`],
    ['the refresh token', `db.from('provider_consent_tokens').select(\`refresh_token\`)`],
    ['an embed', `db.from('provider_consents').select('id, provider_consent_tokens(*)')`],
    ['an embed of a token column', `db.from('provider_consents').select('id, provider_consent_tokens(access_token)')`],
  ])('flags a read of %s', (_label, source) => {
    expect(findConsentTokenAccessInSource(source)).toEqual([{ kind: 'read', line: 1 }])
  })

  it('leaves non-secret reads and deletes alone', () => {
    const source = [
      `db.from('provider_consent_tokens').select('consent_id').eq('consent_id', id)`,
      `db.from('provider_consent_tokens').select('provider_company_id').maybeSingle()`,
      `db.from('provider_consent_tokens').delete().eq('consent_id', id)`,
      `db.from('provider_consents').select('id, provider_consent_tokens(consent_id)')`,
    ].join('\n')
    expect(findConsentTokenAccessInSource(source)).toEqual([])
  })

  it('scans source dirs but skips the accessor itself and tests', () => {
    const write = `export const f = (db) => db.from('provider_consent_tokens').upsert({ access_token: 'x' })\n`
    const root = fixture({
      'lib/providers/consent-tokens.ts': write,
      'lib/providers/__tests__/x.test.ts': write,
      'lib/providers/other.test.ts': write,
      'extensions/general/arcim-migration/lib/provider-client.ts': `\n${write}`,
    })
    expect(findConsentTokenAccess(root)).toEqual([
      { file: 'extensions/general/arcim-migration/lib/provider-client.ts', line: 2, kind: 'write' },
    ])
  })
})
