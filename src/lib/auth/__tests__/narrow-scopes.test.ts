/**
 * The narrow scopes of crm#1548: invoices:draft, suppliers:register and
 * dimensions:read. Each is included in its broader grant (SCOPE_INCLUDED_IN),
 * so no existing key loses a door; a key holding only the narrow scope opens
 * exactly the doors pinned here and nothing else. A door joins a narrow scope
 * only through a reviewed edit of these lists.
 */
import { describe, expect, it } from 'vitest'
import { listEndpoints } from '@/lib/api/v1/registry'
import '@/lib/api/v1/load-routes'
import { hasScope } from '@/lib/auth/api-keys'
import {
  ALL_SCOPES,
  findStageApproveConflict,
  SCOPE_INCLUDED_IN,
  scopeSatisfied,
  TOOL_SCOPE_MAP,
  type ApiKeyScope,
} from '@/lib/auth/scope-catalog'
import { INVOICER_API_SCOPES, roleAllowsScope } from '@/lib/auth/invoicer-role'

const V1 = '/api/v1/companies/:companyId'

const endpointsOn = (scope: ApiKeyScope) =>
  listEndpoints()
    .filter((e) => e.scope === scope)
    .map((e) => `${e.method} ${e.path}`)
    .sort()

const toolsOn = (scope: ApiKeyScope) =>
  Object.entries(TOOL_SCOPE_MAP)
    .filter(([, s]) => s === scope)
    .map(([tool]) => tool)
    .sort()

describe('scope inclusion', () => {
  it('a broader grant satisfies the narrow scope it includes', () => {
    expect(hasScope(['invoices:write'], 'invoices:draft')).toBe(true)
    expect(hasScope(['suppliers:write'], 'suppliers:register')).toBe(true)
    expect(hasScope(['reports:read'], 'dimensions:read')).toBe(true)
    expect(hasScope(['invoices:read'], 'dimensions:read')).toBe(true)
  })

  it('a narrow scope never satisfies the broader door (never widened)', () => {
    expect(hasScope(['invoices:draft'], 'invoices:write')).toBe(false)
    expect(hasScope(['invoices:draft', 'invoices:read'], 'invoices:write')).toBe(false)
    expect(hasScope(['suppliers:register'], 'suppliers:write')).toBe(false)
    expect(hasScope(['dimensions:read'], 'reports:read')).toBe(false)
    expect(hasScope(['dimensions:read'], 'invoices:read')).toBe(false)
  })

  it('inclusion is not transitive across unrelated grants', () => {
    expect(hasScope(['invoices:read'], 'invoices:draft')).toBe(false)
    expect(hasScope(['reports:read'], 'invoices:draft')).toBe(false)
    expect(hasScope(['bookkeeping:write'], 'suppliers:register')).toBe(false)
    expect(hasScope([], 'dimensions:read')).toBe(false)
  })

  it('only the three narrow scopes are included anywhere, each in grants of its own area', () => {
    expect(SCOPE_INCLUDED_IN).toEqual({
      'invoices:draft': ['invoices:write'],
      'suppliers:register': ['suppliers:write'],
      'dimensions:read': ['reports:read', 'invoices:read'],
    })
    for (const scope of ALL_SCOPES) {
      if (scope in SCOPE_INCLUDED_IN) continue
      // Every other scope is satisfied by itself alone.
      for (const other of ALL_SCOPES) {
        if (other !== scope) expect(scopeSatisfied([other], scope)).toBe(false)
      }
    }
  })
})

describe('invoices:draft opens only the draft doors', () => {
  it('v1: create, bulk-create and the draft PATCH', () => {
    expect(endpointsOn('invoices:draft')).toEqual(
      [
        `PATCH ${V1}/invoices/:id`,
        `POST ${V1}/invoices`,
        `POST ${V1}/invoices/bulk-create`,
      ].sort(),
    )
  })

  it('MCP: the staged create and draft update', () => {
    expect(toolsOn('invoices:draft')).toEqual(['gnubok_create_invoice', 'gnubok_update_invoice'])
  })

  it('every door out of draft stays on invoices:write, which a draft-only key never satisfies', () => {
    const exits = [
      `POST ${V1}/invoices/:id/send`,
      `POST ${V1}/invoices/:id/send-peppol`,
      `POST ${V1}/invoices/:id/credit`,
      `POST ${V1}/invoices/:id/mark-paid`,
      `POST ${V1}/invoices/:id/mark-sent`,
      `POST ${V1}/invoices/:id/book`,
      `POST ${V1}/invoices/:id/cancel`,
      `POST ${V1}/invoices/:id/quote-status`,
      `DELETE ${V1}/invoices/:id`,
      `POST ${V1}/invoices/bulk-book`,
    ]
    const byKey = new Map(listEndpoints().map((e) => [`${e.method} ${e.path}`, e.scope]))
    for (const door of exits) {
      expect(byKey.get(door), door).toBe('invoices:write')
      expect(hasScope(['invoices:read', 'invoices:draft'], 'invoices:write')).toBe(false)
    }
    for (const tool of [
      'gnubok_send_invoice',
      'gnubok_send_invoice_peppol',
      'gnubok_credit_invoice',
      'gnubok_mark_invoice_as_paid',
      'gnubok_mark_invoice_as_sent',
      'gnubok_book_invoice',
      'gnubok_bulk_book_invoices',
      'gnubok_delete_draft_invoice',
      'gnubok_convert_invoice',
      'gnubok_set_quote_status',
    ]) {
      expect(TOOL_SCOPE_MAP[tool], tool).toBe('invoices:write')
    }
  })

  it('an invoicer membership keeps the draft doors it reached through invoices:write', () => {
    expect(INVOICER_API_SCOPES).toContain('invoices:draft')
    expect(roleAllowsScope('invoicer', 'invoices:draft')).toBe(true)
    // ...and gains nothing outside its area.
    expect(roleAllowsScope('invoicer', 'suppliers:register')).toBe(false)
    expect(roleAllowsScope('invoicer', 'dimensions:read')).toBe(false)
  })

  it('stages, so a key holding it and pending_operations:approve is a SoD conflict', () => {
    expect(findStageApproveConflict(['invoices:draft', 'pending_operations:approve'])).toBe('invoices:draft')
    expect(findStageApproveConflict(['suppliers:register', 'pending_operations:approve'])).toBe('suppliers:register')
  })
})

describe('suppliers:register opens only registration and its edit', () => {
  it('v1: register and the registered-only PATCH; no MCP tool', () => {
    expect(endpointsOn('suppliers:register')).toEqual(
      [`PATCH ${V1}/supplier-invoices/:id`, `POST ${V1}/supplier-invoices`].sort(),
    )
    expect(toolsOn('suppliers:register')).toEqual([])
  })

  it('approve, book, credit, pay and delete stay on suppliers:write', () => {
    const byKey = new Map(listEndpoints().map((e) => [`${e.method} ${e.path}`, e.scope]))
    for (const door of [
      `POST ${V1}/supplier-invoices/:id/approve`,
      `POST ${V1}/supplier-invoices/:id/book`,
      `POST ${V1}/supplier-invoices/:id/credit`,
      `POST ${V1}/supplier-invoices/:id/mark-paid`,
      `DELETE ${V1}/supplier-invoices/:id`,
    ]) {
      const scope = byKey.get(door)
      expect(scope, door).toBeDefined()
      expect(scope, door).not.toBe('suppliers:register')
      expect(hasScope(['suppliers:read', 'suppliers:register'], scope as ApiKeyScope), door).toBe(false)
    }
  })
})

describe('dimensions:read', () => {
  it('opens the dimension list (v1 and MCP) and nothing else', () => {
    expect(endpointsOn('dimensions:read')).toEqual([`GET ${V1}/dimensions`])
    expect(toolsOn('dimensions:read')).toEqual(['gnubok_list_dimension_values', 'gnubok_list_dimensions'])
  })
})
