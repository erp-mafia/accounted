import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import sv from '@/messages/sv.json'
import en from '@/messages/en.json'

/**
 * The Kundorder switch (company_settings.sales_orders_enabled) sits under
 * Inställningar > Fakturering, beside the invoice types, because its menu
 * row lives under Fakturering. Under Bokföring > Automation a customer who
 * had created orders through the API could not find it (crm#1513).
 */

const SECTIONS = join(__dirname, '..', 'sections')
const read = (file: string) => readFileSync(join(SECTIONS, file), 'utf8')
const TOGGLE = /<NavGateToggle\s+setting="sales_orders_enabled"/

describe('the Kundorder switch placement (crm#1513)', () => {
  it('renders under Fakturering, once', () => {
    expect(read('InvoicingSettingsContent.tsx').match(new RegExp(TOGGLE, 'g'))).toHaveLength(1)
  })

  it('no longer renders under Bokföring', () => {
    expect(read('BookkeepingSettingsContent.tsx')).not.toMatch(TOGGLE)
  })

  it('is found by the settings search under Fakturering, in both languages', () => {
    expect(sv.settings_nav.keywords_invoicing).toContain('Kundorder')
    expect(sv.settings_nav.keywords_bookkeeping).not.toContain('Kundorder')
    expect(en.settings_nav.keywords_invoicing).toContain('Sales orders')
    expect(en.settings_nav.keywords_bookkeeping).not.toContain('Sales orders')
  })

  it('says what is not built yet: order confirmations to the customer', () => {
    expect(sv.sales_orders.settings_toggle_help).toContain('Orderbekräftelser kan inte skickas')
    expect(en.sales_orders.settings_toggle_help).toContain('Order confirmations cannot be sent')
  })
})
