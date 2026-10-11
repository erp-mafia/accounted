/**
 * An agent must be able to read back what it, or the UI, wrote (crm#1061).
 *
 * A customer's invoicing requirements were written to its notes with
 * gnubok_update_customer, and then no MCP tool returned them:
 * gnubok_list_customers is a summary and the drill-in to one customer did
 * not exist. The supplier and employee readers lagged their writers the
 * same way. Each reader kept its own column list, so nothing tied it to the
 * fields the writers accept.
 *
 * Guard: every field a party writer accepts (the shared v1/dashboard Zod
 * schemas and the MCP write tools) comes back from that party's MCP reader.
 * A masked identifier counts as read back under `<field>_masked`, and a
 * grouped reader (gnubok_get_employee) under `<group>_<leaf>`.
 */
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createQueuedMockSupabase } from '@/tests/helpers'
import {
  CreateCustomerSchema,
  CreateSupplierSchema,
  UpdateCustomerSchema,
  UpdateEmployeeSchema,
  UpdateSupplierSchema,
} from '@/lib/api/schemas'
import { CUSTOMER_RECORD_COLUMNS, CustomerRecordSchema } from '@/lib/customers/customer-record'
import { SUPPLIER_RECORD_COLUMNS, SupplierRecordSchema } from '@/lib/suppliers/supplier-record'
import { encryptPersonnummer } from '@/lib/salary/personnummer'
import { tools } from '../server'

const tool = (name: string) => {
  const found = tools.find((candidate) => candidate.name === name)
  if (!found) throw new Error(`${name} is not registered`)
  return found
}

const COMPANY_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const CUSTOMER_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const SUPPLIER_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const EMPLOYEE_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
// Synthetic personnummer, never a real one.
const PERSONAL_NUMBER = '19900101-1234'

/** Arguments that steer a write tool rather than name a field. */
const CONTROL_ARGS = new Set(['dry_run', 'idempotency_key'])

/** The keys of an object schema, through any transform wrapped around it. */
function schemaKeys(schema: unknown): string[] {
  let node = schema
  while (node && !(node instanceof z.ZodObject)) node = (node as { in?: unknown }).in
  if (!(node instanceof z.ZodObject)) throw new Error('not an object schema')
  return Object.keys(node.shape)
}

function toolArgKeys(name: string, omit: string[] = []): string[] {
  const properties = (tool(name).inputSchema as { properties: Record<string, unknown> }).properties
  return Object.keys(properties).filter((key) => !CONTROL_ARGS.has(key) && !omit.includes(key))
}

/**
 * The field names a reader's output answers: its keys, and for a nested
 * group both the leaf and `<group>_<leaf>` (vaxa_stod.eligible answers
 * vaxa_stod_eligible).
 */
function readableNames(output: Record<string, unknown>): Set<string> {
  const names = new Set<string>()
  for (const [key, value] of Object.entries(output)) {
    names.add(key)
    if (value && typeof value === 'object' && !Array.isArray(value) && key !== 'default_dimensions') {
      for (const leaf of Object.keys(value)) {
        names.add(leaf)
        names.add(`${key}_${leaf}`)
      }
    }
  }
  return names
}

function unreadable(writerKeys: string[], output: Record<string, unknown>): string[] {
  const names = readableNames(output)
  return [...new Set(writerKeys)].filter((key) => !names.has(key) && !names.has(`${key}_masked`)).sort()
}

/** A stored row with every column of the record set, so absence means "not selected". */
function rowFor(columns: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const row = Object.fromEntries(columns.split(', ').map((column) => [column, `v:${column}`]))
  return { ...row, ...overrides }
}

describe('the shared party records', () => {
  it('select exactly the fields their schemas document, in order', () => {
    expect(CUSTOMER_RECORD_COLUMNS.split(', ')).toEqual(Object.keys(CustomerRecordSchema.shape))
    expect(SUPPLIER_RECORD_COLUMNS.split(', ')).toEqual(Object.keys(SupplierRecordSchema.shape))
  })
})

describe('party readers return every field their writers accept', () => {
  it('gnubok_get_customer covers the customer writers (web, v1, MCP create and update)', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: rowFor(CUSTOMER_RECORD_COLUMNS, { id: CUSTOMER_ID, personal_number: null }) })
    const output = (await tool('gnubok_get_customer').execute(
      { customer_id: CUSTOMER_ID }, COMPANY_ID, 'user-1', supabase as never,
    )) as Record<string, unknown>

    // gnubok_create_customer names two fields its own way.
    const createAliases: Record<string, string> = { address: 'address_line1', payment_terms: 'default_payment_terms' }
    const writerKeys = [
      ...schemaKeys(CreateCustomerSchema),
      ...schemaKeys(UpdateCustomerSchema),
      ...toolArgKeys('gnubok_create_customer').map((key) => createAliases[key] ?? key),
      ...toolArgKeys('gnubok_update_customer', ['customer_id']),
    ]
    expect(unreadable(writerKeys, output)).toEqual([])
  })

  it('gnubok_get_supplier covers the supplier writers (web, v1, MCP create)', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: rowFor(SUPPLIER_RECORD_COLUMNS, { id: SUPPLIER_ID }) })
    const output = (await tool('gnubok_get_supplier').execute(
      { supplier_id: SUPPLIER_ID }, COMPANY_ID, 'user-1', supabase as never,
    )) as Record<string, unknown>

    const writerKeys = [
      ...schemaKeys(CreateSupplierSchema),
      ...schemaKeys(UpdateSupplierSchema),
      ...toolArgKeys('gnubok_create_supplier'),
    ]
    expect(unreadable(writerKeys, output)).toEqual([])
  })

  it('gnubok_get_employee covers the employee writers (web, v1, MCP update)', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    const columns = schemaKeys(UpdateEmployeeSchema)
    enqueue({
      data: {
        ...Object.fromEntries(columns.map((column) => [column, `v:${column}`])),
        id: EMPLOYEE_ID,
        personnummer: encryptPersonnummer('190001010000'),
        default_dimensions: {},
      },
    })
    const output = (await tool('gnubok_get_employee').execute(
      { employee_id: EMPLOYEE_ID }, COMPANY_ID, 'user-1', supabase as never, { type: 'api_key' },
    )) as Record<string, unknown>

    const writerKeys = [
      ...schemaKeys(UpdateEmployeeSchema),
      ...toolArgKeys('gnubok_update_employee', ['employee_id']),
    ]
    expect(unreadable(writerKeys, output)).toEqual([])
    expect(output.contact).toEqual({
      email: 'v:email',
      phone: 'v:phone',
      address_line1: 'v:address_line1',
      postal_code: 'v:postal_code',
      city: 'v:city',
    })
  })
})

describe('gnubok_get_customer', () => {
  it('returns the full record under a qualified id, notes included, personnummer masked', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({
      data: {
        ...rowFor(CUSTOMER_RECORD_COLUMNS),
        id: CUSTOMER_ID,
        customer_type: 'individual',
        notes: 'E-faktura krävs. Märk med projektnummer.',
        language: 'en',
        vat_number_validated: false,
        personal_number: encryptPersonnummer(PERSONAL_NUMBER),
      },
    })
    const result = (await tool('gnubok_get_customer').execute(
      { customer_id: CUSTOMER_ID }, COMPANY_ID, 'user-1', supabase as never,
    )) as Record<string, unknown>

    expect(result).toMatchObject({
      customer_id: CUSTOMER_ID,
      notes: 'E-faktura krävs. Märk med projektnummer.',
      language: 'en',
      vat_number_validated: false,
      personal_number_masked: '********-1234',
    })
    expect(result).not.toHaveProperty('id')
    expect(result).not.toHaveProperty('personal_number')
    // Neither the plaintext nor the ciphertext leaves the tool.
    expect(JSON.stringify(result)).not.toContain(PERSONAL_NUMBER)
  })

  it('reads one row of the active company by the shared projection', async () => {
    const { supabase, enqueue, findCall, findCalls } = createQueuedMockSupabase()
    enqueue({ data: rowFor(CUSTOMER_RECORD_COLUMNS, { id: CUSTOMER_ID, personal_number: null }) })
    await tool('gnubok_get_customer').execute({ customer_id: CUSTOMER_ID }, COMPANY_ID, 'user-1', supabase as never)

    expect(findCall('customers', 'select')).toEqual([CUSTOMER_RECORD_COLUMNS])
    expect(findCalls('customers', 'eq')).toEqual(expect.arrayContaining([['company_id', COMPANY_ID], ['id', CUSTOMER_ID]]))
  })

  it('answers CUSTOMER_NOT_FOUND naming the list tool when no customer has that id', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: null })
    await expect(
      tool('gnubok_get_customer').execute({ customer_id: CUSTOMER_ID }, COMPANY_ID, 'user-1', supabase as never),
    ).rejects.toMatchObject({ code: 'CUSTOMER_NOT_FOUND', remediation: { tool: 'gnubok_list_customers' } })
  })

  it('refuses an id that is not a UUID before touching the database', async () => {
    const { supabase } = createQueuedMockSupabase()
    await expect(
      tool('gnubok_get_customer').execute({ customer_id: 'Acme AB' }, COMPANY_ID, 'user-1', supabase as never),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
    expect(supabase.from).not.toHaveBeenCalled()
  })

  it('is a search-only read gated by customers:read', async () => {
    const getCustomer = tool('gnubok_get_customer')
    expect(getCustomer.catalogVisibility).toBe('search')
    expect(getCustomer.annotations?.readOnlyHint).toBe(true)
    expect(Object.keys((getCustomer.outputSchema as { properties: object }).properties)).toEqual(
      expect.arrayContaining(['customer_id', 'notes', 'language', 'vat_number_validated', 'personal_number_masked']),
    )
    expect(Object.keys(CustomerRecordSchema.shape)).toContain('language')
  })
})

describe('gnubok_get_supplier', () => {
  it('returns the full record under a qualified id, notes and bank details included', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({
      data: {
        ...rowFor(SUPPLIER_RECORD_COLUMNS),
        id: SUPPLIER_ID,
        notes: 'Betalas alltid via bankgiro.',
        clearing_number: '8327',
        account_number: '9123456',
      },
    })
    const result = (await tool('gnubok_get_supplier').execute(
      { supplier_id: SUPPLIER_ID }, COMPANY_ID, 'user-1', supabase as never,
    )) as Record<string, unknown>

    expect(result).toMatchObject({
      supplier_id: SUPPLIER_ID,
      notes: 'Betalas alltid via bankgiro.',
      clearing_number: '8327',
      account_number: '9123456',
    })
    expect(result).not.toHaveProperty('id')
  })

  it('answers SUPPLIER_NOT_FOUND naming the list tool when no supplier has that id', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: null })
    await expect(
      tool('gnubok_get_supplier').execute({ supplier_id: SUPPLIER_ID }, COMPANY_ID, 'user-1', supabase as never),
    ).rejects.toMatchObject({ code: 'SUPPLIER_NOT_FOUND', remediation: { tool: 'gnubok_list_suppliers' } })
  })

  it('refuses an id that is not a UUID before touching the database', async () => {
    const { supabase } = createQueuedMockSupabase()
    await expect(
      tool('gnubok_get_supplier').execute({ supplier_id: '123' }, COMPANY_ID, 'user-1', supabase as never),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
    expect(supabase.from).not.toHaveBeenCalled()
  })

  it('is a search-only read whose record matches v1', () => {
    const getSupplier = tool('gnubok_get_supplier')
    expect(getSupplier.catalogVisibility).toBe('search')
    expect(Object.keys(SupplierRecordSchema.shape)).toEqual(expect.arrayContaining(['clearing_number', 'account_number', 'notes']))
  })
})
