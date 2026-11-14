import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  INVOICER_API_SCOPES,
  INVOICER_HOME,
  INVOICER_PAGES,
  INVOICER_ROUTES,
  invoicerRouteAccess,
  isAttestRole,
  isBookkeepingWriterRole,
  invoicerPageRedirect,
  isInvoicerPagePath,
  roleAllowsScope,
} from '../invoicer-role'

const ID = '7f3c2a10-1b2c-4d5e-8f90-123456789abc'
const ROOT = process.cwd()

describe('the invoicer allowlist', () => {
  // The guard: a route or page joins the role's reach only by editing this
  // test, so every widening is a reviewed line in a diff. A `scoped` route
  // runs on a service-role client: add one only for a write the invoicing
  // pages need, never for a read.
  it('is exactly this list of routes', () => {
    expect(INVOICER_ROUTES).toEqual({
      'GET /api/invoices': 'session',
      'POST /api/invoices': 'scoped',
      'PATCH /api/invoices/[id]': 'scoped',
      'DELETE /api/invoices/[id]': 'scoped',
      'POST /api/invoices/[id]/send': 'scoped',
      // for #206: number a draft the role saved, issue it without sending,
      // read its delivery history and the PDF a delivery archived.
      'POST /api/invoices/[id]/finalize': 'scoped',
      'POST /api/invoices/[id]/mark-sent': 'scoped',
      'GET /api/invoices/[id]/deliveries': 'session',
      'GET /api/invoices/[id]/archived-pdf': 'scoped',
      'POST /api/invoices/[id]/convert': 'scoped',
      'POST /api/invoices/[id]/convert-to-order': 'scoped',
      'POST /api/invoices/[id]/quote-status': 'scoped',
      'GET /api/invoices/[id]/pdf': 'scoped',
      'POST /api/invoices/preview-pdf': 'scoped',
      'POST /api/invoices/preview-email': 'scoped',
      'GET /api/invoices/next-number': 'scoped',
      'GET /api/customers': 'session',
      'POST /api/customers': 'scoped',
      'GET /api/customers/[id]': 'session',
      'PATCH /api/customers/[id]': 'scoped',
      'DELETE /api/customers/[id]': 'scoped',
      'GET /api/articles': 'session',
      'POST /api/articles': 'scoped',
      'GET /api/articles/[id]': 'session',
      'PATCH /api/articles/[id]': 'scoped',
      'DELETE /api/articles/[id]': 'scoped',
      'GET /api/sales-orders': 'session',
      'POST /api/sales-orders': 'scoped',
      'GET /api/sales-orders/[id]': 'session',
      'PATCH /api/sales-orders/[id]': 'scoped',
      'DELETE /api/sales-orders/[id]': 'scoped',
      'POST /api/sales-orders/[id]/transition': 'scoped',
      'POST /api/sales-orders/[id]/create-invoice': 'scoped',
      'GET /api/settings': 'session',
      'POST /api/vat/validate': 'session',
      'GET /api/currency/rate': 'session',
    })
  })

  it('is exactly this list of pages and scopes', () => {
    expect(INVOICER_HOME).toBe('/invoices')
    expect(INVOICER_PAGES).toEqual([
      '/invoices',
      '/invoices/new',
      '/invoices/[id]',
      '/invoices/[id]/edit',
      '/quotes',
      '/customers',
      '/customers/[id]',
      '/articles',
      '/articles/[id]',
      '/sales-orders',
      '/sales-orders/new',
      '/sales-orders/[id]',
      '/sales-orders/[id]/edit',
      '/settings/account',
    ])
    expect([...INVOICER_API_SCOPES].sort()).toEqual([
      'articles:read',
      'articles:write',
      'customers:read',
      'customers:write',
      // Narrower than invoices:write, which the role already holds (crm#1548).
      'invoices:draft',
      'invoices:read',
      'invoices:write',
    ])
  })

  it('names only routes that exist, export the method and go through withRouteContext', () => {
    for (const key of Object.keys(INVOICER_ROUTES)) {
      const [method, path] = key.split(' ')
      const file = join(ROOT, 'src/app', path, 'route.ts')
      expect(existsSync(file), key).toBe(true)
      const source = readFileSync(file, 'utf8')
      expect(source, key).toMatch(new RegExp(`export const ${method}\\b`))
      expect(source, key).toContain('withRouteContext')
    }
  })

  it('lets no scoped route open its own service-role client', () => {
    for (const [key, access] of Object.entries(INVOICER_ROUTES)) {
      if (access !== 'scoped') continue
      const source = readFileSync(join(ROOT, 'src/app', key.split(' ')[1], 'route.ts'), 'utf8')
      expect(source, key).not.toMatch(/createServiceClient(NoCookies)?\(/)
    }
  })

  it('stays out of the books', () => {
    const forbidden =
      /^\/api\/(salary|payslip|agi|bookkeeping|transactions|bank|reports|documents|arkiv|export|import|events|webhooks|v1|agent|supplier-invoices|payments|reconciliation|skatteverket|vat\/(?!validate))/
    for (const key of Object.keys(INVOICER_ROUTES)) {
      expect(key.split(' ')[1], key).not.toMatch(forbidden)
    }
    for (const page of INVOICER_PAGES) {
      expect(page, page).not.toMatch(/^\/(salary|bookkeeping|transactions|reports|arkiv|payments|supplier-invoices|kpi|chat)/)
    }
  })

  it('names only pages that exist', () => {
    for (const page of INVOICER_PAGES) {
      const file = join(ROOT, 'src/app/(dashboard)', page, 'page.tsx')
      expect(existsSync(file), page).toBe(true)
    }
  })
})

describe('invoicerRouteAccess', () => {
  it('matches method and path, with a uuid for [id]', () => {
    expect(invoicerRouteAccess('POST', `/api/invoices/${ID}/send`)).toBe('scoped')
    expect(invoicerRouteAccess('post', `/api/invoices/${ID}/send`)).toBe('scoped')
    expect(invoicerRouteAccess('GET', '/api/invoices')).toBe('session')
    expect(invoicerRouteAccess('GET', `/api/customers/${ID}`)).toBe('session')
    expect(invoicerRouteAccess('GET', '/api/invoices/next-number')).toBe('scoped')
  })

  it('reaches its own invoice from draft to sent: number, issue, delivery history, archived PDF (for #206)', () => {
    expect(invoicerRouteAccess('POST', `/api/invoices/${ID}/finalize`)).toBe('scoped')
    expect(invoicerRouteAccess('POST', `/api/invoices/${ID}/mark-sent`)).toBe('scoped')
    expect(invoicerRouteAccess('GET', `/api/invoices/${ID}/deliveries`)).toBe('session')
    expect(invoicerRouteAccess('GET', `/api/invoices/${ID}/archived-pdf`)).toBe('scoped')
    // Only as named: no other method, no path under them.
    expect(invoicerRouteAccess('GET', `/api/invoices/${ID}/finalize`)).toBeNull()
    expect(invoicerRouteAccess('POST', `/api/invoices/${ID}/deliveries`)).toBeNull()
    expect(invoicerRouteAccess('POST', `/api/invoices/${ID}/archived-pdf`)).toBeNull()
    expect(invoicerRouteAccess('GET', `/api/invoices/${ID}/deliveries/${ID}`)).toBeNull()
  })

  it('still stops at the payment, the books and the document archive around the invoice', () => {
    for (const [method, path] of [
      ['POST', `/api/invoices/${ID}/mark-paid`],
      ['POST', `/api/invoices/${ID}/book`],
      ['POST', `/api/invoices/${ID}/cancel`],
      ['POST', `/api/invoices/${ID}/resend`],
      ['POST', `/api/invoices/${ID}/send-payment-confirmation`],
      ['POST', `/api/invoices/${ID}/refresh-exchange-rate`],
      ['GET', `/api/invoices/${ID}/attachments`],
      ['POST', `/api/invoices/${ID}/attachments`],
      ['GET', `/api/invoices/${ID}/underlag`],
      ['POST', `/api/invoices/${ID}/underlag`],
      ['GET', `/api/invoices/${ID}/rot-rut`],
      ['GET', `/api/invoices/${ID}/peppol`],
      ['POST', `/api/invoices/${ID}/peppol/send`],
      ['GET', `/api/invoices/${ID}/peppol/deliveries`],
      ['GET', `/api/invoices/${ID}/digital-mailbox`],
      ['POST', `/api/invoices/${ID}/digital-mailbox/send`],
      ['GET', `/api/invoices/${ID}/collection`],
      ['GET', `/api/invoices/${ID}/customer-loss`],
      ['GET', `/api/documents/${ID}/inline`],
      ['GET', '/api/documents'],
      ['GET', '/api/bookkeeping/accounts'],
      ['GET', '/api/import/sie/holds'],
      ['GET', '/api/reminders/overview'],
      ['GET', '/api/cash-accounts/payee-defaults'],
    ]) {
      expect(invoicerRouteAccess(method, path), `${method} ${path}`).toBeNull()
    }
  })

  it('refuses everything else', () => {
    expect(invoicerRouteAccess('GET', `/api/salary/runs/${ID}/underlag/pdf`)).toBeNull()
    expect(invoicerRouteAccess('POST', `/api/invoices/${ID}/mark-paid`)).toBeNull()
    expect(invoicerRouteAccess('POST', `/api/invoices/${ID}/link-to-voucher`)).toBeNull()
    expect(invoicerRouteAccess('GET', `/api/invoices/${ID}/voucher-candidates`)).toBeNull()
    expect(invoicerRouteAccess('GET', '/api/events')).toBeNull()
    expect(invoicerRouteAccess('GET', '/api/transactions')).toBeNull()
    expect(invoicerRouteAccess('PUT', '/api/settings')).toBeNull()
    expect(invoicerRouteAccess('DELETE', '/api/invoices/autogiro')).toBeNull()
    expect(invoicerRouteAccess('PATCH', '/api/invoices/not-a-uuid')).toBeNull()
    expect(invoicerRouteAccess('POST', `/api/invoices/${ID}/send/extra`)).toBeNull()
  })
})

describe('isInvoicerPagePath', () => {
  it('opens the invoicing pages and nothing else', () => {
    expect(isInvoicerPagePath('/invoices')).toBe(true)
    expect(isInvoicerPagePath(`/invoices/${ID}`)).toBe(true)
    expect(isInvoicerPagePath(`/invoices/${ID}/edit`)).toBe(true)
    expect(isInvoicerPagePath('/quotes')).toBe(true)
    expect(isInvoicerPagePath('/settings/account')).toBe(true)
    expect(isInvoicerPagePath('/')).toBe(false)
    expect(isInvoicerPagePath('/invoices/autogiro')).toBe(false)
    expect(isInvoicerPagePath('/invoices/settlements')).toBe(false)
    expect(isInvoicerPagePath('/salary')).toBe(false)
    expect(isInvoicerPagePath('/bookkeeping')).toBe(false)
    expect(isInvoicerPagePath('/settings/members')).toBe(false)
  })
})

describe('invoicerPageRedirect', () => {
  it('sends an invoicer from any other page to the invoices', () => {
    expect(invoicerPageRedirect('invoicer', '/')).toBe(INVOICER_HOME)
    expect(invoicerPageRedirect('invoicer', '/inkorg')).toBe(INVOICER_HOME)
    expect(invoicerPageRedirect('invoicer', '/settings/anpassa')).toBe(INVOICER_HOME)
    expect(invoicerPageRedirect('invoicer', '/invoices/autogiro')).toBe(INVOICER_HOME)
    // A lost pathname sends the role home, never further in.
    expect(invoicerPageRedirect('invoicer', '')).toBe(INVOICER_HOME)
  })

  it('lets an invoicer stay on the invoicing pages, so the redirect cannot loop', () => {
    expect(invoicerPageRedirect('invoicer', INVOICER_HOME)).toBeNull()
    expect(invoicerPageRedirect('invoicer', `/invoices/${ID}/edit`)).toBeNull()
    expect(invoicerPageRedirect('invoicer', '/customers')).toBeNull()
    expect(invoicerPageRedirect('invoicer', '/settings/account')).toBeNull()
  })

  it('never moves any other role', () => {
    for (const role of ['owner', 'admin', 'member', 'viewer', '', null, undefined]) {
      expect(invoicerPageRedirect(role, '/')).toBeNull()
      expect(invoicerPageRedirect(role, '/salary')).toBeNull()
    }
  })
})

describe('roleAllowsScope', () => {
  it('leaves every other role to its key scopes', () => {
    for (const role of ['owner', 'admin', 'member', 'viewer', undefined, null]) {
      expect(roleAllowsScope(role, 'payroll:read')).toBe(true)
      expect(roleAllowsScope(role, undefined)).toBe(true)
      expect(roleAllowsScope(role, 'authenticated')).toBe(true)
    }
  })

  it('limits the invoicer to customers, invoices and articles', () => {
    expect(roleAllowsScope('invoicer', 'invoices:write')).toBe(true)
    expect(roleAllowsScope('invoicer', 'customers:read')).toBe(true)
    expect(roleAllowsScope('invoicer', 'articles:write')).toBe(true)
    expect(roleAllowsScope('invoicer', 'payroll:read')).toBe(false)
    expect(roleAllowsScope('invoicer', 'reports:read')).toBe(false)
    expect(roleAllowsScope('invoicer', 'transactions:read')).toBe(false)
    expect(roleAllowsScope('invoicer', 'documents:read')).toBe(false)
    expect(roleAllowsScope('invoicer', 'events:read')).toBe(false)
    expect(roleAllowsScope('invoicer', 'webhooks:manage')).toBe(false)
    expect(roleAllowsScope('invoicer', 'authenticated')).toBe(false)
    expect(roleAllowsScope('invoicer', undefined)).toBe(false)
  })
})

describe('isBookkeepingWriterRole', () => {
  it('is owner, admin and member', () => {
    expect(['owner', 'admin', 'member', 'viewer', 'invoicer'].filter(isBookkeepingWriterRole)).toEqual([
      'owner',
      'admin',
      'member',
    ])
  })
})

describe('isAttestRole', () => {
  it('is those who keep the books and viewer, never invoicer (crm#1569)', () => {
    expect(['owner', 'admin', 'member', 'viewer', 'invoicer', null, undefined].filter(isAttestRole)).toEqual(['owner', 'admin', 'member', 'viewer'])
  })
})
