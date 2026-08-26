import { describe, it, expect } from 'vitest'
import { deriveSupplierInvoiceDefaults } from '../supplier-invoice-defaults'
import type { CompanySettings } from '@/types'

const settings = (overrides: Record<string, unknown>) => overrides as unknown as CompanySettings

describe('deriveSupplierInvoiceDefaults', () => {
  it('uses registered-company defaults while settings are missing', () => {
    expect(deriveSupplierInvoiceDefaults(null)).toEqual({
      entityType: 'enskild_firma',
      accountingMethod: 'accrual',
      oreRounding: true,
      dimensionsEnabled: false,
      vatRegistered: true,
    })
    expect(deriveSupplierInvoiceDefaults(undefined, 'aktiebolag').entityType).toBe('aktiebolag')
  })

  it('reads every gate from the settings row', () => {
    expect(
      deriveSupplierInvoiceDefaults(
        settings({
          entity_type: 'aktiebolag',
          accounting_method: 'cash',
          ore_rounding: false,
          dimensions_enabled: true,
          vat_registered: false,
        }),
      ),
    ).toEqual({
      entityType: 'aktiebolag',
      accountingMethod: 'cash',
      oreRounding: false,
      dimensionsEnabled: true,
      vatRegistered: false,
    })
  })

  it('only an explicit vat_registered=false gates VAT; null keeps the registered behaviour', () => {
    expect(deriveSupplierInvoiceDefaults(settings({ vat_registered: null })).vatRegistered).toBe(true)
    expect(deriveSupplierInvoiceDefaults(settings({})).vatRegistered).toBe(true)
  })

  it('falls back to the company entity type only when the settings row has none', () => {
    expect(deriveSupplierInvoiceDefaults(settings({ entity_type: null }), 'aktiebolag').entityType).toBe('aktiebolag')
    expect(deriveSupplierInvoiceDefaults(settings({ entity_type: 'enskild_firma' }), 'aktiebolag').entityType).toBe(
      'enskild_firma',
    )
  })

  it('treats an unknown accounting method or non-boolean rounding as the defaults', () => {
    const d = deriveSupplierInvoiceDefaults(settings({ accounting_method: 'weird', ore_rounding: 'yes' }))
    expect(d.accountingMethod).toBe('accrual')
    expect(d.oreRounding).toBe(true)
  })
})
