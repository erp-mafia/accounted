import { describe, expect, it } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { TOOL_SCOPE_MAP } from '@/lib/auth/api-keys'
import { OPERATION_RISK_TIERS } from '@/lib/pending-operations/risk-tiers'
import { deriveToolMeta, tools } from '../server'

const INVOICE_ID = '22222222-2222-4222-8222-222222222222'
const tool = () => tools.find((candidate) => candidate.name === 'gnubok_delete_draft_invoice')!

function draftInvoice(overrides: Record<string, unknown> = {}) {
  return {
    id: INVOICE_ID,
    invoice_number: null,
    status: 'draft',
    total: 12500,
    currency: 'SEK',
    customer: { name: 'Testbrand AB' },
    ...overrides,
  }
}

describe('gnubok_delete_draft_invoice: registration', () => {
  it('is a strict, staged, destructive invoices:write tool at high risk', () => {
    expect(tool()).toBeDefined()
    expect(tool().inputSchema.additionalProperties).toBe(false)
    expect(tool().annotations.readOnlyHint).toBe(false)
    expect(tool().annotations.destructiveHint).toBe(true)
    expect(tool().annotations.idempotentHint).toBe(false)
    // tools/list budget is at zero headroom: search-only catalog visibility.
    expect(tool().catalogVisibility).toBe('search')
    expect(TOOL_SCOPE_MAP.gnubok_delete_draft_invoice).toBe('invoices:write')
    // 'high' risk: never auto-committed, approval is always required.
    expect(OPERATION_RISK_TIERS.delete_draft_invoice).toBe('high')
  })

  it('returns the staged-operation envelope and derives requires_approval meta', () => {
    const schema = tool().outputSchema as { properties?: Record<string, unknown>; required?: string[] }
    expect(schema?.properties?.staged).toBeDefined()
    expect(schema?.required).toContain('staged')
    // deriveToolMeta keys off the STAGED_OPERATION_SCHEMA reference: the
    // machine-readable approval contract must come for free.
    expect(deriveToolMeta(tool())).toMatchObject({
      requires_approval: true,
      approve_tool: 'gnubok_approve_pending_operation',
    })
  })

  it('keeps its description within the 280-char budget and declares drafts-only staging', () => {
    expect(tool().description.length).toBeLessThanOrEqual(280)
    expect(tool().description).toMatch(/stag(e|ing)/i)
    expect(tool().description).toMatch(/draft/i)
    expect(tool().description).toContain('gnubok_credit_invoice')
  })
})

describe('gnubok_delete_draft_invoice: staging', () => {
  it('requires invoice_id', async () => {
    const { supabase } = createQueuedMockSupabase()

    await expect(
      tool().execute({}, 'company-1', 'user-1', supabase as never),
    ).rejects.toThrow(/invoice_id is required/i)
    expect(supabase.from).not.toHaveBeenCalled()
  })

  it('throws for an invoice that does not exist in the company', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: null, error: { message: 'not found' } })

    await expect(
      tool().execute({ invoice_id: INVOICE_ID }, 'company-1', 'user-1', supabase as never),
    ).rejects.toThrow(/not found/i)
    expect(supabase.from).not.toHaveBeenCalledWith('pending_operations')
  })

  it.each([
    ['sent invoice', 'sent'],
    ['paid invoice', 'paid'],
    ['credited invoice', 'credited'],
    ['already cancelled invoice', 'cancelled'],
  ])('refuses a %s at staging time, before anything is staged', async (_label, status) => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: draftInvoice({ status, invoice_number: 'F-2026042' }) })

    await expect(
      tool().execute({ invoice_id: INVOICE_ID }, 'company-1', 'user-1', supabase as never),
    ).rejects.toThrow(/only draft invoices can be deleted/i)
    expect(supabase.from).toHaveBeenCalledTimes(1)
    expect(supabase.from).not.toHaveBeenCalledWith('pending_operations')
  })

  it('stages a hard delete for an unnumbered draft, requiring approval', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: draftInvoice() })
    enqueue({ data: { id: 'op-delete-1' } })

    const result = (await tool().execute(
      { invoice_id: INVOICE_ID },
      'company-1',
      'user-1',
      supabase as never,
    )) as { staged: boolean; operation_id?: string; risk_level: string; preview: Record<string, unknown> }

    expect(result).toMatchObject({
      staged: true,
      operation_id: 'op-delete-1',
      risk_level: 'high',
    })
    expect(supabase.from).toHaveBeenCalledTimes(2)
    expect(supabase.from).toHaveBeenNthCalledWith(2, 'pending_operations')
    expect(result.preview).toMatchObject({
      invoice_id: INVOICE_ID,
      invoice_number: null,
      customer_name: 'Testbrand AB',
    })
    expect(String(result.preview.method)).toMatch(/hard delete/i)
  })

  it('stages a makulering for a numbered draft, retaining the F-series number', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: draftInvoice({ invoice_number: 'F-2026042' }) })
    enqueue({ data: { id: 'op-delete-2' } })

    const result = (await tool().execute(
      { invoice_id: INVOICE_ID },
      'company-1',
      'user-1',
      supabase as never,
    )) as { staged: boolean; risk_level: string; preview: Record<string, unknown> }

    expect(result).toMatchObject({ staged: true, risk_level: 'high' })
    expect(result.preview).toMatchObject({ invoice_number: 'F-2026042' })
    expect(String(result.preview.method)).toMatch(/makulering/i)
  })

  it('returns a dry-run preview without staging', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: draftInvoice({ invoice_number: 'F-2026042' }) })

    const result = (await tool().execute(
      { invoice_id: INVOICE_ID, dry_run: true },
      'company-1',
      'user-1',
      supabase as never,
    )) as { staged: boolean; dry_run?: boolean; preview: Record<string, unknown> }

    expect(result.staged).toBe(false)
    expect(result.dry_run).toBe(true)
    expect(result.preview).toMatchObject({ invoice_number: 'F-2026042' })
    // Exactly one read; pending_operations was never touched.
    expect(supabase.from).toHaveBeenCalledTimes(1)
    expect(supabase.from).not.toHaveBeenCalledWith('pending_operations')
  })
})
