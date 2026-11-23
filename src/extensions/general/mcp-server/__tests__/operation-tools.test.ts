/**
 * The MCP door of the operation registry (../operation-tools.ts): tools are
 * generated from the operations' Zod inputs, stay out of tools/list unless
 * asked, and a staged write refuses at staging what could never commit.
 */
import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { tools, isDefaultCatalogTool } from '../server'
import { coerceStringifiedScalars, toolInputSchema } from '../operation-tools'
import { toToolError } from '../tool-result'
import { OPERATIONS } from '@/lib/operations/registry'
import { createRowsMockSupabase } from '@/tests/helpers'

describe('toolInputSchema', () => {
  it('is a closed object without the $schema header, uuid regexes or safe-integer bounds', () => {
    const schema = toolInputSchema(
      z.object({ id: z.string().uuid(), n: z.number().int().min(1).optional(), nested: z.object({ a: z.string() }) }),
    )
    expect(schema.$schema).toBeUndefined()
    expect(schema.additionalProperties).toBe(false)
    const properties = schema.properties as Record<string, Record<string, unknown>>
    expect(properties.id).toEqual({ type: 'string', format: 'uuid' })
    expect(properties.n.maximum).toBeUndefined()
    expect(properties.nested.additionalProperties).toBe(false)
    expect(schema.required).toEqual(['id', 'nested'])
  })

  it('names the types of an enum that lists numbers, and leaves a string enum bare', () => {
    // A bare enum is a parameter without a type, which clients send as a
    // string: default_vat_rate 0 arrived as "0" (agent feedback seq 1088767).
    const schema = toolInputSchema(
      z.object({
        rate: z.literal([0, 0.06, 0.12, 0.25, null]).optional(),
        flag: z.literal([0, 1]).optional(),
        box: z.literal(['10', '11', null]).optional(),
      }),
    )
    const properties = schema.properties as Record<string, Record<string, unknown>>
    expect(properties.rate).toEqual({ type: ['number', 'null'], enum: [0, 0.06, 0.12, 0.25, null] })
    expect(properties.flag).toEqual({ type: 'number', enum: [0, 1] })
    expect(properties.box).toEqual({ enum: ['10', '11', null] })
  })
})

describe('coerceStringifiedScalars', () => {
  const schema = toolInputSchema(
    z.object({
      rate: z.literal([0, 0.06, 0.12, 0.25, null]).optional(),
      box: z.literal(['10', '11', null]).optional(),
      count: z.number().int().optional(),
      name: z.string().nullable().optional(),
      code: z.string().optional(),
    }),
  )

  it('reads a numeric string back as a number where the schema takes no string', () => {
    expect(coerceStringifiedScalars(schema, { rate: '0', count: '12' })).toEqual({ rate: 0, count: 12 })
    expect(coerceStringifiedScalars(schema, { rate: '0.0' })).toEqual({ rate: 0 })
    expect(coerceStringifiedScalars(schema, { rate: '0.25' })).toEqual({ rate: 0.25 })
  })

  it('reads "null" back as null where null is allowed and the string "null" is not', () => {
    expect(coerceStringifiedScalars(schema, { rate: 'null', box: 'null' })).toEqual({ rate: null, box: null })
    // A free-text field takes "null" as text.
    expect(coerceStringifiedScalars(schema, { name: 'null' })).toEqual({ name: 'null' })
  })

  it('leaves strings, non-numeric text and already typed values untouched', () => {
    const args = { rate: 0.12, box: '10', code: '0', count: 'twelve', unknown_key: '1' }
    expect(coerceStringifiedScalars(schema, args)).toBe(args)
    expect(coerceStringifiedScalars(schema, { rate: '1e3' })).toEqual({ rate: '1e3' })
  })
})

describe('generated operation tools', () => {
  const generated = OPERATIONS.filter((op) => op.mcp).map((op) => tools.find((t) => t.name === op.mcp!.name))

  it('registers one tool per operation with an MCP binding, and no name twice', () => {
    for (const tool of generated) expect(tool).toBeDefined()
    const names = tools.map((t) => t.name)
    expect(new Set(names).size).toBe(names.length)
  })

  it('keeps generated tools search-only by default (zero tools/list cost)', () => {
    for (const op of OPERATIONS.filter((o) => o.mcp && !o.mcp.visibility)) {
      const tool = tools.find((t) => t.name === op.mcp!.name)!
      expect(isDefaultCatalogTool(tool), op.mcp!.name).toBe(false)
    }
  })

  it('adds the staging arguments to a staged write', () => {
    const tool = tools.find((t) => t.name === 'gnubok_create_dimension')!
    const properties = tool.inputSchema.properties as Record<string, unknown>
    expect(Object.keys(properties)).toEqual(
      expect.arrayContaining(['name', 'sie_dim_no', 'dry_run', 'idempotency_key']),
    )
    expect(tool.inputSchema.additionalProperties).toBe(false)
  })

  it('refuses at staging what the commit would refuse, without staging anything', async () => {
    const tool = tools.find((t) => t.name === 'gnubok_delete_dimension')!
    const inserts: string[] = []
    const chain = (table: string, data: unknown): unknown =>
      new Proxy(
        {},
        {
          get(_t, prop) {
            if (prop === 'then') return (resolve: (v: unknown) => void) => resolve({ data, error: null })
            return (..._args: unknown[]) => {
              if (prop === 'insert') inserts.push(table)
              return chain(table, data)
            }
          },
        },
      )
    const supabase = {
      from: vi.fn((table: string) =>
        chain(table, table === 'dimensions' ? { id: 'd', name: 'Projekt', sie_dim_no: 6, is_system: true } : null),
      ),
      rpc: vi.fn(),
    }
    await expect(
      tool.execute({ dimension_id: '3c1d0000-0000-4000-8000-000000000000' }, 'company-1', 'user-1', supabase as never),
    ).rejects.toMatchObject({ code: 'DIMENSION_SYSTEM_DELETE' })
    expect(inserts).toEqual([])
  })
  // A credit note rests at 'credited' like its original, so its own id passed
  // the uncredit's gate: the preview promised to restore the credit note as an
  // invoice to pay, and the staged proposal could only fail at approval
  // (supplier_invoices_credit_note_not_payable refuses that write).
  it("refuses to stage undoing a credit from the credit note's own id, without staging anything", async () => {
    const tool = tools.find((t) => t.name === 'gnubok_uncredit_supplier_invoice')!
    const original = '5b1e0000-0000-4000-8000-000000000001'
    const creditNote = '5b1e0000-0000-4000-8000-000000000002'
    const writes: { table: string; method: string; row: unknown }[] = []
    const { supabase } = createRowsMockSupabase(
      {
        supplier_invoices: [
          { id: original, company_id: 'company-1', status: 'credited', is_credit_note: false, credited_invoice_id: null, total: 1250, remaining_amount: 0, due_date: '2026-10-31', approved_at: null, registration_journal_entry_id: null, payments: [] },
          { id: creditNote, company_id: 'company-1', status: 'credited', is_credit_note: true, credited_invoice_id: original, total: 1250, remaining_amount: 0, due_date: '2026-11-02', approved_at: null, registration_journal_entry_id: null, payments: [] },
        ],
        pending_operations: [],
      },
      writes,
    )

    const refusal = await tool
      .execute({ supplier_invoice_id: creditNote }, 'company-1', 'user-1', supabase as never)
      .then(
        () => null,
        (err: unknown) => err,
      )

    // Nothing staged: no proposal for an approver that could only fail.
    expect(writes).toEqual([])
    const { error } = toToolError(refusal)
    expect(error).toMatchObject({ code: 'SI_UNCREDIT_CREDIT_NOTE', retryable: false })
    expect(error.details).toMatchObject({ credit_note_id: creditNote, credited_invoice_id: original })
    expect(error.remediation?.tool).toBe('gnubok_uncredit_supplier_invoice')
  })

  it('refuses a sub-dimension whose parent is not in the registry at staging, without staging anything', async () => {
    const tool = tools.find((t) => t.name === 'gnubok_create_dimension')!
    const written: string[] = []
    const chain = (table: string, data: unknown): unknown =>
      new Proxy(
        {},
        {
          get(_t, prop) {
            if (prop === 'then') return (resolve: (v: unknown) => void) => resolve({ data, error: null })
            return (..._args: unknown[]) => {
              if (prop === 'insert' || prop === 'update') written.push(table)
              return chain(table, data)
            }
          },
        },
      )
    const supabase = {
      from: vi.fn((table: string) => chain(table, table === 'dimensions' ? [{ sie_dim_no: 1 }, { sie_dim_no: 6 }] : null)),
      rpc: vi.fn(),
    }
    await expect(
      tool.execute({ name: 'Kampanj', parent_sie_dim_no: 30 }, 'company-1', 'user-1', supabase as never),
    ).rejects.toMatchObject({ code: 'DIMENSION_PARENT_INVALID' })
    expect(written).toEqual([])
    // A dry run is also the staging preview: it never seeds the system dims.
    expect(supabase.rpc).not.toHaveBeenCalled()
  })

  // crm#1982: what an agent reads when it asks for a year in the middle of a
  // hole longer than one räkenskapsår (a year ending 2023-09-30, the next one
  // starting 2026-10-01). The envelope carries no details for this code, so
  // the sentence and the remediation must say the way forward themselves.
  it('refuses a year in the middle of a multi-year gap with where the fill starts, without staging anything', async () => {
    const tool = tools.find((t) => t.name === 'gnubok_create_fiscal_period')!
    const written: string[] = []
    const answers: Record<string, unknown> = {
      fiscal_periods: [
        { id: 'old', period_start: '2022-10-01', period_end: '2023-09-30', is_closed: true },
        { id: 'current', period_start: '2026-10-01', period_end: '2027-09-30', is_closed: false },
      ],
      companies: { entity_type: 'aktiebolag' },
    }
    const chain = (table: string): unknown =>
      new Proxy(
        {},
        {
          get(_t, prop) {
            if (prop === 'then') return (resolve: (v: unknown) => void) => resolve({ data: answers[table] ?? null, error: null })
            return (..._args: unknown[]) => {
              if (prop === 'insert' || prop === 'update') written.push(table)
              return chain(table)
            }
          },
        },
      )
    const supabase = { from: vi.fn((table: string) => chain(table)), rpc: vi.fn() }

    const refusal = await tool
      .execute(
        { name: 'Räkenskapsår 2025/2026', period_start: '2025-10-01', period_end: '2026-09-30' },
        'company-1',
        'user-1',
        supabase as never,
      )
      .then(
        () => null,
        (err: unknown) => err,
      )

    const { error } = toToolError(refusal)
    expect(error).toMatchObject({ code: 'FISCAL_PERIOD_NOT_CONTIGUOUS', retryable: false })
    expect(error.message_sv).toContain('måste börja 2023-10-01')
    expect(error.message_sv).toContain('fylls ett räkenskapsår i taget')
    expect(error.remediation?.description).toContain('one year at a time')
    expect(written).toEqual([])
  })
})
