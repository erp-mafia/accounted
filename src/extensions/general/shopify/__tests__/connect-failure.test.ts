import { describe, it, expect } from 'vitest'
import { ShopifyApiError, ShopifyConnectError } from '../lib/api-client'
import { connectFailureMessage, connectFailureStatus } from '../lib/connect-failure'

const SHOP = 'minbutik.myshopify.com'
const denied = new ShopifyApiError('Shopify GraphQL error: Access denied for orders field.', 403, 'ACCESS_DENIED')

describe('connectFailureMessage', () => {
  it('tells a store that never approved read_orders to approve it there, and lists what it has (PH 161)', () => {
    const message = connectFailureMessage(
      new ShopifyConnectError('orders_scope_not_granted', denied, ['read_products', 'read_customers']),
      SHOP,
    )
    expect(message).toContain('har inte godkänt behörigheten read_orders')
    expect(message).toContain('Godkänt på butiken nu: read_products, read_customers.')
    expect(message).toContain('ny appversion')
    expect(message).toContain('avinstallera appen och installera den igen')
    expect(message).toContain(SHOP)
  })

  it('says so when the store granted nothing', () => {
    const message = connectFailureMessage(new ShopifyConnectError('orders_scope_not_granted', denied, []), SHOP)
    expect(message).toContain('Butiken har inte godkänt någon behörighet för appen.')
  })

  it('names protected customer data when read_orders is granted yet refused', () => {
    const message = connectFailureMessage(
      new ShopifyConnectError('orders_protected_data', denied, ['read_orders']),
      SHOP,
    )
    expect(message).toContain('Protected customer data access')
    expect(message).not.toContain('har inte godkänt behörigheten read_orders')
  })

  it('gives one actionable sentence per token exchange cause', () => {
    const base = new ShopifyApiError('Shopify token exchange 400', 401)
    expect(connectFailureMessage(new ShopifyConnectError('app_not_installed', base), SHOP)).toContain(
      'Appen är inte installerad i butiken',
    )
    expect(connectFailureMessage(new ShopifyConnectError('other_organization', base), SHOP)).toContain(
      'olika organisationer',
    )
    expect(connectFailureMessage(new ShopifyConnectError('credentials_rejected', base), SHOP)).toContain(
      'godtog inte klient-ID och klienthemlighet',
    )
    expect(connectFailureMessage(new ShopifyConnectError('orders_access_denied', denied), SHOP)).toContain(
      'read_orders',
    )
    expect(connectFailureMessage(new ShopifyConnectError('unreachable', base), SHOP)).toContain(
      'Kunde inte nå butiken',
    )
  })

  it('keeps the old generic sentence for anything that is not a classified connect failure', () => {
    expect(connectFailureMessage(new Error('boom'), SHOP)).toContain('Kontrollera adressen')
  })

  it('never uses an em or en dash', () => {
    const kinds = [
      'app_not_installed',
      'other_organization',
      'credentials_rejected',
      'orders_scope_not_granted',
      'orders_protected_data',
      'orders_access_denied',
      'unreachable',
    ] as const
    for (const kind of kinds) {
      expect(connectFailureMessage(new ShopifyConnectError(kind, denied, ['read_products']), SHOP)).not.toMatch(
        /[–—]/,
      )
    }
  })
})

describe('connectFailureStatus', () => {
  it('is 502 only when Shopify could not be reached', () => {
    expect(connectFailureStatus(new ShopifyConnectError('unreachable', new Error('x')))).toBe(502)
    expect(connectFailureStatus(new ShopifyConnectError('orders_scope_not_granted', denied, []))).toBe(400)
    expect(connectFailureStatus(new Error('x'))).toBe(400)
  })
})
