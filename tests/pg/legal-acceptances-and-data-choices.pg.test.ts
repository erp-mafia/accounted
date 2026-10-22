import { beforeEach, describe, expect, it } from 'vitest'
import { getPool, runAsServiceRole, withUserContext } from './setup'
import { insertAuthUser, insertCompanyMember, seedCompany } from './fixtures'

/**
 * Migration 20261021170000. legal_acceptances is append-only for every API
 * role and a person reads and writes only their own rows, inside their own
 * companies. user_preferences carries the analytics consent. The company's
 * data choices go through set_company_data_choice: owner or admin only,
 * nothing written for a choice equal to the current state (the default
 * included), an audit_log row for every change.
 */

interface DataChoiceResult {
  ok: boolean
  code?: string
  unchanged?: boolean
  key?: string
  enabled?: boolean
  previous_enabled?: boolean
}

async function setChoice(companyId: string, key: string, enabled: boolean, decidedBy: string): Promise<DataChoiceResult> {
  return runAsServiceRole(async (client) => {
    const { rows } = await client.query<{ result: DataChoiceResult }>(
      `SELECT public.set_company_data_choice($1, $2, $3, $4, 'user', NULL) AS result`,
      [companyId, key, enabled, decidedBy],
    )
    return rows[0].result
  })
}

async function configRow(companyId: string, key: string) {
  const { rows } = await getPool().query(
    `SELECT enabled, source, decided_by, decided_at FROM public.company_capability_config
      WHERE company_id = $1 AND capability_key = $2`,
    [companyId, key],
  )
  return rows[0] ?? null
}

async function auditRows(companyId: string) {
  const { rows } = await getPool().query(
    `SELECT action, user_id, new_state, description FROM public.audit_log
      WHERE company_id = $1 AND table_name = 'company_capability_config'
      ORDER BY created_at, id`,
    [companyId],
  )
  return rows
}

describe('legal_acceptances', () => {
  let userId: string
  let companyId: string

  beforeEach(async () => {
    const seeded = await seedCompany()
    userId = seeded.userId
    companyId = seeded.companyId
  })

  it('lets a person record and read their own acceptance', async () => {
    const rows = await withUserContext(userId, async (client) => {
      await client.query(
        `INSERT INTO public.legal_acceptances (user_id, company_id, document_key, version, method)
         VALUES ($1, $2, 'terms', '2026-03-05', 'accept_all')`,
        [userId, companyId],
      )
      const { rows } = await client.query(`SELECT document_key, version, method FROM public.legal_acceptances`)
      return rows
    })
    expect(rows).toEqual([{ document_key: 'terms', version: '2026-03-05', method: 'accept_all' }])
  })

  it('refuses a row for another person or for a company the person is not in', async () => {
    const other = await insertAuthUser()
    const { companyId: foreignCompany } = await seedCompany()

    await expect(
      withUserContext(userId, (client) =>
        client.query(
          `INSERT INTO public.legal_acceptances (user_id, document_key, version, method) VALUES ($1, 'terms', '2026-03-05', 'accept_all')`,
          [other],
        ),
      ),
    ).rejects.toThrow(/row-level security/)

    await expect(
      withUserContext(userId, (client) =>
        client.query(
          `INSERT INTO public.legal_acceptances (user_id, company_id, document_key, version, method)
           VALUES ($1, $2, 'terms', '2026-03-05', 'accept_all')`,
          [userId, foreignCompany],
        ),
      ),
    ).rejects.toThrow(/row-level security/)
  })

  it('hides other people\'s rows', async () => {
    const other = await insertAuthUser()
    await getPool().query(
      `INSERT INTO public.legal_acceptances (user_id, document_key, version, method) VALUES ($1, 'dpa', '2026-10-21', 'accept_documents')`,
      [other],
    )
    const rows = await withUserContext(userId, async (client) => (await client.query(`SELECT id FROM public.legal_acceptances`)).rows)
    expect(rows).toEqual([])
  })

  it('is append-only for the authenticated and service roles', async () => {
    await getPool().query(
      `INSERT INTO public.legal_acceptances (user_id, document_key, version, method) VALUES ($1, 'terms', '2026-03-05', 'accept_all')`,
      [userId],
    )
    await expect(
      withUserContext(userId, (client) => client.query(`UPDATE public.legal_acceptances SET version = '2027-01-01'`)),
    ).rejects.toThrow(/permission denied/)
    await expect(
      withUserContext(userId, (client) => client.query(`DELETE FROM public.legal_acceptances`)),
    ).rejects.toThrow(/permission denied/)
    await expect(
      runAsServiceRole((client) => client.query(`DELETE FROM public.legal_acceptances WHERE user_id = $1`, [userId])),
    ).rejects.toThrow(/permission denied/)
  })

  it('records a document version once per person', async () => {
    const insert = () =>
      getPool().query(
        `INSERT INTO public.legal_acceptances (user_id, document_key, version, method) VALUES ($1, 'terms', '2026-03-05', 'accept_all')`,
        [userId],
      )
    await insert()
    await expect(insert()).rejects.toThrow(/legal_acceptances_once/)
  })

  it('rejects a malformed document key, version or method', async () => {
    const insert = (key: string, version: string, method: string) =>
      getPool().query(
        `INSERT INTO public.legal_acceptances (user_id, document_key, version, method) VALUES ($1, $2, $3, $4)`,
        [userId, key, version, method],
      )
    await expect(insert('Terms!', '2026-03-05', 'accept_all')).rejects.toThrow(/legal_acceptances_document_key_check/)
    await expect(insert('terms', 'v1', 'accept_all')).rejects.toThrow(/legal_acceptances_version_check/)
    await expect(insert('terms', '2026-03-05', 'clicked')).rejects.toThrow(/legal_acceptances_method_check/)
  })
})

describe('user_preferences.analytics_consent', () => {
  it('stores the person\'s choice and when it was made', async () => {
    const { userId } = await seedCompany()
    const row = await withUserContext(userId, async (client) => {
      await client.query(
        `INSERT INTO public.user_preferences (user_id, analytics_consent, analytics_consent_at) VALUES ($1, true, now())
         ON CONFLICT (user_id) DO UPDATE SET analytics_consent = true, analytics_consent_at = now()`,
        [userId],
      )
      const { rows } = await client.query(`SELECT analytics_consent, analytics_consent_at FROM public.user_preferences WHERE user_id = $1`, [userId])
      return rows[0]
    })
    expect(row.analytics_consent).toBe(true)
    expect(row.analytics_consent_at).not.toBeNull()
  })
})

describe('set_company_data_choice', () => {
  let ownerId: string
  let companyId: string

  beforeEach(async () => {
    const seeded = await seedCompany()
    ownerId = seeded.userId
    companyId = seeded.companyId
  })

  it('switches AI off for an owner, with who decided and an audit row', async () => {
    const result = await setChoice(companyId, 'ai', false, ownerId)
    expect(result).toMatchObject({ ok: true, unchanged: false, key: 'ai', enabled: false, previous_enabled: true })

    expect(await configRow(companyId, 'ai')).toMatchObject({ enabled: false, source: 'company', decided_by: ownerId })
    const audit = await auditRows(companyId)
    expect(audit).toHaveLength(1)
    expect(audit[0]).toMatchObject({ action: 'INSERT', user_id: ownerId, description: 'Switched data choice off: ai' })
    expect(audit[0].new_state).toMatchObject({ capability_key: 'ai', enabled: false, source: 'company' })
  })

  it('writes nothing when the choice equals the default or the stored state', async () => {
    expect(await setChoice(companyId, 'ai', true, ownerId)).toMatchObject({ ok: true, unchanged: true })
    expect(await setChoice(companyId, 'data:pooling', true, ownerId)).toMatchObject({ ok: true, unchanged: true })
    expect(await setChoice(companyId, 'data:contribution', false, ownerId)).toMatchObject({ ok: true, unchanged: true })
    expect(await configRow(companyId, 'ai')).toBeNull()
    expect(await auditRows(companyId)).toEqual([])

    await setChoice(companyId, 'data:contribution', true, ownerId)
    expect(await setChoice(companyId, 'data:contribution', true, ownerId)).toMatchObject({ ok: true, unchanged: true })
    expect(await auditRows(companyId)).toHaveLength(1)
  })

  it('turns contribution on and back off, recording the update', async () => {
    expect(await setChoice(companyId, 'data:contribution', true, ownerId)).toMatchObject({ ok: true, previous_enabled: false })
    expect(await setChoice(companyId, 'data:contribution', false, ownerId)).toMatchObject({ ok: true, unchanged: false, previous_enabled: true })
    expect(await configRow(companyId, 'data:contribution')).toMatchObject({ enabled: false })
    const audit = await auditRows(companyId)
    expect(audit.map((r) => r.action)).toEqual(['INSERT', 'UPDATE'])
  })

  it('refuses a member who is not an owner or admin, and an unknown key', async () => {
    const memberId = await insertAuthUser()
    await insertCompanyMember({ companyId, userId: memberId, role: 'member' })
    expect(await setChoice(companyId, 'ai', false, memberId)).toEqual({ ok: false, code: 'DATA_CHOICE_ADMIN_REQUIRED' })
    expect(await setChoice(companyId, 'package:payroll', false, ownerId)).toEqual({ ok: false, code: 'DATA_CHOICE_UNKNOWN' })
    expect(await configRow(companyId, 'ai')).toBeNull()
  })

  it('lets an admin decide', async () => {
    const adminId = await insertAuthUser()
    await insertCompanyMember({ companyId, userId: adminId, role: 'admin' })
    expect(await setChoice(companyId, 'data:pooling', false, adminId)).toMatchObject({ ok: true, enabled: false })
  })

  it('is not callable by the authenticated role', async () => {
    await expect(
      withUserContext(ownerId, (client) =>
        client.query(`SELECT public.set_company_data_choice($1, 'ai', false, $2, 'user', NULL)`, [companyId, ownerId]),
      ),
    ).rejects.toThrow(/permission denied/)
  })
})
