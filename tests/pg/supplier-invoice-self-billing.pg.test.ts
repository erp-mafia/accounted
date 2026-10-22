import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { getClient, getPool, withUserContext } from './setup'
import { insertAuthUser, insertCompanyMember, seedCompany } from './fixtures'

// pg-real coverage for 20261022130000_supplier_invoice_self_billing.sql
// (crm#1367): the self-billing series drawn inside the INSERT by
// assign_self_billing_number (sequential, floored at MAX+1, never burnt by a
// failed insert, safe under concurrency, refusing a caller's number), the
// CHECK that ties the self-billing fields together, and
// guard_self_billing_identity (number, agreement and parties fixed; no DELETE
// once the document is archived; ordinary invoices untouched).

interface PgError {
  message?: string
}

const SNAPSHOT = JSON.stringify({ v: 1, seller: { name: 'Crayfish Energy AB' }, buyer: { name: 'Oppy AB' } })

async function seed(settings: { prefix?: string; next?: number } = {}) {
  const { userId, companyId } = await seedCompany()
  await getPool().query(
    `INSERT INTO public.company_settings (user_id, company_id, self_billing_prefix, next_self_billing_number)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (company_id) DO UPDATE
       SET self_billing_prefix = EXCLUDED.self_billing_prefix,
           next_self_billing_number = EXCLUDED.next_self_billing_number`,
    [userId, companyId, settings.prefix ?? 'SF-', settings.next ?? 1],
  )
  const supplierId = randomUUID()
  await getPool().query(
    `INSERT INTO public.suppliers (id, user_id, company_id, name, self_billing_agreement_ref)
     VALUES ($1, $2, $3, 'Crayfish Energy AB', 'Flexavtal 2026')`,
    [supplierId, userId, companyId],
  )
  return { userId, companyId, supplierId }
}

const INSERT_SQL = `INSERT INTO public.supplier_invoices
   (id, user_id, company_id, supplier_id, arrival_number, supplier_invoice_number,
    invoice_date, due_date, subtotal, vat_amount, total, remaining_amount, status,
    is_self_billed, self_billing_agreement_ref, self_billing_snapshot)
 VALUES ($1, $2, $3, $4, floor(random() * 1000000)::int, $5,
         '2026-09-30', '2026-10-30', 1000, 250, 1250, 1250, 'registered',
         $6, $7, $8::jsonb)
 RETURNING id, supplier_invoice_number, self_billing_number`

type Inserted = { id: string; supplier_invoice_number: string | null; self_billing_number: number | null }

function insertArgs(
  s: { userId: string; companyId: string; supplierId: string },
  o: { selfBilled?: boolean; number?: string | null; ref?: string | null; snapshot?: string | null } = {},
): unknown[] {
  const selfBilled = o.selfBilled ?? true
  return [
    randomUUID(),
    s.userId,
    s.companyId,
    s.supplierId,
    o.number === undefined ? (selfBilled ? null : `LF-${randomUUID().slice(0, 8)}`) : o.number,
    selfBilled,
    o.ref === undefined ? (selfBilled ? 'Flexavtal 2026' : null) : o.ref,
    o.snapshot === undefined ? (selfBilled ? SNAPSHOT : null) : o.snapshot,
  ]
}

async function insert(
  s: { userId: string; companyId: string; supplierId: string },
  o: Parameters<typeof insertArgs>[1] = {},
): Promise<Inserted> {
  const { rows } = await getPool().query<Inserted>(INSERT_SQL, insertArgs(s, o))
  return rows[0]
}

async function nextNumber(companyId: string): Promise<number> {
  const { rows } = await getPool().query<{ n: number }>(
    'SELECT next_self_billing_number AS n FROM public.company_settings WHERE company_id = $1',
    [companyId],
  )
  return rows[0].n
}

async function expectRefused(promise: Promise<unknown>, code: RegExp): Promise<void> {
  let error: PgError | null = null
  try {
    await promise
  } catch (err) {
    error = err as PgError
  }
  expect(error?.message ?? '').toMatch(code)
}

async function insertDocument(userId: string, companyId: string): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.document_attachments (id, user_id, company_id, file_name, mime_type, file_size_bytes, storage_path, sha256_hash, upload_source)
     VALUES ($1, $2, $3, 'Självfaktura SF-001.pdf', 'application/pdf', 1024, $4, $5, 'system')`,
    [id, userId, companyId, `documents/${companyId}/${id}.pdf`, randomUUID().replace(/-/g, '').padEnd(64, '0')],
  )
  return id
}

describe('assign_self_billing_number', () => {
  it('numbers self-billing invoices in the company series: SF-001, SF-002', async () => {
    const s = await seed()
    const first = await insert(s)
    const second = await insert(s)
    expect(first).toMatchObject({ supplier_invoice_number: 'SF-001', self_billing_number: 1 })
    expect(second).toMatchObject({ supplier_invoice_number: 'SF-002', self_billing_number: 2 })
    expect(await nextNumber(s.companyId)).toBe(3)
  })

  it('uses the prefix and keeps every digit past 999', async () => {
    const s = await seed({ prefix: 'OPPY-SF-', next: 1234 })
    expect(await insert(s)).toMatchObject({ supplier_invoice_number: 'OPPY-SF-1234', self_billing_number: 1234 })
  })

  it('never reuses a number: a counter set below the highest issued is floored at MAX+1', async () => {
    const s = await seed()
    await insert(s)
    await insert(s)
    await getPool().query('UPDATE public.company_settings SET next_self_billing_number = 1 WHERE company_id = $1', [s.companyId])
    expect(await insert(s)).toMatchObject({ self_billing_number: 3 })
  })

  it('continues from a counter set ahead of the series', async () => {
    const s = await seed({ next: 50 })
    expect(await insert(s)).toMatchObject({ supplier_invoice_number: 'SF-050', self_billing_number: 50 })
  })

  it('burns no number when the insert fails', async () => {
    const s = await seed()
    // No snapshot: the CHECK refuses the row after the trigger drew a number.
    await expectRefused(getPool().query(INSERT_SQL, insertArgs(s, { snapshot: null })), /supplier_invoices_self_billing_fields/)
    expect(await nextNumber(s.companyId)).toBe(1)
    expect(await insert(s)).toMatchObject({ self_billing_number: 1 })
  })

  it('refuses a number the caller supplies', async () => {
    const s = await seed()
    await expectRefused(getPool().query(INSERT_SQL, insertArgs(s, { number: 'SF-999' })), /SI_SELF_BILL_NUMBER_ASSIGNED/)
  })

  it('gives two concurrent inserts distinct numbers', async () => {
    const s = await seed()
    const a = await getClient()
    const b = await getClient()
    try {
      await a.query('BEGIN')
      await b.query('BEGIN')
      const first = await a.query<Inserted>(INSERT_SQL, insertArgs(s))
      // b queues on the settings row until a commits.
      const secondPromise = b.query<Inserted>(INSERT_SQL, insertArgs(s))
      await a.query('COMMIT')
      const second = await secondPromise
      await b.query('COMMIT')
      expect(first.rows[0].self_billing_number).toBe(1)
      expect(second.rows[0].self_billing_number).toBe(2)
    } finally {
      await a.query('ROLLBACK').catch(() => {})
      await b.query('ROLLBACK').catch(() => {})
      a.release()
      b.release()
    }
  })

  it('lets a member who cannot write the settings issue one (the counter moves under the trigger)', async () => {
    const s = await seed()
    const memberId = await insertAuthUser()
    await insertCompanyMember({ companyId: s.companyId, userId: memberId, role: 'member' })
    const number = await withUserContext(memberId, async (client) => {
      const { rows } = await client.query<Inserted>(INSERT_SQL, insertArgs({ ...s, userId: memberId }))
      return rows[0].self_billing_number
    })
    expect(number).toBe(1)
  })

  it('leaves ordinary supplier invoices alone', async () => {
    const s = await seed()
    const ordinary = await insert(s, { selfBilled: false, number: 'LF-1' })
    expect(ordinary).toMatchObject({ supplier_invoice_number: 'LF-1', self_billing_number: null })
    expect(await nextNumber(s.companyId)).toBe(1)
  })
})

describe('supplier_invoices_self_billing_fields', () => {
  it('refuses a self-billing invoice without an agreement, and an agreement on an ordinary one', async () => {
    const s = await seed()
    await expectRefused(getPool().query(INSERT_SQL, insertArgs(s, { ref: null })), /supplier_invoices_self_billing_fields/)
    await expectRefused(getPool().query(INSERT_SQL, insertArgs(s, { ref: '  ' })), /supplier_invoices_self_billing_fields/)
    await expectRefused(
      getPool().query(INSERT_SQL, insertArgs(s, { selfBilled: false, ref: 'Flexavtal 2026' })),
      /supplier_invoices_self_billing_fields/,
    )
  })

  it('refuses a prefix ending in a digit', async () => {
    const s = await seed()
    await expectRefused(
      getPool().query(`UPDATE public.company_settings SET self_billing_prefix = 'SF1' WHERE company_id = $1`, [s.companyId]),
      /company_settings_self_billing_prefix_check/,
    )
  })
})

describe('guard_self_billing_identity', () => {
  it('keeps the number, the agreement and the parties of an issued invoice', async () => {
    const s = await seed()
    const row = await insert(s)
    await expectRefused(
      getPool().query(`UPDATE public.supplier_invoices SET supplier_invoice_number = 'SF-099' WHERE id = $1`, [row.id]),
      /SI_SELF_BILL_IMMUTABLE/,
    )
    await expectRefused(
      getPool().query(`UPDATE public.supplier_invoices SET self_billing_agreement_ref = 'Annat' WHERE id = $1`, [row.id]),
      /SI_SELF_BILL_IMMUTABLE/,
    )
    await expectRefused(
      getPool().query(`UPDATE public.supplier_invoices SET self_billing_snapshot = '{}'::jsonb WHERE id = $1`, [row.id]),
      /SI_SELF_BILL_IMMUTABLE/,
    )
  })

  it('lets the lifecycle move: status, payments and the document link', async () => {
    const s = await seed()
    const row = await insert(s)
    const documentId = await insertDocument(s.userId, s.companyId)
    await getPool().query(
      `UPDATE public.supplier_invoices
          SET status = 'paid', paid_amount = 1250, remaining_amount = 0, document_id = $2
        WHERE id = $1`,
      [row.id, documentId],
    )
    const { rows } = await getPool().query('SELECT status, document_id FROM public.supplier_invoices WHERE id = $1', [row.id])
    expect(rows[0]).toEqual({ status: 'paid', document_id: documentId })
  })

  it('refuses turning an ordinary invoice into a self-billing one', async () => {
    const s = await seed()
    const ordinary = await insert(s, { selfBilled: false, number: 'LF-2' })
    await expectRefused(
      getPool().query(
        `UPDATE public.supplier_invoices
            SET is_self_billed = true, self_billing_number = 1, self_billing_agreement_ref = 'A', self_billing_snapshot = $2::jsonb
          WHERE id = $1`,
        [ordinary.id, SNAPSHOT],
      ),
      /SI_SELF_BILL_IMMUTABLE/,
    )
  })

  it('allows a DELETE before the document exists, never after', async () => {
    const s = await seed()
    const unarchived = await insert(s)
    await getPool().query('DELETE FROM public.supplier_invoices WHERE id = $1', [unarchived.id])

    const archived = await insert(s)
    const documentId = await insertDocument(s.userId, s.companyId)
    await getPool().query('UPDATE public.supplier_invoices SET document_id = $2 WHERE id = $1', [archived.id, documentId])
    await expectRefused(getPool().query('DELETE FROM public.supplier_invoices WHERE id = $1', [archived.id]), /SI_SELF_BILL_IMMUTABLE/)
  })

  it('leaves edits of an ordinary invoice alone', async () => {
    const s = await seed()
    const ordinary = await insert(s, { selfBilled: false, number: 'LF-3' })
    await getPool().query(`UPDATE public.supplier_invoices SET supplier_invoice_number = 'LF-3B' WHERE id = $1`, [ordinary.id])
    await getPool().query('DELETE FROM public.supplier_invoices WHERE id = $1', [ordinary.id])
  })
})
