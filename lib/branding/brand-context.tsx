'use client'

/**
 * Per-request brand context (WL-12 slice A2).
 *
 * The root layout resolves the brand from the request host and provides its
 * client-safe subset here. `useBranding()` is the client-side migration
 * target for `getBranding()` call sites: it returns the brand merged over the
 * sync defaults, and plain `getBranding()` values when the host has no brand,
 * so an un-migrated call site and a migrated one agree on default hosts.
 *
 * Server components do not use this: they call `resolveBrandByHost()` (or the
 * layout's already-resolved brand) directly.
 */

import { createContext, useContext, useMemo, type ReactNode } from 'react'
import { getBranding } from './service'
import {
  mergeClientBranding,
  type ClientBranding,
  type PublicBrand,
} from './public-brand'

const BrandContext = createContext<PublicBrand | null>(null)

export function BrandProvider({
  brand,
  children,
}: {
  brand: PublicBrand | null
  children: ReactNode
}) {
  return <BrandContext.Provider value={brand}>{children}</BrandContext.Provider>
}

/**
 * The active branding for client components: per-request brand values merged
 * over `getBranding()` defaults, falling back to plain defaults when the
 * request host serves no brand.
 */
export function useBranding(): ClientBranding {
  const brand = useContext(BrandContext)
  return useMemo(() => mergeClientBranding(getBranding(), brand), [brand])
}
