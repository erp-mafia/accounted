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
    expect(updateTool().annotations.idempotentHint).toBe(true)
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

  it('exposes the same field set on the read and write tools', () => {
    const readFields = (
      (getTool().outputSchema as { required: string[] }).required
    )
      .filter((field) => field !== 'company_id')
      .sort()
    const writeFields = Object.keys(
      (updateTool().inputSchema as { properties: Record<string, unknown> }).properties,
    )
      .filter((field) => field !== 'dry_run' && field !== 'idempotency_key')
      .sort()

    expect(writeFields).toEqual(readFields)
    expect(readFields).toEqual(
      [
        'account_number',
        'bank_name',
        'bankgiro',
        'bic',
        'clearing_number',
        'contact_person',
        'email',
        'iban',
        'invoice_email_texts',
        'phone',
        'plusgiro',
        'swish',
        'website',
      ],
    )
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
        bank_name: 'Testbanken',
        clearing_number: '1234',
        account_number: '1234567',
        bankgiro: '5050-1055',
        plusgiro: null,
        swish: '1231231231',
        iban: null,
        bic: null,
        default_our_reference: 'Test Contact',
      },
    })

    const result = await getTool().execute({}, 'company-1', 'user-1', supabase as never)

    expect(result).toMatchObject({
      company_id: 'company-1',
      bankgiro: '5050-1055',
      contact_person: 'Test Contact',
    })
    expect(supabase.from).toHaveBeenCalledWith('company_settings')
  })

  it('fails when the company has no settings row', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: null, error: null })

    await expect(
      getTool().execute({}, 'company-1', 'user-1', supabase as never),
    ).rejects.toThrow(/not found/i)
  })
})

describe('gnubok_update_company_settings', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

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

  it('returns a merged dry-run preview without staging', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({
      data: {
        bank_name: 'Old Bank',
        clearing_number: '1234',
        account_number: '1234567',
        bankgiro: null,
        plusgiro: null,
        swish: null,
        iban: null,
        bic: null,
        default_our_reference: 'Old Contact',
      },
    })

    const result = (await updateTool().execute(
      { bankgiro: '5050-1055', contact_person: 'New Contact', dry_run: true },
      'company-1',
      'user-1',
      supabase as never,
    )) as {
      staged: boolean
      dry_run?: boolean
      preview: { proposed?: Record<string, unknown> }
    }

    expect(result.staged).toBe(false)
    expect(result.dry_run).toBe(true)
    expect(result.preview.proposed).toMatchObject({
      bank_name: 'Old Bank',
      bankgiro: '5050-1055',
      contact_person: 'New Contact',
    })
    expect(supabase.from).toHaveBeenCalledTimes(1)
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

  it('stages contact details and invoice email texts with a mapped preview', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({
      data: {
        bank_name: null,
        clearing_number: null,
        account_number: null,
        bankgiro: null,
        plusgiro: null,
        swish: null,
        iban: null,
        bic: null,
        default_our_reference: null,
        email: null,
        phone: null,
        website: null,
        invoice_email_texts: null,
      },
    })
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
      preview: {
        changes?: Record<string, unknown>
        proposed?: Record<string, unknown>
      }
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
    expect(result.preview.proposed).toMatchObject({
      email: 'faktura@example.se',
      website: 'https://example.se',
    })
    expect(supabase.from).toHaveBeenNthCalledWith(2, 'pending_operations')
  })

  it('stages a validated update for approval', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({
      data: {
        bank_name: null,
        clearing_number: null,
        account_number: null,
        bankgiro: null,
        plusgiro: null,
        swish: null,
        iban: null,
        bic: null,
        default_our_reference: null,
      },
    })
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
    expect(supabase.from).toHaveBeenNthCalledWith(2, 'pending_operations')
  })
})
