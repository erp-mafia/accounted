import { describe, expect, it, vi } from 'vitest'
import {
  addCompanyToNextHint,
  addCompanyToTopLevelNext,
  assertMcpCompanyWriteAccess,
  extractRequestedCompany,
  isCompanyDependentTool,
  projectToolInputSchema,
  resolveMcpCompanyContext,
} from '../company-routing'

const DEFAULT_COMPANY_ID = '11111111-1111-4111-8111-111111111111'
const OTHER_COMPANY_ID = '22222222-2222-4222-8222-222222222222'

function membershipClient(result: { data: unknown; error: unknown }) {
  const chain: Record<string, ReturnType<typeof vi.fn>> = {
    select: vi.fn(() => chain),
    eq: vi.fn(() => chain),
    is: vi.fn(() => chain),
    maybeSingle: vi.fn().mockResolvedValue(result),
  }
  return {
    client: { from: vi.fn(() => chain) },
    chain,
  }
}

describe('MCP company routing', () => {
  it('projects company_id onto company-dependent tool schemas without mutating the source', () => {
    const inputSchema = {
      type: 'object',
      additionalProperties: false,
      properties: { invoice_id: { type: 'string' } },
      required: ['invoice_id'],
    }

    const projected = projectToolInputSchema({ name: 'gnubok_send_invoice', inputSchema })

    expect(projected).not.toBe(inputSchema)
    expect(projected.properties).toEqual({
      invoice_id: { type: 'string' },
      company_id: expect.objectContaining({ type: 'string', format: 'uuid' }),
    })
    expect(inputSchema.properties).not.toHaveProperty('company_id')
    expect(projected.additionalProperties).toBe(false)
  })

  it.each(['gnubok_search_tools', 'gnubok_load_skill', 'gnubok_list_companies'])(
    'keeps the company-independent schema unchanged for %s',
    (name) => {
      const inputSchema = {
        type: 'object',
        additionalProperties: false,
        properties: {},
      }

      expect(isCompanyDependentTool(name)).toBe(false)
      expect(projectToolInputSchema({ name, inputSchema })).toBe(inputSchema)
    }
  )

  it('extracts and strips a valid company_id before tool execution', () => {
    expect(
      extractRequestedCompany({ company_id: OTHER_COMPANY_ID, invoice_id: 'invoice-1' })
    ).toEqual({
      requestedCompanyId: OTHER_COMPANY_ID,
      toolArgs: { invoice_id: 'invoice-1' },
    })
  })

  it('rejects a malformed company_id', () => {
    expect(() => extractRequestedCompany({ company_id: 'not-a-uuid' })).toThrow(
      expect.objectContaining({ code: 'VALIDATION_ERROR' })
    )
  })

  it('checks membership and resolves the requested company role', async () => {
    const { client, chain } = membershipClient({
      data: { company_id: OTHER_COMPANY_ID, role: 'admin' },
      error: null,
    })

    await expect(
      resolveMcpCompanyContext({
        supabase: client as never,
        userId: 'user-1',
        defaultCompanyId: DEFAULT_COMPANY_ID,
        requestedCompanyId: OTHER_COMPANY_ID,
      })
    ).resolves.toEqual({
      companyId: OTHER_COMPANY_ID,
      role: 'admin',
      isDefault: false,
    })
    expect(chain.eq).toHaveBeenCalledWith('user_id', 'user-1')
    expect(chain.eq).toHaveBeenCalledWith('company_id', OTHER_COMPANY_ID)
    expect(chain.is).toHaveBeenCalledWith('companies.archived_at', null)
  })

  it('checks the API key default company when company_id is omitted', async () => {
    const { client, chain } = membershipClient({
      data: { company_id: DEFAULT_COMPANY_ID, role: 'owner' },
      error: null,
    })

    await expect(
      resolveMcpCompanyContext({
        supabase: client as never,
        userId: 'user-1',
        defaultCompanyId: DEFAULT_COMPANY_ID,
      })
    ).resolves.toEqual({
      companyId: DEFAULT_COMPANY_ID,
      role: 'owner',
      isDefault: true,
    })
    expect(chain.eq).toHaveBeenCalledWith('company_id', DEFAULT_COMPANY_ID)
  })

  it('refuses company-dependent calls on a key whose user has no company yet', async () => {
    // A key minted from the OAuth popup before onboarding (issue #1814) has
    // no default company. The refusal is a distinct, actionable code and
    // never reaches the membership lookup.
    const { client, chain } = membershipClient({ data: null, error: null })

    await expect(
      resolveMcpCompanyContext({
        supabase: client as never,
        userId: 'user-1',
        defaultCompanyId: null,
      })
    ).rejects.toMatchObject({ code: 'NO_COMPANY_YET' })
    expect(chain.maybeSingle).not.toHaveBeenCalled()
  })

  it('rejects companies without a current non-archived membership', async () => {
    const { client } = membershipClient({ data: null, error: null })

    await expect(
      resolveMcpCompanyContext({
        supabase: client as never,
        userId: 'user-1',
        defaultCompanyId: DEFAULT_COMPANY_ID,
        requestedCompanyId: OTHER_COMPANY_ID,
      })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('fails closed when the membership lookup fails', async () => {
    const { client } = membershipClient({
      data: null,
      error: { message: 'database unavailable' },
    })

    await expect(
      resolveMcpCompanyContext({
        supabase: client as never,
        userId: 'user-1',
        defaultCompanyId: DEFAULT_COMPANY_ID,
      })
    ).rejects.toMatchObject({ code: 'INTERNAL_ERROR' })
  })

  it('allows viewer reads but rejects viewer writes, approvals, and management', () => {
    const context = { companyId: OTHER_COMPANY_ID, role: 'viewer' as const, isDefault: false }

    expect(() => assertMcpCompanyWriteAccess(context, 'reports:read')).not.toThrow()
    expect(() => assertMcpCompanyWriteAccess(context, undefined)).not.toThrow()
    expect(() => assertMcpCompanyWriteAccess(context, 'invoices:write')).toThrow(
      expect.objectContaining({ code: 'FORBIDDEN' })
    )
    expect(() => assertMcpCompanyWriteAccess(context, 'pending_operations:approve')).toThrow(
      expect.objectContaining({ code: 'FORBIDDEN' })
    )
    expect(() => assertMcpCompanyWriteAccess(context, 'webhooks:manage')).toThrow(
      expect.objectContaining({ code: 'FORBIDDEN' })
    )
  })

  it('keeps company context in follow-up tool hints', () => {
    const next = {
      tool: 'gnubok_approve_pending_operation',
      description: 'Approve the operation',
      args: { operation_id: 'operation-1' },
    }

    expect(addCompanyToNextHint(next, OTHER_COMPANY_ID)).toEqual({
      ...next,
      args: { operation_id: 'operation-1', company_id: OTHER_COMPANY_ID },
    })
    expect(addCompanyToTopLevelNext({ data: {}, next }, OTHER_COMPANY_ID)).toEqual({
      data: {},
      next: {
        ...next,
        args: { operation_id: 'operation-1', company_id: OTHER_COMPANY_ID },
      },
    })
  })
})
