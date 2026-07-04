'use client'

import * as React from 'react'
import { AlertCircle } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'

interface DataStateProps {
  loading: boolean
  error: string | null
  /** When true (and not loading/error), render `empty` instead of `children`. */
  isEmpty?: boolean
  /** Retry handler: typically `useFetch().refetch`. Shows a retry button. */
  onRetry?: () => void
  /** Loading placeholder. Defaults to three skeleton rows. */
  skeleton?: React.ReactNode
  /** Shown when `isEmpty`. Pass an `EmptyState` / preset (e.g. `<EmptyInvoices />`). */
  empty?: React.ReactNode
  children: React.ReactNode
  className?: string
}

/**
 * Renders the loading / error / empty / ready states for a data-driven section,
 * so callers stop hand-rolling that branch every time.
 *
 * Pairs with `useFetch`:
 *
 * @example
 * const { data, loading, error, refetch } = useFetch<Account[]>(url, { select: b => b.data })
 * return (
 *   <DataState
 *     loading={loading}
 *     error={error}
 *     onRetry={refetch}
 *     isEmpty={!data?.length}
 *     empty={<EmptyState title={t('none_title')} description={t('none_desc')} />}
 *   >
 *     <AccountsTable accounts={data!} />
 *   </DataState>
 * )
 *
 * Loading uses the `Skeleton` primitive; empty expects an `EmptyState`; the
 * error branch uses the only chrome-permitted semantic colour (`destructive`).
 */
export function DataState({
  loading,
  error,
  isEmpty = false,
  onRetry,
  skeleton,
  empty,
  children,
  className,
}: DataStateProps) {
  const t = useTranslations('common')

  if (loading) {
    return (
      <div className={className}>
        {skeleton ?? (
          <div className="space-y-3" aria-busy="true" aria-live="polite">
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-3/4" />
          </div>
        )}
      </div>
    )
  }

  if (error) {
    return (
      <div
        role="alert"
        className={cn('flex flex-col items-center justify-center py-12 px-4 text-center', className)}
      >
        <AlertCircle className="h-8 w-8 text-destructive mb-3" aria-hidden="true" />
        <p className="text-sm font-medium mb-1">{t('load_error')}</p>
        <p className="text-sm text-muted-foreground max-w-sm mb-6 text-balance">{error}</p>
        {onRetry && (
          <Button variant="outline" onClick={onRetry}>
            {t('retry')}
          </Button>
        )}
      </div>
    )
  }

  if (isEmpty) {
    return <div className={className}>{empty}</div>
  }

  return <>{children}</>
}
