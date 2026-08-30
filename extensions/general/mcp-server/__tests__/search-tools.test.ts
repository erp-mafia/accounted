import { describe, it, expect } from 'vitest'
import { tools } from '../server'
import { ALL_SCOPES } from '@/lib/auth/api-keys'

const searchTool = tools.find((t) => t.name === 'gnubok_search_tools')!

async function call(args: Record<string, unknown>, keyScopes: string[] = ALL_SCOPES as unknown as string[]) {
  // Mirror the dispatcher: inject __keyScopes the way handleMcpRequest does.
  const argsWithScopes = { ...args, __keyScopes: keyScopes }
  return (await searchTool.execute(
    argsWithScopes,
    'company-id',
    'user-id',
    {} as never,
    { type: 'api_key' }
  )) as {
    tools: Array<{ name: string; description?: string; scope: string | null; inputSchema?: unknown; outputSchema?: unknown }>
    count: number
    total_matched: number
    detail: 'name' | 'summary' | 'full'
  }
}

describe('gnubok_search_tools', () => {
  it('is registered as a tool', () => {
    expect(searchTool).toBeDefined()
    expect(searchTool.annotations.readOnlyHint).toBe(true)
  })

  it('returns all tools when query is empty (default summary detail)', async () => {
    const result = await call({})
    expect(result.detail).toBe('summary')
    expect(result.tools.length).toBeGreaterThan(0)
    expect(result.tools.length).toBeLessThanOrEqual(20) // default limit
    // summary entries should have name + description but not full schema
    expect(result.tools[0]).toHaveProperty('name')
    expect(result.tools[0]).toHaveProperty('description')
    expect(result.tools[0]).not.toHaveProperty('inputSchema')
  })

  it('detail=name returns only names + scope', async () => {
    const result = await call({ detail: 'name', limit: 5 })
    expect(result.detail).toBe('name')
    for (const t of result.tools) {
      expect(t).not.toHaveProperty('description')
      expect(t).not.toHaveProperty('inputSchema')
      expect(t).toHaveProperty('name')
      expect(t).toHaveProperty('scope')
    }
  })

  it('detail=full returns inputSchema and outputSchema', async () => {
    const result = await call({ detail: 'full', query: 'list_uncategorized', limit: 5 })
    expect(result.tools.length).toBeGreaterThan(0)
    const tool = result.tools[0]
    expect(tool).toHaveProperty('inputSchema')
    expect(tool).toHaveProperty('outputSchema')
    expect(
      (tool.inputSchema as { properties: Record<string, unknown> }).properties
    ).toHaveProperty('company_id')
  })

  it('does not add company_id to company-independent discovery tools', async () => {
    const result = await call({ detail: 'full', query: 'search tools', limit: 5 })
    const tool = result.tools.find((candidate) => candidate.name === 'gnubok_search_tools')

    expect(tool).toBeDefined()
    expect(
      (tool!.inputSchema as { properties: Record<string, unknown> }).properties
    ).not.toHaveProperty('company_id')
  })

  it('filters by query keyword', async () => {
    const result = await call({ query: 'vat' })
    expect(result.tools.length).toBeGreaterThan(0)
    for (const t of result.tools) {
      const haystack = `${t.name} ${t.description ?? ''}`.toLowerCase()
      expect(haystack).toContain('vat')
    }
  })

  it('ranks by relevance: the most on-point tool comes first', async () => {
    // "vat" should surface the canonical report tool ahead of other vat-* tools,
    // not whichever is defined earliest by accident.
    const vat = await call({ query: 'vat' })
    expect(vat.tools[0].name).toBe('gnubok_get_vat_report')

    // Multi-word query: every term must match (name or description), and the
    // tool whose NAME carries both terms ranks first.
    const paid = await call({ query: 'invoice paid' })
    expect(paid.tools.length).toBeGreaterThan(0)
    expect(paid.tools[0].name).toBe('gnubok_mark_invoice_as_paid')
  })

  it('respects limit (1-50, default 20, clamps over-50)', async () => {
    const overLimit = await call({ limit: 100 })
    expect(overLimit.tools.length).toBeLessThanOrEqual(50)
  })

  it('filters out tools the caller cannot invoke based on scopes', async () => {
    // Caller has only reports:read: should not see invoices:write tools.
    const result = await call({ query: '', limit: 50 }, ['reports:read'])
    const names = result.tools.map((t) => t.name)
    expect(names).not.toContain('gnubok_create_invoice')
    expect(names).not.toContain('gnubok_send_invoice')
    // But should see reports:read tools.
    expect(names).toContain('gnubok_get_trial_balance')
    // And unscoped tools (like search itself) are always available.
    expect(names).toContain('gnubok_search_tools')
  })

  it('scope filter narrows results to a single scope', async () => {
    const result = await call({ scope: 'invoices:write', limit: 50 })
    for (const t of result.tools) {
      expect(t.scope).toBe('invoices:write')
    }
  })

  it('total_matched reflects pre-limit candidates', async () => {
    const limited = await call({ query: '', limit: 3 })
    expect(limited.tools.length).toBe(3)
    expect(limited.total_matched).toBeGreaterThan(3)
  })

  // Security: when the dispatcher fails to inject __keyScopes (rename, refactor
  // regression, direct invocation outside the dispatcher), the search MUST fall
  // back to a fail-closed default: only unscoped tools visible. The earlier
  // permissive default leaked the full inventory.
  it('fail-closed: hides scoped tools when __keyScopes is not injected', async () => {
    // Bypass the helper which always injects __keyScopes: call execute() directly.
    const result = (await searchTool.execute(
      { limit: 50 }, // no __keyScopes
      'company-id',
      'user-id',
      {} as never,
      { type: 'api_key' }
    )) as { tools: Array<{ name: string; scope: string | null }> }

    const names = result.tools.map((t) => t.name)

    // Only unscoped (discovery / skill) tools should appear.
    expect(names).toContain('gnubok_search_tools')
    expect(names).toContain('gnubok_list_skills')
    expect(names).toContain('gnubok_load_skill')

    // No scoped tool should leak: pick representatives from each scope domain.
    expect(names).not.toContain('gnubok_create_invoice')         // invoices:write
    expect(names).not.toContain('gnubok_get_trial_balance')      // reports:read
    expect(names).not.toContain('gnubok_list_uncategorized_transactions') // transactions:read
    expect(names).not.toContain('gnubok_create_salary_run')      // payroll:write
    expect(names).not.toContain('gnubok_close_period')           // bookkeeping:write

    // Sanity: every returned tool truly is unscoped.
    for (const t of result.tools) {
      expect(t.scope).toBeNull()
    }
  })

  // Swedish keyword synonyms: matcher-side `keywords` on tool definitions let
  // Swedish queries hit the right tools without inflating any payload.
  describe('Swedish keyword synonyms', () => {
    it('"bankkonto" ranks list_cash_accounts first; "kassakonto" finds it too', async () => {
      const bank = await call({ query: 'bankkonto', limit: 10 })
      expect(bank.tools.length).toBeGreaterThan(0)
      expect(bank.tools[0].name).toBe('gnubok_list_cash_accounts')

      const kassa = await call({ query: 'kassakonto', limit: 10 })
      expect(kassa.tools.map((t) => t.name)).toContain('gnubok_list_cash_accounts')
    })

    it('"kundfaktura" ranks list_invoices first and includes create_invoice', async () => {
      const result = await call({ query: 'kundfaktura', limit: 50 })
      expect(result.tools[0].name).toBe('gnubok_list_invoices')
      expect(result.tools.map((t) => t.name)).toContain('gnubok_create_invoice')
    })

    it('"leverantörsfaktura" ranks list_supplier_invoices first', async () => {
      const result = await call({ query: 'leverantörsfaktura', limit: 50 })
      expect(result.tools[0].name).toBe('gnubok_list_supplier_invoices')
      const names = result.tools.map((t) => t.name)
      expect(names).toContain('gnubok_approve_supplier_invoice')
      expect(names).toContain('gnubok_get_supplier_ledger')
    })

    it('"lönekörning" finds the salary run tools', async () => {
      const result = await call({ query: 'lönekörning', limit: 50 })
      const names = result.tools.map((t) => t.name)
      expect(names).toContain('gnubok_create_salary_run')
      expect(names).toContain('gnubok_calculate_salary_run')
      expect(names).toContain('gnubok_book_salary_run')
    })

    it('"verifikat" finds voucher and journal tools', async () => {
      const result = await call({ query: 'verifikat', limit: 50 })
      const names = result.tools.map((t) => t.name)
      expect(names).toContain('gnubok_create_voucher')
      expect(names).toContain('gnubok_query_journal')
    })

    it('"momsdeklaration" finds the VAT tools', async () => {
      const result = await call({ query: 'momsdeklaration', limit: 50 })
      const names = result.tools.map((t) => t.name)
      expect(names).toContain('gnubok_get_vat_report')
      expect(names).toContain('gnubok_vat_declaration_submit')
    })

    it('"kontoplan" ranks list_accounts first', async () => {
      const result = await call({ query: 'kontoplan', limit: 10 })
      expect(result.tools[0].name).toBe('gnubok_list_accounts')
    })

    it('"avstämning" and "skattekonto" rank reconciliation status first', async () => {
      const avstamning = await call({ query: 'avstämning', limit: 50 })
      expect(avstamning.tools[0].name).toBe('gnubok_get_reconciliation_status')
      expect(avstamning.tools.map((t) => t.name)).toContain('gnubok_reconcile_match')

      const skattekonto = await call({ query: 'skattekonto', limit: 50 })
      expect(skattekonto.tools[0].name).toBe('gnubok_get_reconciliation_status')
    })

    it('"anställd" ranks list_employees first', async () => {
      const result = await call({ query: 'anställd', limit: 50 })
      expect(result.tools[0].name).toBe('gnubok_list_employees')
      expect(result.tools.map((t) => t.name)).toContain('gnubok_create_employee')
    })

    it('"kvitto" and "underlag" find document and inbox tools', async () => {
      const kvitto = await call({ query: 'kvitto', limit: 50 })
      const kvittoNames = kvitto.tools.map((t) => t.name)
      expect(kvittoNames).toContain('gnubok_list_inbox_items')
      expect(kvittoNames).toContain('gnubok_upload_document')

      const underlag = await call({ query: 'underlag', limit: 50 })
      expect(underlag.tools.map((t) => t.name)).toContain('gnubok_list_unmatched_documents')
    })

    it('"påminnelse" finds list_invoices (chasing overdue invoices)', async () => {
      const result = await call({ query: 'påminnelse', limit: 10 })
      expect(result.tools.map((t) => t.name)).toContain('gnubok_list_invoices')
    })

    it('keywords are matcher-side only: never serialized into search results', async () => {
      // A keyword-only match proves the keywords were consulted; the payload
      // must still not carry them at any detail level.
      for (const detail of ['name', 'summary', 'full'] as const) {
        const result = await call({ query: 'bankkonto', detail, limit: 5 })
        expect(result.tools.length).toBeGreaterThan(0)
        const raw = JSON.stringify(result)
        expect(raw).not.toContain('"keywords"')
        expect(raw).not.toContain('kassakonto')
      }
    })
  })

  it('fail-closed: explicitly empty __keyScopes also hides scoped tools', async () => {
    // The "scopes were checked, granted set is empty" case must behave the same
    // as "scopes were not injected at all". Both indicate no scoped access.
    const result = (await searchTool.execute(
      { __keyScopes: [], limit: 50 },
      'company-id',
      'user-id',
      {} as never,
      { type: 'api_key' }
    )) as { tools: Array<{ name: string; scope: string | null }> }

    const names = result.tools.map((t) => t.name)
    expect(names).not.toContain('gnubok_create_invoice')
    expect(names).not.toContain('gnubok_get_trial_balance')
    for (const t of result.tools) {
      expect(t.scope).toBeNull()
    }
  })
})
