/**
 * company_settings is an owner's or admin's table at every door, and a door
 * that wrote nothing says so. The fake applies the policy text the way
 * Postgres does: a session write without the role matches zero rows and raises
 * nothing, which is what a member's logo upload walked into.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { requireSettingsAdmin, writeCompanySettings } from '../settings-writer'

const COMPANY = 'company-1'

function db(options: { role: string | null; row?: 'exists' | 'missing'; failure?: { message: string } }) {
  const writes: unknown[] = []
  const from = (table: string) => {
    const query: Record<string, unknown> = {}
    let writing = false
    for (const method of ['select', 'eq']) query[method] = () => query
    query.update = (columns: unknown) => {
      writing = true
      writes.push(columns)
      return query
    }
    query.maybeSingle = async () => {
      if (table === 'company_members') return { data: options.role ? { role: options.role } : null, error: null }
      if (writing && options.failure) return { data: null, error: options.failure }
      return { data: options.row === 'missing' ? null : { company_id: COMPANY, logo_url: 'x' }, error: null }
    }
    return query
  }
  return { client: { from } as never, writes }
}

const ctx = (supabase: never) => ({ supabase, companyId: COMPANY, userId: 'user-1', log: {} as never })

describe('writeCompanySettings', () => {
  it.each(['owner', 'admin'])('writes for an %s and answers the row', async (role) => {
    const { client, writes } = db({ role })
    const outcome = await writeCompanySettings(ctx(client), { logo_url: 'x' })
    expect(outcome).toEqual({ ok: true, data: { company_id: COMPANY, logo_url: 'x' } })
    expect(writes).toEqual([{ logo_url: 'x' }])
  })

  it.each(['member', 'viewer', 'invoicer', null])('refuses %s without touching the row', async (role) => {
    const { client, writes } = db({ role })
    const outcome = await writeCompanySettings(ctx(client), { logo_url: 'x' })
    expect(outcome).toMatchObject({ ok: false, code: 'FORBIDDEN', details: { required_roles: ['owner', 'admin'] } })
    expect(writes).toEqual([])
  })

  it('says so when the write matched no row, instead of reporting a save', async () => {
    const { client } = db({ role: 'owner', row: 'missing' })
    const outcome = await writeCompanySettings(ctx(client), { logo_url: 'x' })
    expect(outcome).toMatchObject({ ok: false, code: 'NOT_FOUND', details: { resource: 'company_settings' } })
  })

  it('hands a database failure to the door', async () => {
    const failure = { message: 'boom' }
    const { client } = db({ role: 'owner', failure })
    await expect(writeCompanySettings(ctx(client), { logo_url: 'x' })).resolves.toEqual({
      ok: false,
      code: 'UNKNOWN_ERROR',
      error: failure,
    })
  })
})

describe('requireSettingsAdmin', () => {
  it('lets an owner through and refuses a member with the same answer as the write', async () => {
    await expect(requireSettingsAdmin(ctx(db({ role: 'owner' }).client))).resolves.toBeNull()
    await expect(requireSettingsAdmin(ctx(db({ role: 'member' }).client))).resolves.toMatchObject({
      ok: false,
      code: 'FORBIDDEN',
    })
  })
})

/**
 * Every file that writes company_settings by hand, each with why it does not
 * go through writeCompanySettings. A line regex cannot see this (the statement
 * spans lines, and `.from('company_settings')` alone is mostly reads), so the
 * ratchet lives here. A new door belongs on the writer, not on this list.
 */
const HAND_WRITERS: Record<string, string> = {
  'lib/company/settings-writer.ts': 'the writer',
  'lib/company/settings-service.ts': 'the settings save: gates itself, adminVerified from requireAdmin on the session door',
  'lib/company/create-company.ts': 'the row is born with the company, before there is a role to ask',
  'lib/company/registered-office.ts': 'fills a missing säte from the register behind requireAdmin, guarded on the empty value it read; answers not_saved when no row changed',
  'app/api/sandbox/seed/route.ts': 'fills the sandbox row claim_sandbox_seed reserved',
  'app/api/v1/companies/[companyId]/salary/settings/route.ts': 'creates the missing row behind requireSettingsAdmin',
  'lib/reminders/automatic.ts': "Accounted's own column, written with the service role behind requireAdmin; answers the state it reads back",
  'lib/skatteverket/skattekonto-account.ts': 'derives a missing value from the books, no person asking',
}

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '__tests__') continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) sourceFiles(full, out)
    else if (/\.tsx?$/.test(entry.name)) out.push(full)
  }
  return out
}

describe('the hand writers of company_settings', () => {
  it('are the ones named here, and no others', () => {
    const src = path.resolve(__dirname, '..', '..', '..')
    const write = /\.from\(\s*'company_settings'\s*\)\s*\.(?:update|upsert|insert|delete)\(/
    const found = sourceFiles(src)
      .filter((file) => write.test(fs.readFileSync(file, 'utf8')))
      .map((file) => path.relative(src, file).split(path.sep).join('/'))
    expect(found.sort()).toEqual(Object.keys(HAND_WRITERS).sort())
  })
})
