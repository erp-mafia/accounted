/**
 * The supplier voucher matcher and the link RPC, side by side, against a REAL
 * PostgREST over a real Postgres.
 *
 * Issue #2854 was a disagreement nobody could see: the customer-side RPC and
 * matcher knew kontantmetoden, the supplier-side pair did not, and each copy
 * was green against its own mocks. "Which line of a voucher settles this
 * invoice" now lives once, in supplier_invoice_settlement_side, and this file
 * is the pin that the three things a user or an agent touches give ONE answer:
 *
 *   findMatchingVouchersForSupplierInvoice   what the dialog / MCP tool OFFERS
 *   validateVoucherForSupplierInvoiceLink    what the MCP tool lets you STAGE
 *   link_supplier_invoice_to_voucher (RPC)   what actually COMMITS
 *
 * For every scenario: the validator's verdict (ok, code, amount, side) equals
 * the RPC's, and every voucher the matcher offers is one the RPC accepts.
 *
 * What only this harness can prove: the TypeScript half runs through
 * supabase-js, so the `.rpc()` call, the `.like('19%')` / band filters and the
 * payment-row read are parsed by PostgREST, not answered by a queued mock. The
 * invoice is read with the SAME narrow projection the route and the MCP tools
 * use, which does not contain registration_journal_entry_id: the side must not
 * depend on it.
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { randomUUID } from 'node:crypto'
import { insertPostedJournalEntry, seedCompany, type PostedJournalEntryLine } from '@/tests/pg/fixtures'
import { getPool } from '@/tests/pg/setup'
import { createToolPgClient } from '@/tests/tool-pg/client'
import {
  findMatchingVouchersForSupplierInvoice,
  validateVoucherForSupplierInvoiceLink,
} from '@/lib/invoices/supplier-voucher-matching'
import type { Supplier, SupplierInvoice } from '@/types'

/** The projection app/api/supplier-invoices/[id]/voucher-candidates and both
 *  MCP tools read. Deliberately without registration_journal_entry_id. */
const CALLER_PROJECTION =
  'id, supplier_invoice_number, arrival_number, status, currency, total, paid_amount, remaining_amount, due_date, paid_at, exchange_rate, supplier_id, supplier:suppliers(id, name)'

type Seeded = Awaited<ReturnType<typeof seedCompany>>
let client: ReturnType<typeof createToolPgClient>
let arrivalSeq = 0

beforeAll(() => {
  client = createToolPgClient()
})

async function seedCompanyWithMethod(method: 'cash' | 'accrual'): Promise<Seeded> {
  const company = await seedCompany()
  await getPool().query(
    `INSERT INTO public.company_settings (user_id, company_id, accounting_method) VALUES ($1, $2, $3)`,
    [company.userId, company.companyId, method],
  )
  return company
}

async function seedInvoice(company: Seeded, total: number, registrationEntryId: string | null = null) {
  const supplierId = randomUUID()
  await getPool().query(
    `INSERT INTO public.suppliers
       (id, user_id, company_id, name, supplier_type, country, default_payment_terms, default_currency)
     VALUES ($1, $2, $3, 'Paritet Leverantör AB', 'swedish_business', 'SE', 30, 'SEK')`,
    [supplierId, company.userId, company.companyId],
  )
  const id = randomUUID()
  const arrivalNumber = (Date.now() % 1_000_000) * 1000 + arrivalSeq++
  await getPool().query(
    `INSERT INTO public.supplier_invoices
       (id, user_id, company_id, supplier_id, arrival_number, supplier_invoice_number,
        invoice_date, due_date, received_date, status, currency,
        subtotal, vat_amount, total, paid_amount, remaining_amount,
        vat_treatment, reverse_charge, is_credit_note, registration_journal_entry_id)
     VALUES ($1, $2, $3, $4, $5, $6, '2026-04-01', '2026-05-01', '2026-04-01', 'registered', 'SEK',
             $7, 0, $7, 0, $7, 'standard_25', false, false, $8)`,
    [id, company.userId, company.companyId, supplierId, arrivalNumber, `LF-${arrivalNumber}`, total, registrationEntryId],
  )
  return id
}

const cashLines = (amount: number): PostedJournalEntryLine[] => [
  { accountNumber: '4010', debitAmount: amount * 0.8, creditAmount: 0 },
  { accountNumber: '2641', debitAmount: amount * 0.2, creditAmount: 0 },
  { accountNumber: '1930', debitAmount: 0, creditAmount: amount },
]
const apLines = (amount: number): PostedJournalEntryLine[] => [
  { accountNumber: '2440', debitAmount: amount, creditAmount: 0 },
  { accountNumber: '1930', debitAmount: 0, creditAmount: amount },
]

function seedVoucher(company: Seeded, lines: PostedJournalEntryLine[], sourceType = 'bank_transaction') {
  return insertPostedJournalEntry({
    userId: company.userId,
    companyId: company.companyId,
    fiscalPeriodId: company.fiscalPeriodId,
    voucherNumber: Math.floor(Math.random() * 1_000_000),
    entryDate: '2026-04-28',
    description: 'Betalning Paritet Leverantör AB',
    sourceType,
    lines,
  })
}

interface RpcAnswer {
  ok: boolean
  code?: string
  payment_amount?: number
  settlement_side?: string
}

/**
 * Ask all three, in the order a user meets them, and hold them to one answer.
 * Returns the RPC's answer, and whether the matcher offered the voucher, so a
 * scenario can also assert WHICH answer it was.
 */
async function askAllThree(
  company: Seeded,
  invoiceId: string,
  voucherId: string,
): Promise<RpcAnswer & { offered: boolean }> {
  const { data: invoice, error } = await client
    .from('supplier_invoices')
    .select(CALLER_PROJECTION)
    .eq('id', invoiceId)
    .eq('company_id', company.companyId)
    .single()
  expect(error).toBeNull()
  const asCallerSeesIt = invoice as unknown as SupplierInvoice & { supplier?: Supplier }

  const offered = await findMatchingVouchersForSupplierInvoice(client, company.companyId, asCallerSeesIt)
  const validation = await validateVoucherForSupplierInvoiceLink(
    client,
    company.companyId,
    asCallerSeesIt,
    voucherId,
  )

  const { data, error: rpcError } = await client.rpc('link_supplier_invoice_to_voucher', {
    p_supplier_invoice_id: invoiceId,
    p_journal_entry_id: voucherId,
    p_user_id: company.userId,
    p_company_id: company.companyId,
    p_notes: null,
  })
  expect(rpcError).toBeNull()
  const rpc = data as RpcAnswer

  // Staged == committed.
  expect(validation.ok).toBe(rpc.ok)
  if (validation.ok) {
    expect(validation.paymentAmount).toBe(rpc.payment_amount)
    expect(validation.settlementSide).toBe(rpc.settlement_side)
  } else {
    expect(validation.code).toBe(rpc.code)
  }

  // Offered => committed. (Not the converse: the matcher is a ranked
  // suggestion list and may leave out a voucher the RPC would take.)
  const wasOffered = offered.some((c) => c.journal_entry_id === voucherId)
  if (wasOffered) expect(rpc.ok).toBe(true)
  if (rpc.ok && wasOffered) {
    const candidate = offered.find((c) => c.journal_entry_id === voucherId)!
    expect(candidate.settlement_side).toBe(rpc.settlement_side)
    expect(candidate.ap_debit_amount).toBe(rpc.payment_amount)
  }

  return { ...rpc, offered: wasOffered }
}

describe('supplier voucher link: matcher, validator and RPC give one answer', () => {
  it('kontantmetoden, bank-first verifikat: offered, staged and committed on the 19xx credit', async () => {
    const company = await seedCompanyWithMethod('cash')
    const invoiceId = await seedInvoice(company, 1250)
    const voucherId = await seedVoucher(company, cashLines(1250))

    const answer = await askAllThree(company, invoiceId, voucherId)
    expect(answer).toMatchObject({ ok: true, settlement_side: 'bank_credit', payment_amount: 1250, offered: true })
  })

  it('kontantmetoden: a payout another invoice already used is neither offered nor accepted', async () => {
    const company = await seedCompanyWithMethod('cash')
    const lastMonth = await seedInvoice(company, 1250)
    const thisMonth = await seedInvoice(company, 1250)
    const voucherId = await seedVoucher(company, cashLines(1250))
    expect((await askAllThree(company, lastMonth, voucherId)).ok).toBe(true)

    const answer = await askAllThree(company, thisMonth, voucherId)
    expect(answer).toMatchObject({ ok: false, code: 'LINK_SI_VOUCHER_FULLY_ALLOCATED', offered: false })
  })

  it('kontantmetoden: a payout larger than the remainder, and a verifikat with no 19xx credit', async () => {
    const company = await seedCompanyWithMethod('cash')
    const invoiceId = await seedInvoice(company, 1250)
    const tooLarge = await seedVoucher(company, cashLines(5000))
    const noBank = await seedVoucher(company, [
      { accountNumber: '4010', debitAmount: 1250, creditAmount: 0 },
      { accountNumber: '2893', debitAmount: 0, creditAmount: 1250 },
    ])

    expect((await askAllThree(company, invoiceId, tooLarge)).code).toBe('LINK_SI_VOUCHER_AMOUNT_EXCEEDS_REMAINING')
    expect((await askAllThree(company, invoiceId, noBank)).code).toBe('LINK_SI_VOUCHER_NO_BANK_CREDIT')
  })

  it('kontantmetoden with a registration verifikat: all three stay on the 244x debit', async () => {
    const company = await seedCompanyWithMethod('cash')
    const registration = await seedVoucher(
      company,
      [
        { accountNumber: '4010', debitAmount: 1250, creditAmount: 0 },
        { accountNumber: '2440', debitAmount: 0, creditAmount: 1250 },
      ],
      'supplier_invoice_registered',
    )
    const invoiceId = await seedInvoice(company, 1250, registration)
    const costAgain = await seedVoucher(company, cashLines(1250))
    const payment = await seedVoucher(company, apLines(1250))

    expect((await askAllThree(company, invoiceId, costAgain)).code).toBe('LINK_SI_VOUCHER_NO_AP_DEBIT')
    const answer = await askAllThree(company, invoiceId, payment)
    expect(answer).toMatchObject({ ok: true, settlement_side: 'ap_debit', offered: true })
  })

  it('faktureringsmetoden: unchanged, Dr cost / Cr 1930 is refused and Dr 2440 / Cr 1930 links', async () => {
    const company = await seedCompanyWithMethod('accrual')
    const invoiceId = await seedInvoice(company, 1250)
    const cost = await seedVoucher(company, cashLines(1250))
    const payment = await seedVoucher(company, apLines(1250))

    expect((await askAllThree(company, invoiceId, cost)).code).toBe('LINK_SI_VOUCHER_NO_AP_DEBIT')
    const answer = await askAllThree(company, invoiceId, payment)
    expect(answer).toMatchObject({ ok: true, settlement_side: 'ap_debit', payment_amount: 1250, offered: true })
  })
})
