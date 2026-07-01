'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { Scale, ArrowRight } from 'lucide-react'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { formatCurrency } from '@/lib/utils'

interface ReconStatus {
  unmatched_transaction_count: number
  unmatched_gl_line_count: number
  difference: number
  is_reconciled: boolean
}

/**
 * Compact bankavstämning status for the Att hantera tab — surfaces the two
 * already-computed unmatched counts and the period-movement difference, with a
 * link into the full reconciliation view. Reads the whole-history status
 * (`GET /api/reconciliation/bank/status`, no date range); soft-fails to nothing
 * so it never blocks the queue below it.
 */
export function ReconciliationStatusStrip({ companyId }: { companyId: string | null }) {
  const t = useTranslations('transactions')
  const [status, setStatus] = useState<ReconStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    if (!companyId) return
    let cancelled = false
    setLoading(true)
    setFailed(false)
    ;(async () => {
      try {
        const res = await fetch('/api/reconciliation/bank/status')
        if (!res.ok) throw new Error()
        const { data } = await res.json()
        if (!cancelled) setStatus(data)
      } catch {
        if (!cancelled) setFailed(true)
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [companyId])

  if (!companyId || failed) return null
  if (loading) return <Skeleton className="h-16 w-full rounded-lg" />
  if (!status) return null

  const clean =
    status.is_reconciled &&
    status.unmatched_transaction_count === 0 &&
    status.unmatched_gl_line_count === 0

  return (
    <Card>
      <CardContent className="flex flex-wrap items-center justify-between gap-4 p-4">
        <div className="flex items-center gap-3">
          <Scale className="h-4 w-4 text-muted-foreground" />
          <span className="text-sm font-medium">{t('recon_title')}</span>
          {clean && <Badge variant="success">{t('recon_reconciled')}</Badge>}
        </div>
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
          <Metric value={status.unmatched_transaction_count} label={t('recon_unmatched_tx')} />
          <Metric value={status.unmatched_gl_line_count} label={t('recon_unmatched_vouchers')} />
          <div className="text-sm">
            <span className="text-muted-foreground">{t('recon_difference')} </span>
            <span className="tabular-nums font-medium">{formatCurrency(status.difference)}</span>
          </div>
          <Link
            href="/reports/bank-reconciliation"
            className="inline-flex items-center gap-1 text-sm text-foreground hover:underline"
          >
            {t('recon_open')} <ArrowRight className="h-3.5 w-3.5" />
          </Link>
        </div>
      </CardContent>
    </Card>
  )
}

function Metric({ value, label }: { value: number; label: string }) {
  return (
    <div className="text-sm">
      <span className="tabular-nums font-medium">{value}</span>{' '}
      <span className="text-muted-foreground">{label}</span>
    </div>
  )
}
