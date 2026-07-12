import { describe, it, expect } from 'vitest'
import { routeToIntent } from '../route-mapping'

describe('routeToIntent', () => {
  it('falls back to general.help when pathname is null/undefined/empty', () => {
    for (const input of [null, undefined, '']) {
      const out = routeToIntent(input as string | null | undefined)
      expect(out.intentId).toBe('general.help')
      expect(out.labelSuffix).toBeNull()
    }
  })

  it('routes the root and list pages to general.help', () => {
    for (const route of ['/', '/transactions', '/invoices', '/customers', '/reports']) {
      const out = routeToIntent(route)
      expect(out.intentId).toBe('general.help')
      expect(out.intentArgs.route).toBe(route)
      expect(out.labelSuffix).toBeNull()
      expect(out.contextRef).toBeUndefined()
    }
  })

  it('routes /invoices/new to invoice.draft without an id', () => {
    const out = routeToIntent('/invoices/new')
    expect(out.intentId).toBe('invoice.draft')
    expect(out.intentArgs).toEqual({})
    expect(out.contextRef).toBeUndefined()
    expect(out.labelSuffix).toBe('om denna faktura')
  })

  it('routes /invoices/[id] to invoice.draft with the id', () => {
    const out = routeToIntent('/invoices/abc-123')
    expect(out.intentId).toBe('invoice.draft')
    expect(out.intentArgs).toEqual({ invoice_id: 'abc-123' })
    expect(out.contextRef).toBe('invoice:abc-123')
    expect(out.labelSuffix).toBe('om denna faktura')
  })

  it('routes /invoices/[id]/credit to invoice.draft with the parent id', () => {
    // The credit-note form is still an invoice context: same intent, same
    // captured entity. The :credit suffix isn't its own intent.
    const out = routeToIntent('/invoices/abc-123/credit')
    expect(out.intentId).toBe('invoice.draft')
    expect(out.intentArgs).toEqual({ invoice_id: 'abc-123' })
    expect(out.contextRef).toBe('invoice:abc-123')
  })

  it('routes /supplier-invoices/[id] to supplier_invoice.review', () => {
    const out = routeToIntent('/supplier-invoices/sup-1')
    expect(out.intentId).toBe('supplier_invoice.review')
    expect(out.intentArgs).toEqual({ supplier_invoice_id: 'sup-1' })
    expect(out.contextRef).toBe('supplier_invoice:sup-1')
    expect(out.labelSuffix).toBe('om denna leverantörsfaktura')
  })

  it('does NOT route /supplier-invoices/new to supplier_invoice.review (no entity yet)', () => {
    // There's no invoice to review yet: fall through so the Opus intent
    // doesn't fire on an empty capture.
    const out = routeToIntent('/supplier-invoices/new')
    expect(out.intentId).toBe('general.help')
  })

  it('falls through /bookkeeping/[id] to general.help (FAB is suppressed on the verifikation editor)', () => {
    // The verifikation editor is a dense regulatory surface; AgentTrigger
    // hides the FAB on /bookkeeping/[id] entirely. routeToIntent still
    // returns a sensible default in case anything else queries it.
    const out = routeToIntent('/bookkeeping/je-7')
    expect(out.intentId).toBe('general.help')
    expect(out.intentArgs).toEqual({ route: '/bookkeeping/je-7' })
    expect(out.labelSuffix).toBeNull()
    expect(out.contextRef).toBeUndefined()
  })

  it('routes /bookkeeping/year-end to bokslut.step (matches the page button: no two-agents-on-one-page)', () => {
    const out = routeToIntent('/bookkeeping/year-end')
    expect(out.intentId).toBe('bokslut.step')
    expect(out.intentArgs).toEqual({ step_id: null })
    expect(out.contextRef).toBe('bokslut:overview')
    expect(out.labelSuffix).toBe('om bokslutet')
  })

  it('routes /kpi to kpi.explain (matches the page button)', () => {
    const out = routeToIntent('/kpi')
    expect(out.intentId).toBe('kpi.explain')
    expect(out.intentArgs).toEqual({ kpi_key: 'översikt' })
    expect(out.contextRef).toBe('kpi:översikt')
    expect(out.labelSuffix).toBe('om nyckeltalen')
  })

  it('does NOT route bare /bookkeeping list page to verifikation.draft', () => {
    const out = routeToIntent('/bookkeeping')
    expect(out.intentId).toBe('general.help')
  })

  it('routes /settings/<panel> to settings.help with the panel slug', () => {
    const out = routeToIntent('/settings/invoicing')
    expect(out.intentId).toBe('settings.help')
    expect(out.intentArgs).toEqual({ panel: 'invoicing' })
    expect(out.labelSuffix).toBeNull()
  })

  it('takes the first segment after /settings as the panel slug (ignores deeper paths)', () => {
    const out = routeToIntent('/settings/invoicing/templates/new')
    expect(out.intentId).toBe('settings.help')
    expect(out.intentArgs).toEqual({ panel: 'invoicing' })
  })

  it('routes bare /settings without a panel slug to general.help', () => {
    const out = routeToIntent('/settings')
    expect(out.intentId).toBe('general.help')
  })
})
