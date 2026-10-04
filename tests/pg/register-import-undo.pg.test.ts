import { randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import { describe, expect, it } from 'vitest'
import { getPool, runAsServiceRole, withUserContext } from './setup'
import { insertAuthUser, insertCompanyMember, seedCompany } from './fixtures'

/**
 * register_import_runs + undo_register_import (migration
 * 20261003201500_register_import_runs.sql).
 *
 * The undo deletes the rows an import created unless a foreign key points at
 * them, read from the catalog: these tests reference rows through three
 * different tables (invoices and deadlines, both ON DELETE SET NULL, and
 * invoice_items for articles, invoice_inbox_items for suppliers) to prove the
 * check is not a hand-kept list and that a SET NULL key still keeps the row.
 */

type UndoResult = {
  deleted: number
  kept: Array<{ id: string; name: string; reason: string; referenced_by: string[] | null }>
}

async function insertRow(
  table: 'customers' | 'suppliers' | 'articles',
  companyId: string,
  userId: string,
  name: string,
): Promise<string> {
  const { rows } = await getPool().query<{ id: string }>(
    `INSERT INTO public.${table} (company_id, user_id, name) VALUES ($1, $2, $3) RETURNING id`,
    [companyId, userId, name],
  )
  return rows[0]!.id
}

async function insertRun(params: {
  companyId: string
  userId: string
  kind: 'customers' | 'suppliers' | 'articles'
  createdIds: string[]
}): Promise<string> {
  const { rows } = await getPool().query<{ id: string }>(
    `INSERT INTO public.register_import_runs (company_id, user_id, kind, created_ids)
     VALUES ($1, $2, $3, $4::uuid[]) RETURNING id`,
    [params.companyId, params.userId, params.kind, params.createdIds],
  )
  return rows[0]!.id
}

async function insertInvoice(companyId: string, userId: string, customerId: string | null): Promise<string> {
  const { rows } = await getPool().query<{ id: string }>(
    `INSERT INTO public.invoices (company_id, user_id, customer_id, invoice_date, due_date)
     VALUES ($1, $2, $3, '2026-10-01', '2026-10-31') RETURNING id`,
    [companyId, userId, customerId],
  )
  return rows[0]!.id
}

async function exists(table: string, id: string): Promise<boolean> {
  const { rows } = await getPool().query(`SELECT 1 FROM public.${table} WHERE id = $1`, [id])
  return rows.length === 1
}

async function undoAs(client: PoolClient, companyId: string, runId: string, userId?: string): Promise<UndoResult> {
  const { rows } = await client.query<{ r: UndoResult }>(
    `SELECT public.undo_register_import($1, $2, $3) AS r`,
    [companyId, runId, userId ?? null],
  )
  return rows[0]!.r
}

async function errcode(fn: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await fn()
  } catch (err) {
    return (err as { code?: string }).code
  }
  return undefined
}

describe('register_import_runs RLS (pg)', () => {
  it('lets a writer record a run for themself and read it back', async () => {
    const { userId, companyId } = await seedCompany()

    const kind = await withUserContext(userId, async (client) => {
      await client.query(
        `INSERT INTO public.register_import_runs (company_id, user_id, kind, created_ids)
         VALUES ($1, $2, 'customers', ARRAY[gen_random_uuid()])`,
        [companyId, userId],
      )
      const { rows } = await client.query<{ kind: string; created_count: number }>(
        `SELECT kind, created_count FROM public.register_import_runs WHERE company_id = $1`,
        [companyId],
      )
      return rows
    })

    expect(kind).toEqual([{ kind: 'customers', created_count: 1 }])
  })

  it('refuses a run recorded in another user name, by a viewer, or already marked undone', async () => {
    const { userId, companyId } = await seedCompany()
    const viewer = await insertAuthUser()
    await insertCompanyMember({ companyId, userId: viewer, role: 'viewer' })

    const insert = (actor: string, owner: string, undone = false) =>
      errcode(() =>
        withUserContext(actor, (client) =>
          client.query(
            `INSERT INTO public.register_import_runs (company_id, user_id, kind, undone_at, undone_by, undo_result)
             VALUES ($1, $2, 'articles', $3, $4, $5)`,
            [companyId, owner, undone ? new Date() : null, undone ? actor : null, undone ? '{}' : null],
          ),
        ),
      )

    expect(await insert(userId, viewer)).toBe('42501')
    expect(await insert(viewer, viewer)).toBe('42501')
    expect(await insert(userId, userId, true)).toBe('42501')
  })

  it('hides runs from other companies and gives clients no UPDATE or DELETE', async () => {
    const a = await seedCompany()
    const b = await seedCompany()
    const runId = await insertRun({ companyId: a.companyId, userId: a.userId, kind: 'customers', createdIds: [] })

    const seenByB = await withUserContext(b.userId, async (client) => {
      const { rows } = await client.query(`SELECT id FROM public.register_import_runs WHERE id = $1`, [runId])
      return rows.length
    })
    expect(seenByB).toBe(0)

    expect(
      await errcode(() =>
        withUserContext(a.userId, (client) =>
          client.query(`UPDATE public.register_import_runs SET undone_at = now() WHERE id = $1`, [runId]),
        ),
      ),
    ).toBe('42501')
    expect(
      await errcode(() =>
        withUserContext(a.userId, (client) =>
          client.query(`DELETE FROM public.register_import_runs WHERE id = $1`, [runId]),
        ),
      ),
    ).toBe('42501')
  })
})

describe('undo_register_import (pg)', () => {
  it('deletes unused created customers, keeps the ones an invoice or a deadline uses, and leaves other rows alone', async () => {
    const { userId, companyId } = await seedCompany()
    const unused = await insertRow('customers', companyId, userId, 'Oanvänd kund')
    const onInvoice = await insertRow('customers', companyId, userId, 'Kund med faktura')
    const onDeadline = await insertRow('customers', companyId, userId, 'Kund med datum')
    const removedByHand = randomUUID()
    const preExisting = await insertRow('customers', companyId, userId, 'Fanns före importen')
    const invoiceId = await insertInvoice(companyId, userId, onInvoice)
    await getPool().query(
      `INSERT INTO public.deadlines (company_id, user_id, title, due_date, customer_id)
       VALUES ($1, $2, 'Avtal', '2026-12-01', $3)`,
      [companyId, userId, onDeadline],
    )
    const runId = await insertRun({
      companyId,
      userId,
      kind: 'customers',
      createdIds: [unused, onInvoice, onDeadline, removedByHand],
    })

    const result = await runAsServiceRole((client) => undoAs(client, companyId, runId, userId))

    expect(result.deleted).toBe(1)
    expect(result.kept).toEqual([
      { id: onDeadline, name: 'Kund med datum', reason: 'referenced', referenced_by: ['deadlines'] },
      { id: onInvoice, name: 'Kund med faktura', reason: 'referenced', referenced_by: ['invoices'] },
    ])
    expect(await exists('customers', unused)).toBe(false)
    expect(await exists('customers', onInvoice)).toBe(true)
    expect(await exists('customers', onDeadline)).toBe(true)
    expect(await exists('customers', preExisting)).toBe(true)
    // The SET NULL key never fired: the invoice keeps its buyer.
    const { rows: inv } = await getPool().query(`SELECT customer_id FROM public.invoices WHERE id = $1`, [invoiceId])
    expect(inv[0].customer_id).toBe(onInvoice)

    const { rows: run } = await getPool().query(
      `SELECT undone_at IS NOT NULL AS undone, undone_by, undo_result FROM public.register_import_runs WHERE id = $1`,
      [runId],
    )
    expect(run[0]).toEqual({ undone: true, undone_by: userId, undo_result: result })

    const { rows: audit } = await getPool().query(
      `SELECT action, table_name, actor_id, new_state FROM public.audit_log WHERE record_id = $1`,
      [runId],
    )
    expect(audit).toEqual([
      { action: 'DELETE', table_name: 'customers', actor_id: userId, new_state: { deleted: 1, kept: 2 } },
    ])
  })

  it('logs an undo that kept every row as an update of the run, not a delete', async () => {
    const { userId, companyId } = await seedCompany()
    const used = await insertRow('customers', companyId, userId, 'Kund med faktura')
    await insertInvoice(companyId, userId, used)
    const runId = await insertRun({ companyId, userId, kind: 'customers', createdIds: [used] })

    const result = await runAsServiceRole((client) => undoAs(client, companyId, runId, userId))

    expect(result.deleted).toBe(0)
    const { rows: audit } = await getPool().query(
      `SELECT action, table_name, new_state FROM public.audit_log WHERE record_id = $1`,
      [runId],
    )
    expect(audit).toEqual([
      { action: 'UPDATE', table_name: 'register_import_runs', new_state: { deleted: 0, kept: 1 } },
    ])
  })

  it('keeps an article on an invoice row and a supplier matched in the inbox', async () => {
    const { userId, companyId } = await seedCompany()
    const usedArticle = await insertRow('articles', companyId, userId, 'Konsulttimme')
    const freeArticle = await insertRow('articles', companyId, userId, 'Skruv')
    const invoiceId = await insertInvoice(companyId, userId, null)
    await getPool().query(
      `INSERT INTO public.invoice_items (invoice_id, description, article_id) VALUES ($1, 'Konsulttimme', $2)`,
      [invoiceId, usedArticle],
    )
    const usedSupplier = await insertRow('suppliers', companyId, userId, 'Leverantör i inkorgen')
    const freeSupplier = await insertRow('suppliers', companyId, userId, 'Ny leverantör')
    await getPool().query(
      `INSERT INTO public.invoice_inbox_items (company_id, user_id, matched_supplier_id) VALUES ($1, $2, $3)`,
      [companyId, userId, usedSupplier],
    )
    const articleRun = await insertRun({ companyId, userId, kind: 'articles', createdIds: [usedArticle, freeArticle] })
    const supplierRun = await insertRun({ companyId, userId, kind: 'suppliers', createdIds: [usedSupplier, freeSupplier] })

    const articles = await runAsServiceRole((client) => undoAs(client, companyId, articleRun, userId))
    const suppliers = await runAsServiceRole((client) => undoAs(client, companyId, supplierRun, userId))

    expect(articles.deleted).toBe(1)
    expect(articles.kept.map((k) => [k.id, k.referenced_by])).toEqual([[usedArticle, ['invoice_items']]])
    expect(suppliers.deleted).toBe(1)
    expect(suppliers.kept.map((k) => [k.id, k.referenced_by])).toEqual([[usedSupplier, ['invoice_inbox_items']]])
    expect(await exists('articles', freeArticle)).toBe(false)
    expect(await exists('suppliers', freeSupplier)).toBe(false)
  })

  it('runs on a member session too, pinned to auth.uid()', async () => {
    const { userId, companyId } = await seedCompany()
    const member = await insertAuthUser()
    await insertCompanyMember({ companyId, userId: member, role: 'member' })
    const row = await insertRow('customers', companyId, userId, 'Kund')
    const runId = await insertRun({ companyId, userId, kind: 'customers', createdIds: [row] })

    const result = await withUserContext(member, async (client) => {
      const r = await undoAs(client, companyId, runId)
      const { rows } = await client.query(`SELECT undone_by FROM public.register_import_runs WHERE id = $1`, [runId])
      return { r, undoneBy: rows[0].undone_by }
    })

    expect(result.r.deleted).toBe(1)
    expect(result.undoneBy).toBe(member)
  })

  it('refuses a viewer, a non-member, and a session naming someone else as actor', async () => {
    const { userId, companyId } = await seedCompany()
    const viewer = await insertAuthUser()
    await insertCompanyMember({ companyId, userId: viewer, role: 'viewer' })
    const outsider = await insertAuthUser()
    const runId = await insertRun({ companyId, userId, kind: 'customers', createdIds: [] })

    expect(await errcode(() => runAsServiceRole((c) => undoAs(c, companyId, runId, viewer)))).toBe('42501')
    expect(await errcode(() => runAsServiceRole((c) => undoAs(c, companyId, runId, outsider)))).toBe('42501')
    expect(await errcode(() => runAsServiceRole((c) => undoAs(c, companyId, runId)))).toBe('42501')
    // p_user_id is ignored on a session: the viewer cannot borrow the owner.
    expect(await errcode(() => withUserContext(viewer, (c) => undoAs(c, companyId, runId, userId)))).toBe('42501')
  })

  it('refuses a writer of an archived company, also on a direct RPC call', async () => {
    const { userId, companyId } = await seedCompany()
    const row = await insertRow('customers', companyId, userId, 'Kund')
    const runId = await insertRun({ companyId, userId, kind: 'customers', createdIds: [row] })
    await getPool().query(`UPDATE public.companies SET archived_at = now() WHERE id = $1`, [companyId])

    expect(await errcode(() => withUserContext(userId, (c) => undoAs(c, companyId, runId)))).toBe('42501')
    expect(await errcode(() => runAsServiceRole((c) => undoAs(c, companyId, runId, userId)))).toBe('42501')
    expect(await exists('customers', row)).toBe(true)
  })

  it('refuses a second undo and a run of another company', async () => {
    const a = await seedCompany()
    const b = await seedCompany()
    const runId = await insertRun({ companyId: a.companyId, userId: a.userId, kind: 'articles', createdIds: [] })

    await runAsServiceRole((c) => undoAs(c, a.companyId, runId, a.userId))

    expect(await errcode(() => runAsServiceRole((c) => undoAs(c, a.companyId, runId, a.userId)))).toBe('55000')
    expect(await errcode(() => runAsServiceRole((c) => undoAs(c, b.companyId, runId, b.userId)))).toBe('P0002')
  })

  it('is not executable by anon', async () => {
    const { rows } = await getPool().query<{ anon: boolean; auth: boolean }>(
      `SELECT has_function_privilege('anon', 'public.undo_register_import(uuid,uuid,uuid)', 'EXECUTE') AS anon,
              has_function_privilege('authenticated', 'public.undo_register_import(uuid,uuid,uuid)', 'EXECUTE') AS auth`,
    )
    expect(rows[0]).toEqual({ anon: false, auth: true })
  })
})
