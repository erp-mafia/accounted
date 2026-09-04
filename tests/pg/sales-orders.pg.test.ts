import { randomUUID } from 'node:crypto'
import { describe, it, expect } from 'vitest'
import { getClient, getPool, withUserContext } from './setup'
import { seedCompany, insertAuthUser, insertCompanyMember } from './fixtures'

// pg-real coverage for the kundorder migration (20260902130000): the
// generate_sales_order_number RPC (atomic, idempotent, membership-gated),
// RLS isolation on both tables, the derived invoiced-quantity RPC, the
// over-invoice BEFORE trigger on invoice_items (incl. release on
// cancel/credit and the cross-company refusal), the quantity floor on
// order lines, the delivered-within-ordered CHECK, and the completion
// triggers that flip confirmed <-> completed from the derived quantity.

async function seedSettings(companyId: string, userId: string): Promise<void> {
  await getPool().query(
    `INSERT INTO public.company_settings (user_id, company_id) VALUES ($1, $2)
     ON CONFLICT (company_id) DO NOTHING`,
    [userId, companyId],
  )
}

async function insertCustomer(companyId: string, userId: string): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.customers (id, user_id, company_id, name, customer_type)
     VALUES ($1, $2, $3, 'Testbrand AB', 'swedish_business')`,
    [id, userId, companyId],
  )
  return id
}

async function insertOrder(
  companyId: string,
  userId: string,
  customerId: string,
  status: 'draft' | 'confirmed' | 'completed' | 'cancelled' = 'confirmed',
): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.sales_orders (id, company_id, user_id, customer_id, status, order_date)
     VALUES ($1, $2, $3, $4, $5, '2026-09-01')`,
    [id, companyId, userId, customerId, status],
  )
  return id
}

async function insertOrderItem(
  companyId: string,
  orderId: string,
  quantity: number,
  overrides: { lineType?: 'product' | 'text'; sortOrder?: number } = {},
): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.sales_order_items
       (id, company_id, sales_order_id, sort_order, line_type, description, quantity, unit, unit_price, vat_rate, line_total)
     VALUES ($1, $2, $3, $4, $5, 'Konsulttimmar', $6, 'tim', 1000, 25, $7)`,
    [id, companyId, orderId, overrides.sortOrder ?? 0, overrides.lineType ?? 'product', quantity, quantity * 1000],
  )
  return id
}

async function insertInvoice(
  companyId: string,
  userId: string,
  customerId: string,
  overrides: { status?: string; salesOrderId?: string | null; creditedInvoiceId?: string | null } = {},
): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.invoices
       (id, user_id, company_id, customer_id, invoice_number, document_type,
        invoice_date, due_date, currency, subtotal, vat_amount, total,
        vat_treatment, vat_rate, moms_ruta, status, sales_order_id, credited_invoice_id)
     VALUES ($1, $2, $3, $4, NULL, 'invoice',
             '2026-09-01', '2026-10-01', 'SEK', 1000, 250, 1250,
             'standard_25', 25, '10', $5, $6, $7)`,
    [id, userId, companyId, customerId, overrides.status ?? 'draft', overrides.salesOrderId ?? null, overrides.creditedInvoiceId ?? null],
  )
  return id
}

async function insertInvoiceItem(
  invoiceId: string,
  quantity: number,
  salesOrderItemId: string | null,
): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.invoice_items
       (id, invoice_id, sort_order, description, quantity, unit, unit_price, line_total, vat_rate, vat_amount, sales_order_item_id)
     VALUES ($1, $2, 0, 'Konsulttimmar', $3, 'tim', 1000, $4, 25, $5, $6)`,
    [id, invoiceId, quantity, quantity * 1000, quantity * 250, salesOrderItemId],
  )
  return id
}

async function orderStatus(orderId: string): Promise<{ status: string; completed_at: string | null }> {
  const { rows } = await getPool().query<{ status: string; completed_at: string | null }>(
    `SELECT status, completed_at FROM public.sales_orders WHERE id = $1`,
    [orderId],
  )
  return rows[0]!
}

async function invoicedQty(orderId: string, itemId: string): Promise<number> {
  const { rows } = await getPool().query<{ invoiced_qty: string }>(
    `SELECT invoiced_qty FROM public.sales_order_invoiced_quantities(ARRAY[$1::uuid])
      WHERE sales_order_item_id = $2`,
    [orderId, itemId],
  )
  return Number(rows[0]?.invoiced_qty ?? 0)
}

async function seedOrderWithLine(quantity = 10) {
  const { userId, companyId } = await seedCompany()
  await seedSettings(companyId, userId)
  const customerId = await insertCustomer(companyId, userId)
  const orderId = await insertOrder(companyId, userId, customerId, 'confirmed')
  const itemId = await insertOrderItem(companyId, orderId, quantity)
  return { userId, companyId, customerId, orderId, itemId }
}

describe('generate_sales_order_number RPC', () => {
  it('assigns OR-<n> sequentially, is idempotent, and advances the counter once per order', async () => {
    const { userId, companyId } = await seedCompany()
    await seedSettings(companyId, userId)
    const customerId = await insertCustomer(companyId, userId)
    const o1 = await insertOrder(companyId, userId, customerId, 'draft')
    const o2 = await insertOrder(companyId, userId, customerId, 'draft')

    const first = await getPool().query<{ n: string }>(
      `SELECT public.generate_sales_order_number($1, $2) AS n`,
      [companyId, o1],
    )
    expect(first.rows[0]!.n).toBe('OR-1')
    const again = await getPool().query<{ n: string }>(
      `SELECT public.generate_sales_order_number($1, $2) AS n`,
      [companyId, o1],
    )
    expect(again.rows[0]!.n).toBe('OR-1')
    const second = await getPool().query<{ n: string }>(
      `SELECT public.generate_sales_order_number($1, $2) AS n`,
      [companyId, o2],
    )
    expect(second.rows[0]!.n).toBe('OR-2')

    const settings = await getPool().query<{ next_sales_order_number: number }>(
      `SELECT next_sales_order_number FROM public.company_settings WHERE company_id = $1`,
      [companyId],
    )
    expect(settings.rows[0]!.next_sales_order_number).toBe(3)
  })

  it('refuses a signed-in caller who is not a member of the company', async () => {
    const { userId, companyId } = await seedCompany()
    await seedSettings(companyId, userId)
    const customerId = await insertCustomer(companyId, userId)
    const orderId = await insertOrder(companyId, userId, customerId, 'draft')
    const outsider = await seedCompany()

    await expect(
      withUserContext(outsider.userId, (client) =>
        client.query('SELECT public.generate_sales_order_number($1, $2)', [companyId, orderId]),
      ),
    ).rejects.toThrow(/unauthorized/i)

    const { rows } = await getPool().query<{ order_number: string | null }>(
      `SELECT order_number FROM public.sales_orders WHERE id = $1`,
      [orderId],
    )
    expect(rows[0]!.order_number).toBeNull()
  })

  it('refuses an anon-shaped caller (role claim, no sub)', async () => {
    const { userId, companyId } = await seedCompany()
    await seedSettings(companyId, userId)
    const customerId = await insertCustomer(companyId, userId)
    const orderId = await insertOrder(companyId, userId, customerId, 'draft')

    const client = await getClient()
    try {
      await client.query('BEGIN')
      await client.query(`SELECT set_config('request.jwt.claims', '{"role":"anon"}', true)`)
      await client.query(`SELECT set_config('request.jwt.claim.role', 'anon', true)`)
      await expect(
        client.query('SELECT public.generate_sales_order_number($1, $2)', [companyId, orderId]),
      ).rejects.toThrow(/unauthorized/i)
    } finally {
      await client.query('ROLLBACK').catch(() => {})
      client.release()
    }
  })
})

describe('sales_orders RLS', () => {
  it('isolates orders and lines by company', async () => {
    const { userId, companyId, orderId, itemId } = await seedOrderWithLine()
    const stranger = await insertAuthUser()

    const own = await withUserContext(userId, async (client) => {
      const orders = await client.query(`SELECT id FROM public.sales_orders WHERE id = $1`, [orderId])
      const items = await client.query(`SELECT id FROM public.sales_order_items WHERE id = $1`, [itemId])
      return { orders: orders.rows.length, items: items.rows.length }
    })
    expect(own).toEqual({ orders: 1, items: 1 })

    const other = await withUserContext(stranger, async (client) => {
      const orders = await client.query(`SELECT id FROM public.sales_orders WHERE id = $1`, [orderId])
      const items = await client.query(`SELECT id FROM public.sales_order_items WHERE id = $1`, [itemId])
      return { orders: orders.rows.length, items: items.rows.length }
    })
    expect(other).toEqual({ orders: 0, items: 0 })

    // A member can read the RPC; a stranger sees nothing through it.
    const strangerRpc = await withUserContext(stranger, (client) =>
      client.query(`SELECT * FROM public.sales_order_invoiced_quantities(ARRAY[$1::uuid])`, [orderId]),
    )
    expect(strangerRpc.rows).toHaveLength(0)
    expect(companyId).toBeTruthy()
  })
})

describe('over-invoicing guard on invoice_items', () => {
  it('sums linked lines and refuses a line that would exceed the ordered quantity', async () => {
    const { userId, companyId, customerId, orderId, itemId } = await seedOrderWithLine(10)
    const invA = await insertInvoice(companyId, userId, customerId, { salesOrderId: orderId })
    await insertInvoiceItem(invA, 6, itemId)
    expect(await invoicedQty(orderId, itemId)).toBe(6)

    const invB = await insertInvoice(companyId, userId, customerId, { salesOrderId: orderId })
    await expect(insertInvoiceItem(invB, 5, itemId)).rejects.toThrow(/SALES_ORDER_OVER_INVOICED/)
    await insertInvoiceItem(invB, 4, itemId)
    expect(await invoicedQty(orderId, itemId)).toBe(10)
  })

  it('releases the quantity when the invoice is cancelled or credited', async () => {
    const { userId, companyId, customerId, orderId, itemId } = await seedOrderWithLine(10)
    const invA = await insertInvoice(companyId, userId, customerId, { salesOrderId: orderId })
    await insertInvoiceItem(invA, 10, itemId)

    const invB = await insertInvoice(companyId, userId, customerId, { salesOrderId: orderId })
    await expect(insertInvoiceItem(invB, 1, itemId)).rejects.toThrow(/SALES_ORDER_OVER_INVOICED/)

    await getPool().query(`UPDATE public.invoices SET status = 'cancelled' WHERE id = $1`, [invA])
    expect(await invoicedQty(orderId, itemId)).toBe(0)
    await insertInvoiceItem(invB, 10, itemId)
    expect(await invoicedQty(orderId, itemId)).toBe(10)

    // A credited invoice is by definition numbered (invoices_sent_requires_number).
    await getPool().query(
      `UPDATE public.invoices SET invoice_number = $2, status = 'credited' WHERE id = $1`,
      [invB, `F-${invB.slice(0, 8)}`],
    )
    expect(await invoicedQty(orderId, itemId)).toBe(0)
  })

  it('refuses linking an invoice line to another company\'s order line', async () => {
    const victim = await seedOrderWithLine(10)
    const attacker = await seedCompany()
    await seedSettings(attacker.companyId, attacker.userId)
    const attackerCustomer = await insertCustomer(attacker.companyId, attacker.userId)
    const inv = await insertInvoice(attacker.companyId, attacker.userId, attackerCustomer)
    await expect(insertInvoiceItem(inv, 1, victim.itemId)).rejects.toThrow(/SALES_ORDER_ITEM_COMPANY_MISMATCH/)
  })

  it('refuses a dangling order line reference', async () => {
    const { userId, companyId, customerId } = await seedOrderWithLine(1)
    const inv = await insertInvoice(companyId, userId, customerId)
    await expect(insertInvoiceItem(inv, 1, randomUUID())).rejects.toThrow()
  })
})

describe('order line guards', () => {
  it('refuses lowering quantity below the invoiced quantity', async () => {
    const { userId, companyId, customerId, orderId, itemId } = await seedOrderWithLine(10)
    const inv = await insertInvoice(companyId, userId, customerId, { salesOrderId: orderId })
    await insertInvoiceItem(inv, 6, itemId)

    await expect(
      getPool().query(`UPDATE public.sales_order_items SET quantity = 5 WHERE id = $1`, [itemId]),
    ).rejects.toThrow(/SALES_ORDER_QUANTITY_BELOW_INVOICED/)
    await getPool().query(`UPDATE public.sales_order_items SET quantity = 6 WHERE id = $1`, [itemId])
    await getPool().query(`UPDATE public.sales_order_items SET quantity = 12 WHERE id = $1`, [itemId])
  })

  it('refuses delivered_qty above quantity', async () => {
    const { itemId } = await seedOrderWithLine(3)
    await expect(
      getPool().query(`UPDATE public.sales_order_items SET delivered_qty = 4 WHERE id = $1`, [itemId]),
    ).rejects.toThrow(/sales_order_items_delivered_within_ordered/)
    await getPool().query(`UPDATE public.sales_order_items SET delivered_qty = 3 WHERE id = $1`, [itemId])
  })

  it('refuses deleting an order line with linked invoice lines', async () => {
    const { userId, companyId, customerId, orderId, itemId } = await seedOrderWithLine(2)
    const inv = await insertInvoice(companyId, userId, customerId, { salesOrderId: orderId })
    await insertInvoiceItem(inv, 1, itemId)
    await expect(
      getPool().query(`DELETE FROM public.sales_order_items WHERE id = $1`, [itemId]),
    ).rejects.toThrow(/foreign key|violates/i)
    await expect(
      getPool().query(`DELETE FROM public.sales_orders WHERE id = $1`, [orderId]),
    ).rejects.toThrow(/foreign key|violates/i)
  })
})

describe('completion maintenance', () => {
  it('flips confirmed -> completed when every product line is fully invoiced, and back on cancel', async () => {
    const { userId, companyId, customerId, orderId, itemId } = await seedOrderWithLine(10)
    await insertOrderItem(companyId, orderId, 0, { lineType: 'text', sortOrder: 1 })
    const second = await insertOrderItem(companyId, orderId, 2, { sortOrder: 2 })

    const inv = await insertInvoice(companyId, userId, customerId, { salesOrderId: orderId })
    await insertInvoiceItem(inv, 10, itemId)
    expect((await orderStatus(orderId)).status).toBe('confirmed')

    await insertInvoiceItem(inv, 2, second)
    const done = await orderStatus(orderId)
    expect(done.status).toBe('completed')
    expect(done.completed_at).not.toBeNull()

    await getPool().query(`UPDATE public.invoices SET status = 'cancelled' WHERE id = $1`, [inv])
    const reopened = await orderStatus(orderId)
    expect(reopened.status).toBe('confirmed')
    expect(reopened.completed_at).toBeNull()
  })

  it('reopens when a draft invoice created from the order is deleted', async () => {
    const { userId, companyId, customerId, orderId, itemId } = await seedOrderWithLine(4)
    const inv = await insertInvoice(companyId, userId, customerId, { salesOrderId: orderId })
    await insertInvoiceItem(inv, 4, itemId)
    expect((await orderStatus(orderId)).status).toBe('completed')

    await getPool().query(`DELETE FROM public.invoice_items WHERE invoice_id = $1`, [inv])
    await getPool().query(`DELETE FROM public.invoices WHERE id = $1`, [inv])
    expect((await orderStatus(orderId)).status).toBe('confirmed')
  })

  it('never touches draft or cancelled orders', async () => {
    const { userId, companyId } = await seedCompany()
    await seedSettings(companyId, userId)
    const customerId = await insertCustomer(companyId, userId)
    const draft = await insertOrder(companyId, userId, customerId, 'draft')
    const draftItem = await insertOrderItem(companyId, draft, 1)
    const inv = await insertInvoice(companyId, userId, customerId, { salesOrderId: draft })
    await insertInvoiceItem(inv, 1, draftItem)
    expect((await orderStatus(draft)).status).toBe('draft')
  })

  it('completes on confirm-time refresh when lines are already covered, and gates the RPC on membership', async () => {
    const { userId, companyId } = await seedCompany()
    await seedSettings(companyId, userId)
    const customerId = await insertCustomer(companyId, userId)
    const draft = await insertOrder(companyId, userId, customerId, 'draft')
    const item = await insertOrderItem(companyId, draft, 1)
    const inv = await insertInvoice(companyId, userId, customerId, { salesOrderId: draft })
    await insertInvoiceItem(inv, 1, item)
    await getPool().query(`UPDATE public.sales_orders SET status = 'confirmed' WHERE id = $1`, [draft])
    expect((await orderStatus(draft)).status).toBe('confirmed')

    const outsider = await seedCompany()
    await expect(
      withUserContext(outsider.userId, (client) =>
        client.query('SELECT public.refresh_sales_order_completion($1)', [draft]),
      ),
    ).rejects.toThrow(/unauthorized/i)

    // withUserContext rolls back at the end, so read the effect inside it.
    const memberView = await withUserContext(userId, async (client) => {
      await client.query('SELECT public.refresh_sales_order_completion($1)', [draft])
      const res = await client.query<{ status: string }>(
        `SELECT status FROM public.sales_orders WHERE id = $1`,
        [draft],
      )
      return res.rows[0]!.status
    })
    expect(memberView).toBe('completed')
  })
})

describe('sales_order_invoiced_quantities RPC', () => {
  it('returns one row per line with cancelled and credit-note lines excluded', async () => {
    const { userId, companyId, customerId, orderId, itemId } = await seedOrderWithLine(10)
    const second = await insertOrderItem(companyId, orderId, 5, { sortOrder: 1 })
    const invA = await insertInvoice(companyId, userId, customerId, { salesOrderId: orderId })
    await insertInvoiceItem(invA, 3, itemId)
    await insertInvoiceItem(invA, 5, second)
    const invCancelled = await insertInvoice(companyId, userId, customerId, { salesOrderId: orderId, status: 'cancelled' })
    await insertInvoiceItem(invCancelled, 7, itemId)
    const creditNote = await insertInvoice(companyId, userId, customerId, { creditedInvoiceId: invA })
    await insertInvoiceItem(creditNote, -3, itemId)

    const { rows } = await getPool().query<{ sales_order_item_id: string; invoiced_qty: string }>(
      `SELECT sales_order_item_id, invoiced_qty FROM public.sales_order_invoiced_quantities(ARRAY[$1::uuid]) ORDER BY invoiced_qty`,
      [orderId],
    )
    const byItem = new Map(rows.map((r) => [r.sales_order_item_id, Number(r.invoiced_qty)]))
    expect(byItem.get(itemId)).toBe(3)
    expect(byItem.get(second)).toBe(5)
  })
})

describe('hardening (20260902180000)', () => {
  it('refuses an order line whose company differs from its parent order (composite FK)', async () => {
    const victim = await seedOrderWithLine(1)
    const attacker = await seedCompany()
    await expect(
      getPool().query(
        `INSERT INTO public.sales_order_items (company_id, sales_order_id, description, quantity)
         VALUES ($1, $2, 'Smuggled line', 1)`,
        [attacker.companyId, victim.orderId],
      ),
    ).rejects.toThrow(/sales_order_items_order_company_fkey|foreign key/i)
  })

  it('blocks a viewer from writing orders and lines through the session client, and lets a member through', async () => {
    const { userId, companyId, customerId } = await seedOrderWithLine(1)
    const viewer = await insertAuthUser()
    await insertCompanyMember({ companyId, userId: viewer, role: 'viewer' })
    const member = await insertAuthUser()
    await insertCompanyMember({ companyId, userId: member, role: 'member' })

    await expect(
      withUserContext(viewer, (client) =>
        client.query(
          `INSERT INTO public.sales_orders (company_id, user_id, customer_id) VALUES ($1, $2, $3)`,
          [companyId, viewer, customerId],
        ),
      ),
    ).rejects.toThrow(/no write access|row-level security/i)

    const inserted = await withUserContext(member, async (client) => {
      const res = await client.query<{ id: string }>(
        `INSERT INTO public.sales_orders (company_id, user_id, customer_id) VALUES ($1, $2, $3) RETURNING id`,
        [companyId, member, customerId],
      )
      return res.rows[0]!.id
    })
    expect(inserted).toBeTruthy()
    expect(userId).toBeTruthy()
  })

  it('carries the per-line delivery date and the customer VAT snapshot columns', async () => {
    const { orderId, itemId } = await seedOrderWithLine(2)
    await getPool().query(
      `UPDATE public.sales_order_items SET delivered_qty = 1, last_delivery_date = '2026-09-01' WHERE id = $1`,
      [itemId],
    )
    await getPool().query(
      `UPDATE public.sales_orders SET customer_type_snapshot = 'eu_business', customer_vat_validated_snapshot = true WHERE id = $1`,
      [orderId],
    )
    const { rows } = await getPool().query<{ last_delivery_date: string; customer_type_snapshot: string }>(
      `SELECT soi.last_delivery_date::text, so.customer_type_snapshot
         FROM public.sales_order_items soi JOIN public.sales_orders so ON so.id = soi.sales_order_id
        WHERE soi.id = $1`,
      [itemId],
    )
    expect(rows[0]!.last_delivery_date).toBe('2026-09-01')
    expect(rows[0]!.customer_type_snapshot).toBe('eu_business')
    await expect(
      getPool().query(`UPDATE public.sales_orders SET customer_type_snapshot = 'company' WHERE id = $1`, [orderId]),
    ).rejects.toThrow(/check/i)
  })
})
