import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { TOOL_SCOPE_MAP } from '@/lib/auth/api-keys'
import { OPERATION_RISK_TIERS } from '@/lib/pending-operations/risk-tiers'
import { tools } from '../server'

const getTool = () => tools.find((tool) => tool.name === 'gnubok_get_company_settings')!
const updateTool = () => tools.find((tool) => tool.name === 'gnubok_update_company_settings')!

describe('company settings MCP tools: registration', () => {
  it('registers the read and staged write tools with company scopes', () => {
    expect(getTool()).toBeDefined()
    expect(updateTool()).toBeDefined()
    expect(getTool().annotations.readOnlyHint).toBe(true)
    expect(getTool().catalogVisibility).toBe('search')
    expect(updateTool().annotations.readOnlyHint).toBe(false)
    expect(updateTool().catalogVisibility).toBe('search')
    expect(TOOL_SCOPE_MAP.gnubok_get_company_settings).toBe('companies:read')
    expect(TOOL_SCOPE_MAP.gnubok_update_company_settings).toBe('companies:write')
  })

  it('classifies payment-routing changes as medium risk', () => {
    expect(OPERATION_RISK_TIERS.update_company_settings).toBe('medium')
  })

  it('uses strict top-level input schemas', () => {
    expect(getTool().inputSchema.additionalProperties).toBe(false)
    expect(updateTool().inputSchema.additionalProperties).toBe(false)
  })

  it('keeps every field of the original tools, and only the non-legal ones are writable', () => {
    const writeFields = Object.keys(
      (updateTool().inputSchema as { properties: Record<string, unknown> }).properties,
    )
    for (const field of [
      'account_number', 'bank_name', 'bankgiro', 'bic', 'clearing_number', 'contact_person', 'email',
      'iban', 'invoice_email_texts', 'phone', 'plusgiro', 'swish', 'website', 'dry_run', 'idempotency_key',
    ]) {
      expect(writeFields, field).toContain(field)
    }
    for (const field of ['vat_registered', 'accounting_method', 'bookkeeping_locked_through', 'org_number', 'default_our_reference']) {
      expect(writeFields, field).not.toContain(field)
    }
  })

  it('keeps both settings schemas discoverable through tool search', async () => {
    const search = tools.find((tool) => tool.name === 'gnubok_search_tools')!
    const readResult = (await search.execute(
      {
        query: 'get company settings',
        detail: 'full',
        __keyScopes: ['companies:read'],
      },
      'company-1',
      'user-1',
      {} as never,
    )) as { tools: Array<{ name: string; inputSchema?: Record<string, unknown> }> }
    const writeResult = (await search.execute(
      {
        query: 'update company settings',
        detail: 'full',
        __keyScopes: ['companies:write'],
      },
      'company-1',
      'user-1',
      {} as never,
    )) as { tools: Array<{ name: string; inputSchema?: Record<string, unknown> }> }

    expect(readResult.tools).toEqual([
      expect.objectContaining({
        name: 'gnubok_get_company_settings',
        inputSchema: expect.any(Object),
      }),
    ])
    expect(writeResult.tools).toEqual([
      expect.objectContaining({
        name: 'gnubok_update_company_settings',
        inputSchema: expect.any(Object),
      }),
    ])
  })
})

describe('gnubok_get_company_settings', () => {
  it('returns payment details and maps the default reference to contact_person', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({
      data: {
        entity_type: 'aktiebolag',
        bank_name: 'Testbanken',
        clearing_number: '1234',
        account_number: '1234567',
        bankgiro: '5050-1055',
        plusgiro: null,
        swish: '1231231231',
        iban: null,
        bic: null,
        default_our_reference: 'Test Contact',
        moms_period: 'quarterly',
      },
    })

    const result = await getTool().execute({}, 'company-1', 'user-1', supabase as never)

    expect(result).toMatchObject({
      company_id: 'company-1',
      bankgiro: '5050-1055',
      contact_person: 'Test Contact',
      moms_period: 'quarterly',
      // Never set: null, not missing.
      website: null,
    })
    expect(supabase.from).toHaveBeenCalledWith('company_settings')
  })

  it('fails with NOT_FOUND when the company has no settings row', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: null, error: null })

    await expect(
      getTool().execute({}, 'company-1', 'user-1', supabase as never),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})

describe('gnubok_update_company_settings', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  const OWNER = { data: { role: 'owner' } }
  const HAS_DEADLINES = { data: null, count: 5 }

  it('rejects an empty change set before querying the database', async () => {
    const { supabase } = createQueuedMockSupabase()

    await expect(
      updateTool().execute({ dry_run: true }, 'company-1', 'user-1', supabase as never),
    ).rejects.toThrow(/at least one/i)
    expect(supabase.from).not.toHaveBeenCalled()
  })

  it('rejects a Bankgiro number with an invalid check digit', async () => {
    const { supabase } = createQueuedMockSupabase()

    await expect(
      updateTool().execute(
        { bankgiro: '1234567', dry_run: true },
        'company-1',
        'user-1',
        supabase as never,
      ),
    ).rejects.toThrow(/bankgiro/i)
    expect(supabase.from).not.toHaveBeenCalled()
  })

  it('rejects an unknown invoice email placeholder before querying the database', async () => {
    const { supabase } = createQueuedMockSupabase()

    await expect(
      updateTool().execute(
        {
          invoice_email_texts: { sv: { body: 'Betala med OCR {ocr}.' } },
          dry_run: true,
        },
        'company-1',
        'user-1',
        supabase as never,
      ),
    ).rejects.toThrow(/placeholder/i)
    expect(supabase.from).not.toHaveBeenCalled()
  })

  it('refuses to stage for a member who is not owner or admin', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { company_id: 'company-1' } })
    enqueue({ data: { role: 'member' } })

    await expect(
      updateTool().execute({ phone: '08-1' }, 'company-1', 'user-1', supabase as never),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(supabase.from).not.toHaveBeenCalledWith('pending_operations')
  })

  it('returns a merged dry-run preview without staging', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({
      data: {
        bank_name: 'Old Bank',
        clearing_number: '1234',
        account_number: '1234567',
        bankgiro: null,
        default_our_reference: 'Old Contact',
      },
    })
    enqueue(OWNER)
    enqueue(HAS_DEADLINES)

    const result = (await updateTool().execute(
      { bankgiro: '5050-1055', contact_person: 'New Contact', dry_run: true },
      'company-1',
      'user-1',
      supabase as never,
    )) as {
      staged: boolean
      dry_run?: boolean
      preview: Record<string, unknown>
    }

    expect(result.staged).toBe(false)
    expect(result.dry_run).toBe(true)
    expect(result.preview).toMatchObject({
      bank_name: 'Old Bank',
      bankgiro: '5050-1055',
      contact_person: 'New Contact',
      changes: { bankgiro: '5050-1055', contact_person: 'New Contact' },
      previous: { bankgiro: null, contact_person: 'Old Contact' },
      deadlines_will_regenerate: false,
    })
    expect(supabase.from).not.toHaveBeenCalledWith('pending_operations')
  })

  it('stages contact details and invoice email texts with a mapped preview', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { company_id: 'company-1', email: null } })
    enqueue(OWNER)
    enqueue(HAS_DEADLINES)
    enqueue({ data: { id: 'op-settings-2' } })

    const result = (await updateTool().execute(
      {
        email: 'faktura@example.se',
        phone: '08-123 456 78',
        website: 'https://example.se',
        invoice_email_texts: { sv: { subject: 'Faktura {fakturanummer}' } },
      },
      'company-1',
      'user-1',
      supabase as never,
    )) as {
      staged: boolean
      operation_id?: string
      preview: { changes?: Record<string, unknown> } & Record<string, unknown>
    }

    expect(result.staged).toBe(true)
    expect(result.operation_id).toBe('op-settings-2')
    expect(result.preview.changes).toMatchObject({
      email: 'faktura@example.se',
      phone: '08-123 456 78',
      website: 'https://example.se',
      invoice_email_texts: { sv: { subject: 'Faktura {fakturanummer}' } },
    })
    expect(result.preview.changes).not.toHaveProperty('default_our_reference')
    expect(result.preview).toMatchObject({ email: 'faktura@example.se', website: 'https://example.se' })
    expect(supabase.from).toHaveBeenNthCalledWith(4, 'pending_operations')
  })

  it('stages the flat input as params, which the commit path runs as settings.update', async () => {
    const { supabase, enqueue, findCall } = createQueuedMockSupabase()
    enqueue({ data: { company_id: 'company-1' } })
    enqueue(OWNER)
    enqueue(HAS_DEADLINES)
    enqueue({ data: { id: 'op-settings-1' } })

    const result = (await updateTool().execute(
      { contact_person: 'Test Contact' },
      'company-1',
      'user-1',
      supabase as never,
    )) as { staged: boolean; operation_id?: string; risk_level: string }

    expect(result).toMatchObject({
      staged: true,
      operation_id: 'op-settings-1',
      risk_level: 'medium',
    })
    const inserted = findCall('pending_operations', 'insert')?.[0] as { operation_type: string; params: unknown }
    expect(inserted.operation_type).toBe('update_company_settings')
    expect(inserted.params).toEqual({ contact_person: 'Test Contact' })
  })
})
