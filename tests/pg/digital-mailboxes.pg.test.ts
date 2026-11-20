import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { getPool, withUserContext } from './setup'
import { insertAuthUser, insertCompanyMember, seedCompany } from './fixtures'

/**
 * Digital mailboxes (migration 20261021140000_digital_mailboxes.sql): one
 * row per company and provider for both directions, members read their own
 * company's rows and write nothing, one company reads a provider account at
 * a time, and the dispatch log's shape.
 */

async function insertConnection(params: {
  companyId: string
  provider?: 'kivra' | 'billo'
  receiveState?: string
  accountRef?: string | null
  mailboxRef?: string | null
}): Promise<string> {
  const { rows } = await getPool().query<{ id: string }>(
    `INSERT INTO public.digital_mailbox_connections (company_id, provider, receive_state, account_ref, mailbox_ref)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [
      params.companyId,
      params.provider ?? 'kivra',
      params.receiveState ?? 'active',
      params.accountRef === undefined ? `ck-${randomUUID()}` : params.accountRef,
      params.mailboxRef ?? null,
    ],
  )
  return rows[0]!.id
}

async function insertInvoice(companyId: string, userId: string): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.invoices (id, user_id, company_id, invoice_number, invoice_date, due_date, total, creation_complete)
     VALUES ($1, $2, $3, $4, '2026-10-19', '2026-11-18', 1250, true)`,
    [id, userId, companyId, `F-${id.slice(0, 8)}`],
  )
  return id
}

describe('digital_mailbox_connections (pg)', () => {
  it('lets members read their own company only, and write nothing', async () => {
    const a = await seedCompany()
    const b = await seedCompany()
    const idA = await insertConnection({ companyId: a.companyId })
    await insertConnection({ companyId: b.companyId })

    const member = await insertAuthUser()
    await insertCompanyMember({ companyId: a.companyId, userId: member, role: 'admin' })

    await withUserContext(member, async (client) => {
      const { rows } = await client.query<{ id: string }>(`SELECT id FROM public.digital_mailbox_connections`)
      expect(rows.map((r) => r.id)).toEqual([idA])
    })
    await withUserContext(member, async (client) => {
      await expect(
        client.query(`UPDATE public.digital_mailbox_connections SET receive_state = 'ended' WHERE id = $1`, [idA]),
      ).rejects.toThrow(/permission denied/)
    })
    await withUserContext(member, async (client) => {
      await expect(
        client.query(`INSERT INTO public.digital_mailbox_connections (company_id, provider) VALUES ($1, 'billo')`, [a.companyId]),
      ).rejects.toThrow(/permission denied/)
    })
  })

  it('keeps one row per company and provider', async () => {
    const a = await seedCompany()
    await insertConnection({ companyId: a.companyId, provider: 'kivra' })
    await insertConnection({
      companyId: a.companyId,
      provider: 'billo',
      accountRef: `pc-${randomUUID()}`,
      mailboxRef: `en-${randomUUID()}`,
    })
    await expect(insertConnection({ companyId: a.companyId, provider: 'kivra' })).rejects.toThrow(/digital_mailbox_connections_company_provider_key/)
  })

  it('lets one company read a provider account at a time; an ended one frees it', async () => {
    const a = await seedCompany()
    const b = await seedCompany()
    const shared = `ck-${randomUUID()}`
    const idA = await insertConnection({ companyId: a.companyId, accountRef: shared })
    await expect(insertConnection({ companyId: b.companyId, accountRef: shared })).rejects.toThrow(/digital_mailbox_connections_one_reader/)
    await getPool().query(`UPDATE public.digital_mailbox_connections SET receive_state = 'ended' WHERE id = $1`, [idA])
    await expect(insertConnection({ companyId: b.companyId, accountRef: shared })).resolves.toEqual(expect.any(String))
  })

  it('refuses an active receiver without its account, and an active Billo row without its enrolment', async () => {
    const a = await seedCompany()
    await expect(insertConnection({ companyId: a.companyId, accountRef: null })).rejects.toThrow(/active_receive_has_account/)
    await expect(
      insertConnection({ companyId: a.companyId, provider: 'billo', accountRef: 'pc-1', mailboxRef: null }),
    ).rejects.toThrow(/billo_receive_has_mailbox/)
    await expect(
      getPool().query(`INSERT INTO public.digital_mailbox_connections (company_id, provider, send_state) VALUES ($1, 'kivra', 'active')`, [
        a.companyId,
      ]),
    ).rejects.toThrow(/active_send_has_tenant/)
  })

  it('grants: authenticated reads, service_role writes, anon nothing', async () => {
    const { rows } = await getPool().query<{ grantee: string; table_name: string; privilege_type: string }>(
      `SELECT grantee, table_name, privilege_type FROM information_schema.role_table_grants
        WHERE table_schema = 'public'
          AND table_name IN ('digital_mailbox_connections', 'digital_mailbox_dispatches')
          AND grantee IN ('anon', 'authenticated', 'service_role')`,
    )
    for (const table of ['digital_mailbox_connections', 'digital_mailbox_dispatches']) {
      const of = (grantee: string) =>
        rows
          .filter((r) => r.table_name === table && r.grantee === grantee)
          .map((r) => r.privilege_type)
          .sort()
      expect(of('authenticated')).toEqual(['SELECT'])
      expect(of('service_role')).toEqual(['DELETE', 'INSERT', 'SELECT', 'UPDATE'])
      expect(of('anon')).toEqual([])
    }
  })
})

describe('digital_mailbox_dispatches (pg)', () => {
  it('records a sent and a failed dispatch, a failure always with its code, readable by members only', async () => {
    const a = await seedCompany()
    const b = await seedCompany()
    const invoiceId = await insertInvoice(a.companyId, a.userId)
    const insert = (status: string, errorCode: string | null, companyId = a.companyId) =>
      getPool().query(
        `INSERT INTO public.digital_mailbox_dispatches (company_id, provider, invoice_id, recipient_kind, status, error_code, sent_by)
         VALUES ($1, 'kivra', $2, 'company', $3, $4, $5)`,
        [companyId, invoiceId, status, errorCode, a.userId],
      )
    await insert('sent', null)
    await insert('failed', 'DIGITAL_MAILBOX_SEND_FAILED')
    await expect(insert('failed', null)).rejects.toThrow(/failure_shape/)
    await expect(insert('sent', 'X')).rejects.toThrow(/failure_shape/)

    const outsider = await insertAuthUser()
    await insertCompanyMember({ companyId: b.companyId, userId: outsider, role: 'owner' })
    await withUserContext(outsider, async (client) => {
      const { rowCount } = await client.query(`SELECT 1 FROM public.digital_mailbox_dispatches WHERE invoice_id = $1`, [invoiceId])
      expect(rowCount).toBe(0)
    })
    await withUserContext(a.userId, async (client) => {
      const { rowCount } = await client.query(`SELECT 1 FROM public.digital_mailbox_dispatches WHERE invoice_id = $1`, [invoiceId])
      expect(rowCount).toBe(2)
    })
  })
})
