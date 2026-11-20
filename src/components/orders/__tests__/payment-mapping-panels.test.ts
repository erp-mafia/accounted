import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, it, expect } from 'vitest'

const root = path.resolve(__dirname, '../../../..')
const read = (rel: string) => readFileSync(path.join(root, rel), 'utf8')

/**
 * The payment-method mapping is platform-neutral (settings route, booking
 * prefill, bulk sweep and day booking all read webshop_store_settings by
 * platform + store_scope), so every webshop panel offers the form, keyed by
 * the same store scope the sync writes on the orders (crm#1701). The scope
 * helpers themselves (zettleStoreScope, shopifyShopScope: the identity) are
 * tested in each extension's order-sync test; core may not import them.
 */
describe('payment-method mapping form in the webshop settings panels', () => {
  it.each([
    ['woocommerce', 'src/extensions/general/woocommerce/components/WooCommerceSettingsPanel.tsx'],
    ['zettle', 'src/extensions/general/zettle/components/ZettleSettingsPanel.tsx'],
    ['shopify', 'src/extensions/general/shopify/components/ShopifySettingsPanel.tsx'],
  ])('%s panel mounts PaymentMethodMappingForm for its own platform', (platform, file) => {
    const source = read(file)
    expect(source).toContain(`<PaymentMethodMappingForm platform="${platform}"`)
  })

  it('Zettle keys the form by organization_uuid, the scope its sync writes', () => {
    expect(read('src/extensions/general/zettle/components/ZettleSettingsPanel.tsx')).toContain(
      'storeScope={c.organization_uuid}',
    )
  })

  it('Shopify keys the form by shop_domain, the scope its sync writes', () => {
    expect(read('src/extensions/general/shopify/components/ShopifySettingsPanel.tsx')).toContain(
      '<PaymentMethodMappingForm platform="shopify" storeScope={c.shop_domain} />',
    )
  })
})
