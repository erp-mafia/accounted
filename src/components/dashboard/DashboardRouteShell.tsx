'use client'

import { usePathname } from 'next/navigation'
import type { ReactNode } from 'react'
import { BOOKS_PATH } from '@/lib/onboarding/books-gate'

/** Shared layouts persist across navigation, so chrome follows the live route. */
export function DashboardRouteShell({
  children,
  onboarding,
}: {
  children: ReactNode
  onboarding: ReactNode
}) {
  const pathname = usePathname()
  const isBooksOnboarding = pathname === BOOKS_PATH || pathname.startsWith(`${BOOKS_PATH}/`)

  return isBooksOnboarding ? onboarding : children
}
