import { describe, expect, it } from 'vitest'
import {
  HANDLE_RESOURCES,
  normalizeHandleFields,
  normalizeHandlePath,
  normalizeQueryValue,
  parseHandle,
  toHandle,
  typeForField,
  type HandleType,
} from '@/lib/handles'

const JE_ID = '0e9c41d2-a1b0-4c6f-9a3e-5b7d8c9f0a1b'
const INV_ID = '7b3a0000-1111-4222-8333-444455556666'
const JE = 'je_0e9c41d2a1b04c6f9a3e5b7d8c9f0a1b'
const INV = 'inv_7b3a0000111142228333444455556666'

describe('the prefix table (a public contract)', () => {
  it('never renames, reuses or drops a prefix', () => {
    // Agents store handles for years. Adding a row is fine: append it here.
    // Changing or removing one breaks every stored handle of that type.
    expect(Object.fromEntries(HANDLE_RESOURCES.map((r) => [r.type, r.prefix]))).toEqual({
      company: 'cmp',
      journal_entry: 'je',
      invoice: 'inv',
      supplier_invoice: 'sinv',
      customer: 'cus',
      supplier: 'sup',
      transaction: 'txn',
      document: 'doc',
      pending_operation: 'pop',
      fiscal_period: 'fp',
      employee: 'emp',
      salary_run: 'srun',
      article: 'art',
      asset: 'ast',
      dimension: 'dim',
      dimension_value: 'dimv',
      inbox_item: 'inbx',
      expense_claim: 'exp',
      cash_account: 'cash',
      payment_order: 'pmt',
      supplier_payment_batch: 'spb',
      webhook: 'wh',
      webhook_delivery: 'whd',
      operation: 'op',
      service_account: 'svc',
      api_key: 'key',
    })
  })

  it('keeps prefixes, types, path segments and field bases unique and well formed', () => {
    const prefixes = HANDLE_RESOURCES.map((r) => r.prefix)
    expect(new Set(prefixes).size).toBe(prefixes.length)
    for (const p of prefixes) expect(p).toMatch(/^[a-z]{2,5}$/)
    const types = HANDLE_RESOURCES.map((r) => r.type)
    expect(new Set(types).size).toBe(types.length)
    const segments = HANDLE_RESOURCES.flatMap((r) => [...r.segments])
    expect(new Set(segments).size).toBe(segments.length)
    const fields = HANDLE_RESOURCES.flatMap((r) => [...r.fields])
    expect(new Set(fields).size).toBe(fields.length)
  })
})

describe('toHandle / parseHandle', () => {
  it('round-trips every type: the handle spells the UUID, nothing else', () => {
    for (const { type } of HANDLE_RESOURCES) {
      const handle = toHandle(type as HandleType, JE_ID)!
      expect(handle).toMatch(/^[a-z]+_[0-9a-f]{32}$/)
      expect(parseHandle(handle)).toEqual({ type, prefix: handle.split('_')[0], uuid: JE_ID })
    }
  })

  it('formats as <prefix>_<32 lowercase hex> and lowercases an uppercase UUID', () => {
    expect(toHandle('journal_entry', JE_ID)).toBe(JE)
    expect(toHandle('journal_entry', JE_ID.toUpperCase())).toBe(JE)
  })

  it('stamps nothing on an id that is not a UUID', () => {
    expect(toHandle('invoice', 'not-a-uuid')).toBeNull()
    expect(toHandle('invoice', null)).toBeNull()
    expect(toHandle('invoice', 42)).toBeNull()
  })

  it('reads only well-formed handles of a known prefix', () => {
    expect(parseHandle(JE_ID)).toBeNull()
    expect(parseHandle('foo_0e9c41d2a1b04c6f9a3e5b7d8c9f0a1b')).toBeNull()
    expect(parseHandle('je_0E9C41D2A1B04C6F9A3E5B7D8C9F0A1B')).toBeNull()
    expect(parseHandle('JE_0e9c41d2a1b04c6f9a3e5b7d8c9f0a1b')).toBeNull()
    expect(parseHandle('je_0e9c41d2a1b04c6f9a3e5b7d8c9f0a1')).toBeNull()
    expect(parseHandle(` ${JE}`)).toBeNull()
    expect(parseHandle(undefined)).toBeNull()
  })
})

describe('typeForField', () => {
  it.each([
    ['journal_entry_id', 'journal_entry'],
    ['journal_entry_ids', 'journal_entry'],
    ['expected_journal_entry_ids', 'journal_entry'],
    ['registration_journal_entry_id', 'journal_entry'],
    ['invoice_id', 'invoice'],
    ['credited_invoice_id', 'invoice'],
    ['supplier_invoice_id', 'supplier_invoice'],
    ['created_supplier_invoice_id', 'supplier_invoice'],
    ['supplier_id', 'supplier'],
    ['matched_supplier_id', 'supplier'],
    ['customer_id', 'customer'],
    ['transaction_id', 'transaction'],
    ['expected_duplicate_transaction_id', 'transaction'],
    ['document_id', 'document'],
    ['underlag_document_id', 'document'],
    ['fiscal_period_id', 'fiscal_period'],
    ['period_id', 'fiscal_period'],
    ['previous_period_id', 'fiscal_period'],
    ['company_id', 'company'],
    ['pending_operation_id', 'pending_operation'],
    ['dimension_value_id', 'dimension_value'],
    ['dimension_id', 'dimension'],
    ['cash_account_id', 'cash_account'],
    ['target_cash_account_id', 'cash_account'],
    ['employee_id', 'employee'],
    ['value_id', 'dimension_value'],
  ])('%s holds a %s id', (field, type) => {
    expect(typeForField(field)).toBe(type)
  })

  it.each([
    'id',
    'ids',
    'operation_id',
    'connection_id',
    'external_id',
    'external_customer_id',
    'provider_transaction_id',
    'salary_run_employee_id',
    'skattekonto_transaction_id',
    'skattekonto_transaction_ids',
    'journal_entry_line_id',
    'invoice_item_id',
    'description',
    'reference',
  ])('%s is not a typed id field', (field) => {
    expect(typeForField(field)).toBeUndefined()
  })

  it('takes a surface override first', () => {
    expect(typeForField('operation_id', { operation_id: 'pending_operation' })).toBe('pending_operation')
    expect(typeForField('invoice_id', { invoice_id: null })).toBeUndefined()
  })
})

describe('normalizeHandleFields', () => {
  it('returns the very same object when it holds no handle', () => {
    const body = { journal_entry_id: JE_ID, items: [{ invoice_id: INV_ID, amount: 10 }], note: JE }
    const r = normalizeHandleFields(body)
    expect(r).toEqual({ ok: true, value: body, changed: false })
    expect(r.ok && r.value).toBe(body)
  })

  it('replaces handles of the field type with UUIDs, nested and in lists, and leaves the rest', () => {
    const body = {
      journal_entry_id: JE,
      invoice_ids: [INV, INV_ID],
      allocations: [{ invoice_id: INV, amount: 100 }],
      description: `see ${JE}`,
      reference: JE,
    }
    const r = normalizeHandleFields(body)
    expect(r).toEqual({
      ok: true,
      changed: true,
      value: {
        journal_entry_id: JE_ID,
        invoice_ids: [INV_ID, INV_ID],
        allocations: [{ invoice_id: INV_ID, amount: 100 }],
        description: `see ${JE}`,
        reference: JE,
      },
    })
    // The input is not mutated.
    expect(body.journal_entry_id).toBe(JE)
  })

  it('refuses a handle of another type, naming every field at fault', () => {
    const r = normalizeHandleFields({ journal_entry_id: INV, lines: [{ supplier_invoice_id: INV }] })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.mismatches).toEqual([
      expect.objectContaining({
        field: 'journal_entry_id',
        expected_type: 'journal_entry',
        expected_prefix: 'je',
        received_type: 'invoice',
        received_prefix: 'inv',
      }),
      expect.objectContaining({ field: 'lines.0.supplier_invoice_id', expected_prefix: 'sinv', received_prefix: 'inv' }),
    ])
    expect(r.mismatches[0]!.message).toBe(
      'journal_entry_id takes a journal entry id (a je_ handle or a plain UUID); the inv_ handle sent names a customer invoice.',
    )
  })

  it('leaves a handle with an unknown prefix to the field validation it always had', () => {
    const body = { invoice_id: 'zz_7b3a0000111142228333444455556666' }
    expect(normalizeHandleFields(body)).toEqual({ ok: true, value: body, changed: false })
  })
})

describe('normalizeQueryValue', () => {
  it('replaces a handle and a comma list of handles on *_ids', () => {
    expect(normalizeQueryValue('customer_id', 'cus_7b3a0000111142228333444455556666')).toEqual({
      value: INV_ID,
      changed: true,
    })
    expect(normalizeQueryValue('journal_entry_ids', `${JE},${INV_ID}`)).toEqual({
      value: `${JE_ID},${INV_ID}`,
      changed: true,
    })
  })

  it('leaves plain values and untyped keys alone', () => {
    expect(normalizeQueryValue('customer_id', INV_ID)).toEqual({ value: INV_ID, changed: false })
    expect(normalizeQueryValue('q', JE)).toEqual({ value: JE, changed: false })
  })

  it('refuses a wrong-type handle', () => {
    const r = normalizeQueryValue('customer_id', INV)
    expect('mismatches' in r && r.mismatches[0]!.expected_prefix).toBe('cus')
  })
})

describe('normalizeHandlePath', () => {
  const COMPANY = '8fd5b1f4-0000-4000-8000-000000000001'
  const CMP = 'cmp_8fd5b1f4000040008000000000000001'

  it('types each parameter by the collection segment before it', () => {
    expect(normalizeHandlePath(`/api/v1/companies/${CMP}/journal-entries/${JE}/reverse`)).toEqual({
      ok: true,
      changed: true,
      value: `/api/v1/companies/${COMPANY}/journal-entries/${JE_ID}/reverse`,
    })
  })

  it('leaves a path without handles exactly as it was', () => {
    const path = `/api/v1/companies/${COMPANY}/reconciliation/accounts/bank:${JE_ID}/items`
    expect(normalizeHandlePath(path)).toEqual({ ok: true, value: path, changed: false })
  })

  it('refuses a handle of another type in a typed segment', () => {
    const r = normalizeHandlePath(`/api/v1/companies/${COMPANY}/journal-entries/${INV}`)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.mismatches[0]).toMatchObject({ field: 'path.journal-entries', expected_prefix: 'je', received_prefix: 'inv' })
  })

  it('refuses any handle where the parameter takes a plain UUID only', () => {
    const r = normalizeHandlePath(`/api/v1/companies/${COMPANY}/employees/${JE_ID}/benefits/${JE}`)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.mismatches[0]).toMatchObject({ field: 'path.benefits', expected_type: null, expected_prefix: null })
  })
})
