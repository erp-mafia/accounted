/**
 * pg-real tests for 20261029230000_commitments_and_holdings.sql (Bolaget
 * W5): manual agreements beside the derived ones (nullable
 * source_document_id with the per-document uniqueness kept, the origin
 * CHECK, the expanded kind CHECK, member writes on manual rows only, the
 * writer role, the audit of manual rows), the expected payments of a manual
 * agreement, the securities_and_contingencies and company_group_links
 * registers (RLS isolation, writer role, CHECKs, same-company references,
 * no delete), and the asset identification columns.
 */
import { randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import { beforeAll, describe, expect, it } from 'vitest'
import { getPool, withUserContext } from './setup'
import { insertAuthUser, insertCompanyMember, seedCompany } from './fixtures'

let a: { userId: string; companyId: string }
let b: { userId: string; companyId: string }
let viewerId: string

async function insertDocument(userId: string, companyId: string): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.document_attachments
       (id, user_id, company_id, file_name, mime_type, file_size_bytes, storage_path, sha256_hash, upload_source, doc_type, page_count)
     VALUES ($1, $2, $3, 'avtal.pdf', 'application/pdf', 1024, $4, $5, 'file_upload', 'agreement.rental', 1)`,
    [id, userId, companyId, `documents/${companyId}/${id}.pdf`, randomUUID().replace(/-/g, '').padEnd(64, '0')],
  )
  return id
}

async function insertManualAgreement(companyId: string, kind = 'rental'): Promise<string> {
  const { rows } = await getPool().query<{ id: string }>(
    `INSERT INTO public.agreements (company_id, kind, title, origin, amount, period, starts_on)
     VALUES ($1, $2, 'Manuellt avtal', 'manual', 1000, 'monthly', '2026-01-01') RETURNING id`,
    [companyId, kind],
  )
  return rows[0].id
}

beforeAll(async () => {
  a = await seedCompany()
  b = await seedCompany()
  viewerId = await insertAuthUser()
  await insertCompanyMember({ companyId: a.companyId, userId: viewerId, role: 'viewer' })
})

describe('agreements: manual rows', () => {
  it('takes any number of manual rows without a document, and keeps one derived agreement per document', async () => {
    await insertManualAgreement(a.companyId)
    await insertManualAgreement(a.companyId)
    const doc = await insertDocument(a.userId, a.companyId)
    const derived = (docId: string) =>
      getPool().query(`INSERT INTO public.agreements (company_id, kind, title, source_document_id) VALUES ($1, 'rental', 'Läst', $2)`, [a.companyId, docId])
    await derived(doc)
    await expect(derived(doc)).rejects.toThrow(/agreements_source_document_id_key/)
  })

  it('ties origin to the source document: derived needs one, manual has none', async () => {
    const doc = await insertDocument(a.userId, a.companyId)
    await expect(
      getPool().query(`INSERT INTO public.agreements (company_id, kind, title) VALUES ($1, 'rental', 'Utan dokument')`, [a.companyId]),
    ).rejects.toThrow(/agreements_origin_source_check/)
    await expect(
      getPool().query(`INSERT INTO public.agreements (company_id, kind, title, origin, source_document_id) VALUES ($1, 'rental', 'X', 'manual', $2)`, [a.companyId, doc]),
    ).rejects.toThrow(/agreements_origin_source_check/)
    await expect(
      getPool().query(`INSERT INTO public.agreements (company_id, kind, title, origin) VALUES ($1, 'rental', 'X', 'imported')`, [a.companyId]),
    ).rejects.toThrow(/agreements_origin_check/)
  })

  it('accepts the new kinds next to the old ones and refuses an unknown one', async () => {
    for (const kind of ['permit', 'ip_right', 'domain', 'guarantee', 'rental', 'customer', 'other']) {
      await expect(insertManualAgreement(a.companyId, kind)).resolves.toBeTruthy()
    }
    await expect(insertManualAgreement(a.companyId, 'marriage')).rejects.toThrow(/agreements_kind_check/)
  })

  it('lets a writing member register and change a manual agreement, never a derived one', async () => {
    // withUserContext rolls back, so the member registers and changes the
    // agreement in one transaction.
    const updated = await withUserContext(a.userId, async (client) => {
      const created = await client.query<{ id: string }>(
        `INSERT INTO public.agreements (company_id, kind, title, origin, created_by) VALUES ($1, 'domain', 'exempel.se', 'manual', $2) RETURNING id`,
        [a.companyId, a.userId],
      )
      return client.query(`UPDATE public.agreements SET ends_on = '2027-05-01' WHERE id = $1`, [created.rows[0].id])
    })
    expect(updated.rowCount).toBe(1)

    await expect(
      withUserContext(a.userId, (client) =>
        client.query(`INSERT INTO public.agreements (company_id, kind, title, source_document_id) VALUES ($1, 'rental', 'Låtsas läst', $2)`, [a.companyId, randomUUID()]),
      ),
    ).rejects.toThrow(/row-level security|violates/)

    const doc = await insertDocument(a.userId, a.companyId)
    const { rows } = await getPool().query<{ id: string }>(
      `INSERT INTO public.agreements (company_id, kind, title, source_document_id) VALUES ($1, 'rental', 'Läst', $2) RETURNING id`,
      [a.companyId, doc],
    )
    const derivedUpdate = await withUserContext(a.userId, (client) => client.query(`UPDATE public.agreements SET amount = 1 WHERE id = $1`, [rows[0].id]))
    expect(derivedUpdate.rowCount).toBe(0)
    // Ended, not removed: no member deletes an agreement, manual or derived.
    const manual = await insertManualAgreement(a.companyId)
    const deleted = await withUserContext(a.userId, (client) =>
      client.query(`DELETE FROM public.agreements WHERE id = ANY($1::uuid[])`, [[manual, rows[0].id]]),
    )
    expect(deleted.rowCount).toBe(0)
  })

  it('keeps a viewer and another company out', async () => {
    const id = await insertManualAgreement(a.companyId)
    await expect(
      withUserContext(viewerId, (client) =>
        client.query(`INSERT INTO public.agreements (company_id, kind, title, origin) VALUES ($1, 'rental', 'X', 'manual')`, [a.companyId]),
      ),
    ).rejects.toMatchObject({ code: '42501' })
    await expect(withUserContext(viewerId, (client) => client.query(`UPDATE public.agreements SET title = 'Y' WHERE id = $1`, [id]))).rejects.toMatchObject({
      code: '42501',
    })
    const seenByB = await withUserContext(b.userId, async (client) => (await client.query(`SELECT id FROM public.agreements WHERE id = $1`, [id])).rowCount)
    expect(seenByB).toBe(0)
    await expect(
      withUserContext(b.userId, (client) =>
        client.query(`INSERT INTO public.agreements (company_id, kind, title, origin) VALUES ($1, 'rental', 'X', 'manual')`, [a.companyId]),
      ),
    ).rejects.toThrow(/row-level security|violates/)
  })

  it('logs who registered or changed a manual agreement, and leaves derived rows out of the log', async () => {
    const id = await insertManualAgreement(a.companyId)
    const doc = await insertDocument(a.userId, a.companyId)
    const { rows } = await getPool().query<{ id: string }>(
      `INSERT INTO public.agreements (company_id, kind, title, source_document_id) VALUES ($1, 'rental', 'Läst', $2) RETURNING id`,
      [a.companyId, doc],
    )
    const logged = async (recordId: string) =>
      (await getPool().query(`SELECT action FROM public.audit_log WHERE table_name = 'agreements' AND record_id = $1`, [recordId])).rows.map((r) => r.action)
    expect(await logged(id)).toEqual(['INSERT'])
    expect(await logged(rows[0].id)).toEqual([])
  })
})

describe('agreement_obligations of a manual agreement', () => {
  it('are written by a writing member, not by a viewer', async () => {
    const id = await insertManualAgreement(a.companyId)
    const insert = (client: PoolClient, dueOn: string) =>
      client.query(`INSERT INTO public.agreement_obligations (company_id, agreement_id, kind, due_on, amount) VALUES ($1, $2, 'payment', $3, 1000)`, [a.companyId, id, dueOn])
    // withUserContext rolls back, so the member writes and removes the
    // expected payment in one transaction.
    const removed = await withUserContext(a.userId, async (client) => {
      await insert(client, '2026-02-01')
      return client.query(`DELETE FROM public.agreement_obligations WHERE agreement_id = $1 AND due_on = '2026-02-01'`, [id])
    })
    expect(removed.rowCount).toBe(1)
    await expect(withUserContext(viewerId, (client) => insert(client, '2026-03-01'))).rejects.toMatchObject({ code: '42501' })
  })
})

describe('securities_and_contingencies', () => {
  const insert = (companyId: string, userId: string, fields: Record<string, unknown> = {}) => {
    const row = { kind: 'foretagsinteckning', description: 'Företagsinteckning', amount: 500000, ...fields }
    const cols = Object.keys(row)
    return getPool().query<{ id: string }>(
      `INSERT INTO public.securities_and_contingencies (company_id, user_id, ${cols.join(', ')})
       VALUES ($1, $2, ${cols.map((_, i) => `$${i + 3}`).join(', ')}) RETURNING id`,
      [companyId, userId, ...Object.values(row)],
    )
  }

  it('refuses an unknown kind, a negative amount and an end before the start', async () => {
    await expect(insert(a.companyId, a.userId, { kind: 'pant' })).rejects.toMatchObject({ code: '23514' })
    await expect(insert(a.companyId, a.userId, { amount: -1 })).rejects.toMatchObject({ code: '23514' })
    await expect(insert(a.companyId, a.userId, { valid_from: '2026-02-01', valid_to: '2026-01-01' })).rejects.toMatchObject({ code: '23514' })
    await expect(insert(a.companyId, a.userId, { kind: 'borgen', for_group_company: true })).resolves.toBeTruthy()
  })

  it('links only the company\'s own loan agreement', async () => {
    const own = await insertManualAgreement(a.companyId, 'loan')
    const other = await insertManualAgreement(b.companyId, 'loan')
    await expect(insert(a.companyId, a.userId, { agreement_id: own })).resolves.toBeTruthy()
    await expect(insert(a.companyId, a.userId, { agreement_id: other })).rejects.toMatchObject({ code: '23503' })
  })

  it('isolates companies, lets a viewer read but not write, and deletes nothing', async () => {
    const { rows } = await insert(a.companyId, a.userId)
    const id = rows[0].id
    const seen = async (user: string) =>
      withUserContext(user, async (client) => (await client.query(`SELECT id FROM public.securities_and_contingencies WHERE id = $1`, [id])).rowCount)
    expect(await seen(a.userId)).toBe(1)
    expect(await seen(viewerId)).toBe(1)
    expect(await seen(b.userId)).toBe(0)
    await expect(
      withUserContext(viewerId, (client) =>
        client.query(`INSERT INTO public.securities_and_contingencies (company_id, user_id, kind, description, amount) VALUES ($1, $2, 'borgen', 'X', 1)`, [a.companyId, viewerId]),
      ),
    ).rejects.toMatchObject({ code: '42501' })
    const updated = await withUserContext(a.userId, (client) => client.query(`UPDATE public.securities_and_contingencies SET valid_to = '2026-12-31' WHERE id = $1`, [id]))
    expect(updated.rowCount).toBe(1)
    // Ended (valid_to), never removed: a member holds no DELETE privilege at all.
    await expect(
      withUserContext(a.userId, (client) => client.query(`DELETE FROM public.securities_and_contingencies WHERE id = $1`, [id])),
    ).rejects.toMatchObject({ code: '42501' })
    const kept = await getPool().query(`SELECT 1 FROM public.securities_and_contingencies WHERE id = $1`, [id])
    expect(kept.rowCount).toBe(1)
  })
})

describe('company_group_links', () => {
  const insert = (companyId: string, userId: string, fields: Record<string, unknown> = {}) => {
    const row = { relation: 'parent', counterparty_name: 'Ägarbolaget AB', ...fields }
    const cols = Object.keys(row)
    return getPool().query<{ id: string }>(
      `INSERT INTO public.company_group_links (company_id, user_id, ${cols.join(', ')})
       VALUES ($1, $2, ${cols.map((_, i) => `$${i + 3}`).join(', ')}) RETURNING id`,
      [companyId, userId, ...Object.values(row)],
    )
  }

  it('refuses an unknown relation, a percent above 100, an account outside 13xx and a link to itself', async () => {
    await expect(insert(a.companyId, a.userId, { relation: 'sister' })).rejects.toMatchObject({ code: '23514' })
    await expect(insert(a.companyId, a.userId, { ownership_percent: 101 })).rejects.toMatchObject({ code: '23514' })
    await expect(insert(a.companyId, a.userId, { bas_account: '1930' })).rejects.toMatchObject({ code: '23514' })
    await expect(insert(a.companyId, a.userId, { linked_company_id: a.companyId })).rejects.toMatchObject({ code: '23514' })
    await expect(insert(a.companyId, a.userId, { relation: 'subsidiary', bas_account: '1311', ownership_percent: 100, voting_percent: 100 })).resolves.toBeTruthy()
  })

  it('isolates companies and keeps a viewer read-only', async () => {
    const { rows } = await insert(a.companyId, a.userId)
    const id = rows[0].id
    const seenByB = await withUserContext(b.userId, async (client) => (await client.query(`SELECT id FROM public.company_group_links WHERE id = $1`, [id])).rowCount)
    expect(seenByB).toBe(0)
    await expect(
      withUserContext(viewerId, (client) => client.query(`UPDATE public.company_group_links SET ownership_percent = 50 WHERE id = $1`, [id])),
    ).rejects.toMatchObject({ code: '42501' })
    const updated = await withUserContext(a.userId, (client) => client.query(`UPDATE public.company_group_links SET ownership_percent = 50 WHERE id = $1`, [id]))
    expect(updated.rowCount).toBe(1)
  })
})

describe('assets: property and vehicle identification', () => {
  it('refuses a negative taxeringsvärde and lets a deleted car benefit go without the asset', async () => {
    const employeeId = randomUUID()
    await getPool().query(
      `INSERT INTO public.employees (id, company_id, user_id, first_name, last_name, personnummer, personnummer_last4, employment_start)
       VALUES ($1, $2, $3, 'Test', 'Testsson', 'enc-payload', '0000', '2026-01-01')`,
      [employeeId, a.companyId, a.userId],
    )
    const benefitId = randomUUID()
    await getPool().query(
      `INSERT INTO public.employee_benefits (id, employee_id, company_id, user_id, benefit_type, description, monthly_value, valid_from)
       VALUES ($1, $2, $3, $4, 'car', 'Bilförmån', 3200, '2026-01-01')`,
      [benefitId, employeeId, a.companyId, a.userId],
    )
    const assetId = randomUUID()
    await getPool().query(
      `INSERT INTO public.assets
         (id, user_id, company_id, name, category, acquisition_date, acquisition_cost, useful_life_months,
          bas_asset_account, bas_accumulated_account, bas_expense_account, registration_number, employee_benefit_id)
       VALUES ($1, $2, $3, 'Volvo', 'vehicle', '2026-01-01', 400000, 60, '1240', '1249', '7834', 'ABC123', $4)`,
      [assetId, a.userId, a.companyId, benefitId],
    )
    await expect(getPool().query(`UPDATE public.assets SET taxeringsvarde = -1 WHERE id = $1`, [assetId])).rejects.toMatchObject({ code: '23514' })
    await getPool().query(`DELETE FROM public.employee_benefits WHERE id = $1`, [benefitId])
    const { rows } = await getPool().query(`SELECT registration_number, employee_benefit_id FROM public.assets WHERE id = $1`, [assetId])
    expect(rows[0]).toEqual({ registration_number: 'ABC123', employee_benefit_id: null })
  })
})
