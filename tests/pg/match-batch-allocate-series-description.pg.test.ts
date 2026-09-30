import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { buildBatchAllocationPreview } from '@/lib/invoices/batch-allocation-preview'
import { resolveDefaultSeriesForSource } from '@/lib/bookkeeping/voucher-series-resolver'
import { insertTransaction, seedCompany } from '@/tests/pg/fixtures'
import { getPool, withUserContext } from '@/tests/pg/setup'

/**
 * 20260929015251_match_batch_allocate_series_from_settings (feedback 708521).
 *
 * match_batch_allocate booked every batch in voucher series A and described it
 * "Samlingsbetalning <date>", also for a company whose settings route
 * supplier_invoice_paid to E and for a batch that settled ONE invoice. The
 * single-invoice route books the same payment through the engine
 * (createDraftEntry + resolveDefaultSeriesForSource) as E1 "Utbetalning
 * leverantörsfaktura <number>, <supplier>".
 *
 * Pinned against the real function:
 *   - the series is company_settings.default_voucher_series_per_source_type
 *     for the entry's source_type, answered exactly as resolveDefaultSeriesForSource
 *     answers for the same settings row (A without a row, a key or a valid letter);
 *   - one invoice: the header names it the way the single-invoice routes do;
 *   - two or more: "Samlingsbetalning <date>" / "Samlingsinbetalning <date>",
 *     unchanged;
 *   - the staged preview (buildBatchAllocationPreview) states the same wording,
 *     without the invoice number and counterparty (GDPR Art. 25).
 *
 * Seeding goes through the superuser pool; every RPC call runs in
 * withUserContext, which rolls back, so one seeded transaction can be booked
 * again under different settings.
 */

type Seed = Awaited<ReturnType<typeof seedCompany>>

interface RpcResult {
  ok: boolean
  code?: string
  journal_entry_id?: string
  voucher_series?: string
  voucher_number?: number
}

interface PostedEntry {
  voucher_series: string
  voucher_number: number
  description: string
  source_type: string
}

/** A company_settings row; without `map` the column default (the standard set) applies. */
async function insertSettings(seed: Seed, map?: unknown): Promise<void> {
  if (map === undefined) {
    await getPool().query(
      `INSERT INTO public.company_settings (user_id, company_id) VALUES ($1, $2)`,
      [seed.userId, seed.companyId],
    )
    return
  }
  await getPool().query(
    `INSERT INTO public.company_settings (user_id, company_id, default_voucher_series_per_source_type)
     VALUES ($1, $2, $3::jsonb)
     ON CONFLICT (company_id)
     DO UPDATE SET default_voucher_series_per_source_type = EXCLUDED.default_voucher_series_per_source_type`,
    [seed.userId, seed.companyId, JSON.stringify(map)],
  )
}

async function readSettingsRow(seed: Seed) {
  const { rows } = await getPool().query<{ default_voucher_series_per_source_type: unknown }>(
    `SELECT default_voucher_series_per_source_type FROM public.company_settings WHERE company_id = $1`,
    [seed.companyId],
  )
  return rows[0] ?? null
}

async function insertSupplier(seed: Seed, name: string): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.suppliers (id, user_id, company_id, name, supplier_type, country)
     VALUES ($1, $2, $3, $4, 'swedish_business', 'SE')`,
    [id, seed.userId, seed.companyId, name],
  )
  return id
}

async function insertSupplierInvoice(
  seed: Seed,
  params: { supplierId: string; arrivalNumber: number; number: string; total: number },
): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.supplier_invoices
       (id, user_id, company_id, supplier_id, arrival_number, supplier_invoice_number,
        invoice_date, due_date, received_date, status, currency,
        subtotal, vat_amount, total, paid_amount, remaining_amount,
        vat_treatment, reverse_charge, is_credit_note)
     VALUES ($1, $2, $3, $4, $5, $6, '2026-01-02', '2026-02-01', '2026-01-02', 'approved', 'SEK',
             $7, 0, $7, 0, $7, 'standard_25', false, false)`,
    [id, seed.userId, seed.companyId, params.supplierId, params.arrivalNumber, params.number, params.total],
  )
  return id
}

async function insertCustomer(seed: Seed, name: string): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.customers (id, user_id, company_id, name, customer_type, country)
     VALUES ($1, $2, $3, $4, 'swedish_business', 'SE')`,
    [id, seed.userId, seed.companyId, name],
  )
  return id
}

async function insertCustomerInvoice(
  seed: Seed,
  params: {
    customerId: string | null
    number: string | null
    total: number
    /** Self-billed: no own number, the counterparty's number in external_invoice_number. */
    externalNumber?: string
  },
): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.invoices
       (id, user_id, company_id, customer_id, invoice_number, external_invoice_number, is_self_billed,
        invoice_date, due_date, status, currency, subtotal, vat_amount, total, paid_amount,
        remaining_amount, vat_treatment)
     VALUES ($1, $2, $3, $4, $5, $6, $7, '2026-06-01', '2026-07-01', 'sent', 'SEK', $8, 0, $8, 0, $8,
             'standard_25')`,
    [
      id,
      seed.userId,
      seed.companyId,
      params.customerId,
      params.number,
      params.externalNumber ?? null,
      params.externalNumber !== undefined,
      params.total,
    ],
  )
  return id
}

/** Runs the RPC as the owner and reads the posted header; everything rolls back. */
async function allocate(
  seed: Seed,
  txId: string,
  allocations: Array<Record<string, unknown>>,
): Promise<{ result: RpcResult; entry: PostedEntry }> {
  return withUserContext(seed.userId, async (client) => {
    const r = await client.query<{ result: RpcResult }>(
      `SELECT match_batch_allocate($1, $2::jsonb, $3) AS result`,
      [txId, JSON.stringify(allocations), seed.companyId],
    )
    const result = r.rows[0]!.result
    expect(result).toMatchObject({ ok: true })
    const je = await client.query<PostedEntry>(
      `SELECT voucher_series, voucher_number, description, source_type
         FROM public.journal_entries WHERE id = $1`,
      [result.journal_entry_id],
    )
    return { result, entry: je.rows[0]! }
  })
}

describe('match_batch_allocate: voucher series from company settings', () => {
  it('books a one-invoice supplier batch in the series the settings map supplier_invoice_paid to (E)', async () => {
    // Feedback 708521's shape: the standard set routes supplier payments to E.
    const seed = await seedCompany()
    await insertSettings(seed)
    const supplierId = await insertSupplier(seed, 'Bryggleverantören AB')
    const invoiceId = await insertSupplierInvoice(seed, { supplierId, arrivalNumber: 1, number: '5571', total: 1250 })
    const txId = await insertTransaction({ ...seed, amount: -1250, date: '2026-01-16' })

    const { result, entry } = await allocate(seed, txId, [
      { kind: 'supplier_invoice', supplier_invoice_id: invoiceId, amount: 1250 },
    ])

    expect(result.voucher_series).toBe('E')
    expect(entry).toMatchObject({ voucher_series: 'E', voucher_number: 1, source_type: 'supplier_invoice_paid' })
    // The engine's rule on the same settings row gives the same letter.
    expect(resolveDefaultSeriesForSource(await readSettingsRow(seed) as never, 'supplier_invoice_paid')).toBe('E')
  })

  it('books a one-invoice customer batch in the invoice_paid series (C)', async () => {
    const seed = await seedCompany()
    await insertSettings(seed)
    const customerId = await insertCustomer(seed, 'Kund AB')
    const invoiceId = await insertCustomerInvoice(seed, { customerId, number: '1001', total: 500 })
    const txId = await insertTransaction({ ...seed, amount: 500, date: '2026-06-05' })

    const { result, entry } = await allocate(seed, txId, [
      { kind: 'customer_invoice', invoice_id: invoiceId, amount: 500 },
    ])

    expect(result.voucher_series).toBe('C')
    expect(entry).toMatchObject({ voucher_series: 'C', voucher_number: 1, source_type: 'invoice_paid' })
  })

  it('falls back to A when the company has no settings row', async () => {
    const seed = await seedCompany()
    const supplierId = await insertSupplier(seed, 'Leverantör AB')
    const invoiceId = await insertSupplierInvoice(seed, { supplierId, arrivalNumber: 1, number: 'LF-1', total: 300 })
    const txId = await insertTransaction({ ...seed, amount: -300, date: '2026-06-05' })

    const { result, entry } = await allocate(seed, txId, [
      { kind: 'supplier_invoice', supplier_invoice_id: invoiceId, amount: 300 },
    ])

    expect(await readSettingsRow(seed)).toBeNull()
    expect(result.voucher_series).toBe('A')
    expect(entry.voucher_series).toBe('A')
    expect(resolveDefaultSeriesForSource(null, 'supplier_invoice_paid')).toBe('A')
  })

  it('answers exactly what resolveDefaultSeriesForSource answers for every settings shape', async () => {
    const seed = await seedCompany()
    const supplierId = await insertSupplier(seed, 'Leverantör AB')
    const invoiceId = await insertSupplierInvoice(seed, { supplierId, arrivalNumber: 1, number: 'LF-2', total: 400 })
    const txId = await insertTransaction({ ...seed, amount: -400, date: '2026-06-05' })

    const cases: Array<{ map: unknown; expected: string }> = [
      { map: { supplier_invoice_paid: 'K' }, expected: 'K' },
      { map: {}, expected: 'A' }, // no key
      { map: { invoice_paid: 'C' }, expected: 'A' }, // another source type's key only
      { map: { supplier_invoice_paid: 'e' }, expected: 'A' }, // not uppercase
      { map: { supplier_invoice_paid: 'EE' }, expected: 'A' }, // not one letter
      { map: { supplier_invoice_paid: 'Å' }, expected: 'A' }, // outside A-Z
      { map: { supplier_invoice_paid: 5 }, expected: 'A' }, // not a string
      { map: { supplier_invoice_paid: null }, expected: 'A' },
      { map: null, expected: 'A' }, // JSON null instead of an object
      { map: ['E'], expected: 'A' }, // an array instead of an object
    ]
    for (const { map, expected } of cases) {
      await insertSettings(seed, map)
      const { result, entry } = await allocate(seed, txId, [
        { kind: 'supplier_invoice', supplier_invoice_id: invoiceId, amount: 400 },
      ])
      const engine = resolveDefaultSeriesForSource(
        { default_voucher_series_per_source_type: map } as never,
        'supplier_invoice_paid',
      )
      expect({ map, rpc: result.voucher_series, entry: entry.voucher_series, engine }).toEqual({
        map,
        rpc: expected,
        entry: expected,
        engine: expected,
      })
    }
  })
})

describe('match_batch_allocate: verifikat description', () => {
  it('names the one supplier invoice like the single-invoice route; the preview states the same wording without number and name', async () => {
    const seed = await seedCompany()
    await insertSettings(seed)
    const supplierId = await insertSupplier(seed, 'Bryggleverantören AB')
    const invoiceId = await insertSupplierInvoice(seed, { supplierId, arrivalNumber: 1, number: '5571', total: 1250 })
    const txId = await insertTransaction({ ...seed, amount: -1250, date: '2026-01-16' })
    const allocations = [{ kind: 'supplier_invoice' as const, supplier_invoice_id: invoiceId, amount: 1250 }]

    const { entry } = await allocate(seed, txId, allocations)

    // app/api/transactions/[id]/match-supplier-invoice: `Utbetalning leverantörsfaktura ${number}, ${supplier.name}`
    expect(entry.description).toBe('Utbetalning leverantörsfaktura 5571, Bryggleverantören AB')
    const preview = buildBatchAllocationPreview({
      transaction: { amount: -1250, currency: 'SEK', date: '2026-01-16' },
      bankAccount: '1930',
      allocations,
      invoices: { [invoiceId]: { currency: 'SEK', remaining_amount: 1250, total: 1250 } },
    })
    expect(preview.description).toBe('Utbetalning leverantörsfaktura')
    expect(entry.description).toBe(`${preview.description} 5571, Bryggleverantören AB`)
  })

  it('names the one customer invoice like the single-invoice route', async () => {
    const seed = await seedCompany()
    const customerId = await insertCustomer(seed, 'Kund AB')
    const invoiceId = await insertCustomerInvoice(seed, { customerId, number: '1001', total: 500 })
    const txId = await insertTransaction({ ...seed, amount: 500, date: '2026-06-05' })

    const { entry } = await allocate(seed, txId, [{ kind: 'customer_invoice', invoice_id: invoiceId, amount: 500 }])

    // app/api/transactions/[id]/match-invoice: `Inbetalning kundfaktura ${invoice_number}, ${customer.name}`
    expect(entry.description).toBe('Inbetalning kundfaktura 1001, Kund AB')
  })

  it('uses the displayed number of a self-billed invoice and leaves the name part off without a customer', async () => {
    const seed = await seedCompany()
    const customerId = await insertCustomer(seed, 'Kund AB')
    const selfBilled = await insertCustomerInvoice(seed, { customerId, number: null, externalNumber: 'SJF-77', total: 500 })
    const noCustomer = await insertCustomerInvoice(seed, { customerId: null, number: 'F-9', total: 500 })
    const txId = await insertTransaction({ ...seed, amount: 500, date: '2026-06-05' })

    const selfBilledEntry = await allocate(seed, txId, [
      { kind: 'customer_invoice', invoice_id: selfBilled, amount: 500 },
    ])
    const noCustomerEntry = await allocate(seed, txId, [
      { kind: 'customer_invoice', invoice_id: noCustomer, amount: 500 },
    ])

    // invoiceDisplayNumber (lib/invoices/display.ts): invoice_number ?? external_invoice_number.
    expect(selfBilledEntry.entry.description).toBe('Inbetalning kundfaktura SJF-77, Kund AB')
    expect(noCustomerEntry.entry.description).toBe('Inbetalning kundfaktura F-9')
  })

  it('keeps "Samlingsbetalning <date>" for two supplier invoices, booked in the configured series', async () => {
    const seed = await seedCompany()
    await insertSettings(seed)
    const supplierId = await insertSupplier(seed, 'Leverantör AB')
    const a = await insertSupplierInvoice(seed, { supplierId, arrivalNumber: 1, number: 'LF-10', total: 1000 })
    const b = await insertSupplierInvoice(seed, { supplierId, arrivalNumber: 2, number: 'LF-11', total: 2000 })
    const txId = await insertTransaction({ ...seed, amount: -3000, date: '2026-06-05' })
    const allocations = [
      { kind: 'supplier_invoice' as const, supplier_invoice_id: a, amount: 1000 },
      { kind: 'supplier_invoice' as const, supplier_invoice_id: b, amount: 2000 },
    ]

    const { result, entry } = await allocate(seed, txId, allocations)

    expect(entry.description).toBe('Samlingsbetalning 2026-06-05')
    expect(result.voucher_series).toBe('E')
    const preview = buildBatchAllocationPreview({
      transaction: { amount: -3000, currency: 'SEK', date: '2026-06-05' },
      bankAccount: '1930',
      allocations,
      invoices: {
        [a]: { currency: 'SEK', remaining_amount: 1000, total: 1000 },
        [b]: { currency: 'SEK', remaining_amount: 2000, total: 2000 },
      },
    })
    expect(preview.description).toBe(entry.description)
  })

  it('keeps "Samlingsinbetalning <date>" for two customer invoices', async () => {
    const seed = await seedCompany()
    const customerId = await insertCustomer(seed, 'Kund AB')
    const a = await insertCustomerInvoice(seed, { customerId, number: '2001', total: 700 })
    const b = await insertCustomerInvoice(seed, { customerId, number: '2002', total: 300 })
    const txId = await insertTransaction({ ...seed, amount: 1000, date: '2026-06-05' })

    const { entry } = await allocate(seed, txId, [
      { kind: 'customer_invoice', invoice_id: a, amount: 700 },
      { kind: 'customer_invoice', invoice_id: b, amount: 300 },
    ])

    expect(entry.description).toBe('Samlingsinbetalning 2026-06-05')
  })
})
