import { randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import { describe, expect, it } from 'vitest'
import { getClient, getPool, withUserContext } from './setup'
import { seedCompany, insertAuthUser } from './fixtures'

// pg-real coverage for 20260810160748_supplier_payment_batches.sql: RLS
// isolation on both tables, the FK RESTRICT that keeps invoices referenced by
// a payment instruction undeletable, the payee_fields_match CHECK, the
// per-batch invoice uniqueness, item immutability (no UPDATE/DELETE policies),
// and the updated_at trigger.
//
// Also covers 20260827100000_create_supplier_payment_batch_rpc.sql (#1503):
// the atomic create RPC (happy path, in-transaction active-batch recheck,
// header + items rolling back together, FOR UPDATE serialization of two
// concurrent creates, tenant guard and actor pinning, EXECUTE privileges).

async function insertSupplier(companyId: string, userId: string): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.suppliers (id, user_id, company_id, name, bankgiro)
     VALUES ($1, $2, $3, 'Derome Bygg AB', '5050-1055')`,
    [id, userId, companyId],
  )
  return id
}

async function insertSupplierInvoice(
  companyId: string,
  userId: string,
  supplierId: string,
): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.supplier_invoices
       (id, user_id, company_id, supplier_id, arrival_number,
        supplier_invoice_number, invoice_date, due_date,
        subtotal, vat_amount, total, remaining_amount, status)
     VALUES ($1, $2, $3, $4, floor(random() * 1000000)::int,
             $5, '2026-06-23', '2026-07-07',
             590, 147.5, 737.5, 737.5, 'approved')`,
    [id, userId, companyId, supplierId, `CD-${id.slice(0, 8)}`],
  )
  return id
}

async function insertBatch(companyId: string, userId: string): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.supplier_payment_batches
       (id, company_id, user_id, format, total_amount, item_count, msg_id, debtor_snapshot)
     VALUES ($1, $2, $3, 'pain001', 737.5, 1, $4,
             '{"name":"Test AB","org_number":"556677-8899","iban":"SE3550000000054910000003","bic":"ESSESESS"}')`,
    [id, companyId, userId, `ACCOUNTED-5566778899-B${id.slice(0, 8)}`],
  )
  return id
}

async function insertItem(params: {
  batchId: string
  companyId: string
  supplierInvoiceId: string
  payeeType?: string
  payeeBankgiro?: string | null
}): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.supplier_payment_batch_items
       (id, batch_id, company_id, supplier_invoice_id, amount, payment_date,
        payee_type, payee_bankgiro, payee_name, reference_type, reference)
     VALUES ($1, $2, $3, $4, 737.5, '2026-08-15',
             $5, $6, 'Derome Bygg AB', 'invoice_number', 'CD3014794407')`,
    [
      id,
      params.batchId,
      params.companyId,
      params.supplierInvoiceId,
      params.payeeType ?? 'bankgiro',
      params.payeeBankgiro === undefined ? '50501055' : params.payeeBankgiro,
    ],
  )
  return id
}

async function seedBatchWithItem() {
  const ctx = await seedCompany()
  const supplierId = await insertSupplier(ctx.companyId, ctx.userId)
  const invoiceId = await insertSupplierInvoice(ctx.companyId, ctx.userId, supplierId)
  const batchId = await insertBatch(ctx.companyId, ctx.userId)
  const itemId = await insertItem({
    batchId,
    companyId: ctx.companyId,
    supplierInvoiceId: invoiceId,
  })
  return { ...ctx, supplierId, invoiceId, batchId, itemId }
}

describe('supplier_payment_batches RLS', () => {
  it('isolates batches and items to company members', async () => {
    const ctx = await seedBatchWithItem()
    const stranger = await insertAuthUser()

    const ownerBatches = await withUserContext(ctx.userId, (client) =>
      client.query(`SELECT id FROM public.supplier_payment_batches WHERE id = $1`, [ctx.batchId]),
    )
    expect(ownerBatches.rows).toHaveLength(1)

    const strangerBatches = await withUserContext(stranger, (client) =>
      client.query(`SELECT id FROM public.supplier_payment_batches WHERE id = $1`, [ctx.batchId]),
    )
    expect(strangerBatches.rows).toHaveLength(0)

    const ownerItems = await withUserContext(ctx.userId, (client) =>
      client.query(`SELECT id FROM public.supplier_payment_batch_items WHERE id = $1`, [
        ctx.itemId,
      ]),
    )
    expect(ownerItems.rows).toHaveLength(1)

    const strangerItems = await withUserContext(stranger, (client) =>
      client.query(`SELECT id FROM public.supplier_payment_batch_items WHERE id = $1`, [
        ctx.itemId,
      ]),
    )
    expect(strangerItems.rows).toHaveLength(0)
  })

  it('blocks a stranger from inserting into another company', async () => {
    const ctx = await seedBatchWithItem()
    const stranger = await insertAuthUser()

    await expect(
      withUserContext(stranger, (client) =>
        client.query(
          `INSERT INTO public.supplier_payment_batches
             (company_id, user_id, format, total_amount, item_count, msg_id, debtor_snapshot)
           VALUES ($1, $2, 'pain001', 1, 1, 'X', '{}')`,
          [ctx.companyId, stranger],
        ),
      ),
    ).rejects.toThrow(/row-level security/)
  })

  it('lets a member cancel (update) a batch but never update or delete items', async () => {
    const ctx = await seedBatchWithItem()

    const cancel = await withUserContext(ctx.userId, (client) =>
      client.query(
        `UPDATE public.supplier_payment_batches
            SET status = 'cancelled', cancelled_at = now(), cancelled_by = $2
          WHERE id = $1 AND status = 'created'`,
        [ctx.batchId, ctx.userId],
      ),
    )
    expect(cancel.rowCount).toBe(1)

    // Items are immutable snapshots: no UPDATE/DELETE policies exist, so the
    // statements succeed but match zero rows.
    const update = await withUserContext(ctx.userId, (client) =>
      client.query(`UPDATE public.supplier_payment_batch_items SET amount = 1 WHERE id = $1`, [
        ctx.itemId,
      ]),
    )
    expect(update.rowCount).toBe(0)

    const del = await withUserContext(ctx.userId, (client) =>
      client.query(`DELETE FROM public.supplier_payment_batch_items WHERE id = $1`, [ctx.itemId]),
    )
    expect(del.rowCount).toBe(0)
  })
})

describe('supplier_payment_batches constraints', () => {
  it('FK RESTRICT keeps an invoice referenced by a batch item undeletable', async () => {
    const ctx = await seedBatchWithItem()

    await expect(
      getPool().query(`DELETE FROM public.supplier_invoices WHERE id = $1`, [ctx.invoiceId]),
    ).rejects.toThrow(/violates foreign key constraint/)

    // Removing the batch cascades the item away, after which the invoice can go.
    await getPool().query(`DELETE FROM public.supplier_payment_batches WHERE id = $1`, [
      ctx.batchId,
    ])
    await getPool().query(`DELETE FROM public.supplier_invoices WHERE id = $1`, [ctx.invoiceId])
  })

  it('payee_fields_match rejects a payee type without its fields', async () => {
    const ctx = await seedBatchWithItem()
    const otherInvoice = await insertSupplierInvoice(ctx.companyId, ctx.userId, ctx.supplierId)

    await expect(
      insertItem({
        batchId: ctx.batchId,
        companyId: ctx.companyId,
        supplierInvoiceId: otherInvoice,
        payeeType: 'bankgiro',
        payeeBankgiro: null,
      }),
    ).rejects.toThrow(/payee_fields_match/)

    await expect(
      insertItem({
        batchId: ctx.batchId,
        companyId: ctx.companyId,
        supplierInvoiceId: otherInvoice,
        payeeType: 'bank_account',
        payeeBankgiro: null,
      }),
    ).rejects.toThrow(/payee_fields_match/)
  })

  it('rejects the same invoice twice in one batch', async () => {
    const ctx = await seedBatchWithItem()

    await expect(
      insertItem({
        batchId: ctx.batchId,
        companyId: ctx.companyId,
        supplierInvoiceId: ctx.invoiceId,
      }),
    ).rejects.toThrow(/uq_supplier_payment_batch_invoice/)
  })

  it('rejects amounts and counts outside their CHECKs', async () => {
    const ctx = await seedCompany()

    await expect(
      getPool().query(
        `INSERT INTO public.supplier_payment_batches
           (company_id, user_id, format, total_amount, item_count, msg_id, debtor_snapshot)
         VALUES ($1, $2, 'pain001', 0, 1, 'X', '{}')`,
        [ctx.companyId, ctx.userId],
      ),
    ).rejects.toThrow(/total_amount/)

    await expect(
      getPool().query(
        `INSERT INTO public.supplier_payment_batches
           (company_id, user_id, format, total_amount, item_count, msg_id, debtor_snapshot)
         VALUES ($1, $2, 'swish', 1, 1, 'X', '{}')`,
        [ctx.companyId, ctx.userId],
      ),
    ).rejects.toThrow(/format/)
  })

  it('rejects an item whose company differs from its batch or invoice', async () => {
    const ctx = await seedBatchWithItem()
    const other = await seedCompany()
    const otherSupplier = await insertSupplier(other.companyId, other.userId)
    const otherInvoice = await insertSupplierInvoice(other.companyId, other.userId, otherSupplier)

    // Batch in ctx's company, invoice + company_id from the other company:
    // the composite FK on (batch_id, company_id) must refuse the cross-link.
    await expect(
      insertItem({
        batchId: ctx.batchId,
        companyId: other.companyId,
        supplierInvoiceId: otherInvoice,
      }),
    ).rejects.toThrow(/fk_supplier_payment_batch_items_batch/)

    // Invoice from the other company under ctx's company_id: the composite FK
    // on (supplier_invoice_id, company_id) must refuse it too.
    await expect(
      insertItem({
        batchId: ctx.batchId,
        companyId: ctx.companyId,
        supplierInvoiceId: otherInvoice,
      }),
    ).rejects.toThrow(/fk_supplier_payment_batch_items_invoice/)
  })

  it('keeps batches immutable outside lifecycle and download metadata', async () => {
    const ctx = await seedBatchWithItem()

    await expect(
      getPool().query(
        `UPDATE public.supplier_payment_batches SET total_amount = 999 WHERE id = $1`,
        [ctx.batchId],
      ),
    ).rejects.toThrow(/immutable snapshots/)

    await expect(
      getPool().query(
        `UPDATE public.supplier_payment_batches SET msg_id = 'REWRITTEN' WHERE id = $1`,
        [ctx.batchId],
      ),
    ).rejects.toThrow(/immutable snapshots/)

    // Cancellation metadata cannot be written outside the transition.
    await expect(
      getPool().query(
        `UPDATE public.supplier_payment_batches SET cancelled_at = now() WHERE id = $1`,
        [ctx.batchId],
      ),
    ).rejects.toThrow(/cancelled_at may only be set/)

    // The sanctioned transition works, and cannot be reversed. The canceller
    // is deliberately NOT the batch owner: deleting the owner would CASCADE
    // the batch away, and the SET NULL assertion below needs it to survive.
    const cancellerId = await insertAuthUser()
    await getPool().query(
      `UPDATE public.supplier_payment_batches
          SET status = 'cancelled', cancelled_at = now(), cancelled_by = $2 WHERE id = $1`,
      [ctx.batchId, cancellerId],
    )
    await expect(
      getPool().query(
        `UPDATE public.supplier_payment_batches SET status = 'created' WHERE id = $1`,
        [ctx.batchId],
      ),
    ).rejects.toThrow(/created -> cancelled/)

    // Audit data on a cancelled batch cannot be rewritten to another user...
    const otherUser = await insertAuthUser()
    await expect(
      getPool().query(
        `UPDATE public.supplier_payment_batches SET cancelled_by = $2 WHERE id = $1`,
        [ctx.batchId, otherUser],
      ),
    ).rejects.toThrow(/cancelled_by may only be set/)

    // ...but the FK's ON DELETE SET NULL path must stay open: deleting the
    // cancelling user's account nulls the reference through this trigger.
    await getPool().query(`DELETE FROM auth.users WHERE id = $1`, [cancellerId])
    const after = await getPool().query(
      `SELECT cancelled_by FROM public.supplier_payment_batches WHERE id = $1`,
      [ctx.batchId],
    )
    expect(after.rows[0].cancelled_by).toBeNull()
  })

  it('touches updated_at on batch update', async () => {
    const ctx = await seedBatchWithItem()

    const before = await getPool().query(
      `SELECT updated_at FROM public.supplier_payment_batches WHERE id = $1`,
      [ctx.batchId],
    )
    await new Promise((resolve) => setTimeout(resolve, 20))
    await getPool().query(
      `UPDATE public.supplier_payment_batches SET download_count = download_count + 1 WHERE id = $1`,
      [ctx.batchId],
    )
    const after = await getPool().query(
      `SELECT updated_at FROM public.supplier_payment_batches WHERE id = $1`,
      [ctx.batchId],
    )
    expect(new Date(after.rows[0].updated_at).getTime()).toBeGreaterThan(
      new Date(before.rows[0].updated_at).getTime(),
    )
  })
})

// ---------------------------------------------------------------------------
// create_supplier_payment_batch RPC (#1503)
// ---------------------------------------------------------------------------

type RpcResult =
  | { ok: true; batch: Record<string, unknown> }
  | { ok: false; code: string; details?: unknown }

function itemsPayload(invoiceId: string, overrides: Record<string, unknown> = {}) {
  return [
    {
      supplier_invoice_id: invoiceId,
      amount: 737.5,
      payment_date: '2099-08-20',
      payee_type: 'bankgiro',
      payee_bankgiro: '50501055',
      payee_plusgiro: null,
      payee_clearing: null,
      payee_account: null,
      payee_name: 'Derome Bygg AB',
      payee_city: null,
      reference_type: 'invoice_number',
      reference: 'CD3014794407',
      ...overrides,
    },
  ]
}

const DEBTOR = {
  name: 'Test AB',
  org_number: '556677-8899',
  iban: 'SE3550000000054910000003',
  bic: 'ESSESESS',
  bankgiro: null,
  city: null,
}

async function callRpc(
  client: PoolClient,
  params: {
    companyId: string
    batchId: string
    items: unknown[]
    confirm?: boolean
    userId?: string | null
  },
): Promise<RpcResult> {
  const { rows } = await client.query<{ result: RpcResult }>(
    `SELECT public.create_supplier_payment_batch(
       $1, $2, 'pain001', $3, $4::jsonb, $5::jsonb, $6, $7
     ) AS result`,
    [
      params.companyId,
      params.batchId,
      `ACCOUNTED-5566778899-B${params.batchId.replace(/-/g, '').slice(0, 8).toUpperCase()}`,
      JSON.stringify(DEBTOR),
      JSON.stringify(params.items),
      params.confirm ?? false,
      params.userId ?? null,
    ],
  )
  return rows[0].result
}

async function seedInvoiceOnly() {
  const ctx = await seedCompany()
  const supplierId = await insertSupplier(ctx.companyId, ctx.userId)
  const invoiceId = await insertSupplierInvoice(ctx.companyId, ctx.userId, supplierId)
  return { ...ctx, supplierId, invoiceId }
}

async function countBatches(client: PoolClient | null, batchId: string): Promise<number> {
  const runner = client ?? getPool()
  const { rows } = await runner.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM public.supplier_payment_batches WHERE id = $1`,
    [batchId],
  )
  return Number(rows[0].n)
}

async function countItems(client: PoolClient | null, batchId: string): Promise<number> {
  const runner = client ?? getPool()
  const { rows } = await runner.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM public.supplier_payment_batch_items WHERE batch_id = $1`,
    [batchId],
  )
  return Number(rows[0].n)
}

describe('create_supplier_payment_batch RPC', () => {
  it('creates header + items for an authenticated member and returns the batch row', async () => {
    const ctx = await seedInvoiceOnly()
    const batchId = randomUUID()

    const { result, items } = await withUserContext(ctx.userId, async (client) => {
      const result = await callRpc(client, {
        companyId: ctx.companyId,
        batchId,
        items: itemsPayload(ctx.invoiceId),
      })
      // withUserContext rolls back, so the row count is asserted inside.
      const items = await countItems(client, batchId)
      return { result, items }
    })

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.batch.id).toBe(batchId)
    expect(result.batch.company_id).toBe(ctx.companyId)
    expect(result.batch.user_id).toBe(ctx.userId)
    expect(result.batch.status).toBe('created')
    expect(result.batch.format).toBe('pain001')
    expect(result.batch.currency).toBe('SEK')
    expect(result.batch.item_count).toBe(1)
    expect(Number(result.batch.total_amount)).toBe(737.5)
    expect(result.batch.msg_id).toBe(
      `ACCOUNTED-5566778899-B${batchId.replace(/-/g, '').slice(0, 8).toUpperCase()}`,
    )
    expect(result.batch.debtor_snapshot).toEqual(DEBTOR)
    expect(typeof result.batch.created_at).toBe('string')
    expect(items).toBe(1)
  })

  it('rechecks active batches inside the transaction and honors the confirmation', async () => {
    // seedBatchWithItem leaves an active ('created') batch on invoiceId.
    const ctx = await seedBatchWithItem()
    const batchId = randomUUID()

    const refused = await withUserContext(ctx.userId, (client) =>
      callRpc(client, { companyId: ctx.companyId, batchId, items: itemsPayload(ctx.invoiceId) }),
    )
    expect(refused).toEqual({
      ok: false,
      code: 'already_batched',
      details: [{ id: ctx.invoiceId, batch_id: ctx.batchId }],
    })
    expect(await countBatches(null, batchId)).toBe(0)

    const confirmed = await withUserContext(ctx.userId, (client) =>
      callRpc(client, {
        companyId: ctx.companyId,
        batchId,
        items: itemsPayload(ctx.invoiceId),
        confirm: true,
      }),
    )
    expect(confirmed.ok).toBe(true)
  })

  it('refuses under the lock when the invoice is no longer payable or the amount exceeds remaining', async () => {
    const ctx = await seedInvoiceOnly()

    await getPool().query(`UPDATE public.supplier_invoices SET status = 'paid' WHERE id = $1`, [
      ctx.invoiceId,
    ])
    const notPayable = await withUserContext(ctx.userId, (client) =>
      callRpc(client, {
        companyId: ctx.companyId,
        batchId: randomUUID(),
        items: itemsPayload(ctx.invoiceId),
      }),
    )
    expect(notPayable).toEqual({
      ok: false,
      code: 'ineligible',
      details: [{ id: ctx.invoiceId, reason: 'not_payable' }],
    })

    await getPool().query(
      `UPDATE public.supplier_invoices SET status = 'approved', remaining_amount = 100 WHERE id = $1`,
      [ctx.invoiceId],
    )
    const excessive = await withUserContext(ctx.userId, (client) =>
      callRpc(client, {
        companyId: ctx.companyId,
        batchId: randomUUID(),
        items: itemsPayload(ctx.invoiceId),
      }),
    )
    expect(excessive).toEqual({
      ok: false,
      code: 'amount_exceeds_remaining',
      details: [{ id: ctx.invoiceId }],
    })

    const ghost = await withUserContext(ctx.userId, (client) =>
      callRpc(client, {
        companyId: ctx.companyId,
        batchId: randomUUID(),
        items: itemsPayload(randomUUID()),
      }),
    )
    expect(ghost.ok).toBe(false)
    if (ghost.ok) throw new Error('unreachable')
    expect(ghost.code).toBe('ineligible')
    expect(ghost.details).toEqual([expect.objectContaining({ reason: 'not_found' })])
  })

  it('rolls the header back with the items on a constraint violation (no empty created batch)', async () => {
    const ctx = await seedInvoiceOnly()
    const batchId = randomUUID()

    // Plain pool: superuser, no JWT claims, so the guard is bypassed and
    // p_user_id supplies the actor. The item violates payee_fields_match.
    await expect(
      callRpc(getPool() as unknown as PoolClient, {
        companyId: ctx.companyId,
        batchId,
        items: itemsPayload(ctx.invoiceId, { payee_bankgiro: null }),
        userId: ctx.userId,
      }),
    ).rejects.toThrow(/payee_fields_match/)

    expect(await countBatches(null, batchId)).toBe(0)
    expect(await countItems(null, batchId)).toBe(0)
  })

  it('serializes two concurrent creates on the same invoice: the loser gets already_batched', async () => {
    const ctx = await seedInvoiceOnly()
    const batchIdA = randomUUID()
    const batchIdB = randomUUID()
    const clientA = await getClient()
    const clientB = await getClient()
    try {
      await clientA.query('BEGIN')
      const resultA = await callRpc(clientA, {
        companyId: ctx.companyId,
        batchId: batchIdA,
        items: itemsPayload(ctx.invoiceId),
        userId: ctx.userId,
      })
      expect(resultA.ok).toBe(true)

      // B starts while A holds the FOR UPDATE lock on the invoice: it must
      // block rather than pass the app-side-style check and land a second
      // active batch.
      await clientB.query('BEGIN')
      const pendingB = callRpc(clientB, {
        companyId: ctx.companyId,
        batchId: batchIdB,
        items: itemsPayload(ctx.invoiceId),
        userId: ctx.userId,
      })
      let settled = false
      void pendingB.then(
        () => {
          settled = true
        },
        () => {
          settled = true
        },
      )
      await new Promise((resolve) => setTimeout(resolve, 150))
      expect(settled).toBe(false)

      await clientA.query('COMMIT')

      const resultB = await pendingB
      expect(resultB).toEqual({
        ok: false,
        code: 'already_batched',
        details: [{ id: ctx.invoiceId, batch_id: batchIdA }],
      })
      await clientB.query('ROLLBACK')
      expect(await countBatches(null, batchIdB)).toBe(0)

      // With explicit consent a second active batch is allowed.
      const confirmed = await callRpc(getPool() as unknown as PoolClient, {
        companyId: ctx.companyId,
        batchId: randomUUID(),
        items: itemsPayload(ctx.invoiceId),
        confirm: true,
        userId: ctx.userId,
      })
      expect(confirmed.ok).toBe(true)
    } finally {
      await clientA.query('ROLLBACK').catch(() => {})
      await clientB.query('ROLLBACK').catch(() => {})
      clientA.release()
      clientB.release()
    }
  })

  it('raises 42501 for a non-member and pins the actor to auth.uid() for JWT callers', async () => {
    const ctx = await seedInvoiceOnly()
    const stranger = await insertAuthUser()

    let guardError: { code?: string } | null = null
    try {
      await withUserContext(stranger, (client) =>
        callRpc(client, {
          companyId: ctx.companyId,
          batchId: randomUUID(),
          items: itemsPayload(ctx.invoiceId),
        }),
      )
    } catch (err) {
      guardError = err as { code?: string }
    }
    expect(guardError?.code).toBe('42501')

    // An authenticated owner passing p_user_id = stranger still owns the batch.
    const spoofed = await withUserContext(ctx.userId, (client) =>
      callRpc(client, {
        companyId: ctx.companyId,
        batchId: randomUUID(),
        items: itemsPayload(ctx.invoiceId),
        userId: stranger,
      }),
    )
    expect(spoofed.ok).toBe(true)
    if (!spoofed.ok) throw new Error('unreachable')
    expect(spoofed.batch.user_id).toBe(ctx.userId)
  })

  it('is executable by authenticated and service_role but not anon', async () => {
    const sig = 'public.create_supplier_payment_batch(uuid,uuid,text,text,jsonb,jsonb,boolean,uuid)'
    const { rows } = await getPool().query<{
      anon_can: boolean
      authenticated_can: boolean
      service_role_can: boolean
    }>(
      `SELECT has_function_privilege('anon', $1, 'EXECUTE') AS anon_can,
              has_function_privilege('authenticated', $1, 'EXECUTE') AS authenticated_can,
              has_function_privilege('service_role', $1, 'EXECUTE') AS service_role_can`,
      [sig],
    )
    expect(rows[0]).toEqual({ anon_can: false, authenticated_can: true, service_role_can: true })
  })
})
