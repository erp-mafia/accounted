/**
 * The MCP door of the operation registry (../operation-tools.ts): tools are
 * generated from the operations' Zod inputs, stay out of tools/list unless
 * asked, and a staged write refuses at staging what could never commit.
 */
import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { tools, isDefaultCatalogTool } from '../server'
import { toolInputSchema } from '../operation-tools'
import { OPERATIONS } from '@/lib/operations/registry'

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
})
