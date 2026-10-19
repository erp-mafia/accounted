import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { OVERDUE_CHIP } from '@/lib/status-display'
import { INVOICE_STATUSES, invoiceStatusDisplay } from '@/lib/invoices/status-display'
import {
  SUPPLIER_INVOICE_STATUSES,
  supplierInvoiceStatusDisplay,
} from '@/lib/supplier-invoices/status-display'
import { SALARY_RUN_STATUSES, salaryRunStatusDisplay } from '@/lib/salary/run-status-display'

const catalog = (locale: 'sv' | 'en') =>
  JSON.parse(fs.readFileSync(path.resolve(__dirname, `../../messages/${locale}.json`), 'utf8')) as Record<
    string,
    Record<string, unknown>
  >

const HELPERS = [
  { name: 'invoice', namespace: 'invoices', statuses: INVOICE_STATUSES, display: invoiceStatusDisplay },
  {
    name: 'supplier invoice',
    namespace: 'supplier_invoices',
    statuses: SUPPLIER_INVOICE_STATUSES,
    display: supplierInvoiceStatusDisplay,
  },
  { name: 'salary run', namespace: 'salary', statuses: SALARY_RUN_STATUSES, display: salaryRunStatusDisplay },
] as const

describe.each(HELPERS)('$name status display', ({ namespace, statuses, display }) => {
  it.each(['sv', 'en'] as const)('names every status with a label in %s', (locale) => {
    const messages = catalog(locale)[namespace]
    for (const status of statuses) {
      const d = display(status)
      expect(d, status).not.toBeNull()
      expect(typeof messages[d!.labelKey], `${namespace}.${d!.labelKey}`).toBe('string')
    }
  })

  it('answers null for a status it does not know', () => {
    expect(display('not_a_status')).toBeNull()
  })
})

describe('the shared rules', () => {
  it('gives "Förfallen" one colour on both invoice kinds', () => {
    expect(invoiceStatusDisplay('overdue')?.chip).toBe(OVERDUE_CHIP)
    expect(supplierInvoiceStatusDisplay('overdue')?.chip).toBe(OVERDUE_CHIP)
  })

  it('keeps the normal path as muted text (chips mark exceptions)', () => {
    expect(invoiceStatusDisplay('sent')?.chip).toBeNull()
    expect(invoiceStatusDisplay('paid')?.chip).toBeNull()
    expect(supplierInvoiceStatusDisplay('approved')?.chip).toBeNull()
    expect(supplierInvoiceStatusDisplay('paid')?.chip).toBeNull()
    expect(salaryRunStatusDisplay('paid')?.chip).toBeNull()
    expect(salaryRunStatusDisplay('booked')?.chip).toBeNull()
  })

  it('calls an approved supplier invoice attesterad', () => {
    expect(catalog('sv').supplier_invoices.status_approved).toBe('Attesterad')
  })
})

describe('registered supplier invoices and attest', () => {
  it('keeps the attest chip where attest is the gate (the default)', () => {
    expect(supplierInvoiceStatusDisplay('registered')).toEqual({ labelKey: 'status_registered', chip: 'outline' })
    expect(supplierInvoiceStatusDisplay('registered', { attests: true })).toEqual({
      labelKey: 'status_registered',
      chip: 'outline',
    })
  })

  it('reads as muted "Att betala" for a company that never attests', () => {
    const display = supplierInvoiceStatusDisplay('registered', { attests: false })
    expect(display).toEqual({ labelKey: 'status_registered_to_pay', chip: null })
    expect(catalog('sv').supplier_invoices[display!.labelKey]).toBe('Att betala')
    expect(typeof catalog('en').supplier_invoices[display!.labelKey]).toBe('string')
  })

  it('leaves every other status alone when the company does not attest', () => {
    for (const status of SUPPLIER_INVOICE_STATUSES.filter((s) => s !== 'registered')) {
      expect(supplierInvoiceStatusDisplay(status, { attests: false }), status).toEqual(
        supplierInvoiceStatusDisplay(status),
      )
    }
  })
})

/*
 * Every surface reads these helpers: no page keeps its own status-to-label or
 * status-to-variant map for these three records. The maps this replaced were
 * EXCEPTION_STATUS_VARIANTS (three copies), STATUS_VARIANTS (three copies),
 * INVOICE_STATUS_BADGE and the per-page label maps.
 */
describe('no local status maps', () => {
  const root = path.resolve(__dirname, '../../')
  const files = [
    'app/(dashboard)/supplier-invoices/page.tsx',
    'app/(dashboard)/supplier-invoices/[id]/page.tsx',
    'app/(dashboard)/suppliers/[id]/page.tsx',
    'app/(dashboard)/salary/page.tsx',
    'app/(dashboard)/salary/runs/[id]/employees/[employeeId]/page.tsx',
    'components/salary/run/RunHeader.tsx',
    'app/(dashboard)/sales-orders/[id]/page.tsx',
  ]
  it.each(files)('%s', (rel) => {
    const src = fs.readFileSync(path.join(root, rel), 'utf8')
    expect(src).not.toMatch(/\b(EXCEPTION_STATUS_VARIANTS|STATUS_VARIANTS|INVOICE_STATUS_BADGE|INVOICE_STATUS_LABEL_KEY|MUTED_STATUSES)\b/)
  })
})
