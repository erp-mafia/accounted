'use client'

import { createContext, useContext, type ReactNode } from 'react'

/**
 * Which list the shared invoice list component is rendering. A quote is not
 * an invoice (founder direction 2026-09-12): /quotes gets its own page, nav
 * row and status views, but the table, search, fiscal-year scope, grouping
 * and dialogs are the same component. The variant rides in a context so the
 * page module keeps Next's plain default export.
 */
export type InvoiceListVariant = 'invoices' | 'quotes'

const InvoiceListVariantContext = createContext<InvoiceListVariant>('invoices')

export function InvoiceListVariantProvider({
  variant,
  children,
}: {
  variant: InvoiceListVariant
  children: ReactNode
}) {
  return (
    <InvoiceListVariantContext.Provider value={variant}>{children}</InvoiceListVariantContext.Provider>
  )
}

export function useInvoiceListVariant(): InvoiceListVariant {
  return useContext(InvoiceListVariantContext)
}
