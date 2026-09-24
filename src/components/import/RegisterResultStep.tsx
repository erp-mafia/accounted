'use client'

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { CheckCircle2, XCircle, ArrowRight, AlertTriangle } from 'lucide-react'
import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { ImportNotices } from '@/components/import/ImportNotices'
import { resolveNotices, type ImportNotice } from '@/lib/import/notices'

export type RegisterResult = {
  success: boolean
  created: number
  updated: number
  skipped: number
  failed: number
  errors: { row_index: number; name: string; reason: string }[]
  /** Non-fatal notes (e.g. dropped revenue-account overrides on article import). */
  warnings?: string[]
  /** Structured twins of `warnings` (lib/import/notices.ts). */
  notices?: ImportNotice[]
}

interface RegisterResultStepProps {
  entity: 'customers' | 'suppliers' | 'articles'
  result: RegisterResult
  onNewImport: () => void
}

const LIST_HREF = {
  customers: '/customers',
  suppliers: '/suppliers',
  articles: '/articles',
} as const

export default function RegisterResultStep({
  entity,
  result,
  onNewImport,
}: RegisterResultStepProps) {
  const t = useTranslations('register_result_step')
  const copy = {
    successTitle:
      entity === 'customers'
        ? t('customers_success')
        : entity === 'suppliers'
          ? t('suppliers_success')
          : t('articles_success'),
    failTitle: t('fail_title'),
    listLabel:
      entity === 'customers'
        ? t('customers_list')
        : entity === 'suppliers'
          ? t('suppliers_list')
          : t('articles_list'),
    listHref: LIST_HREF[entity],
  }
  const totalProcessed = result.created + result.updated + result.skipped + result.failed
  const isPartial = result.failed > 0 && result.created + result.updated > 0

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-3">
          {result.success ? (
            <CheckCircle2 className="h-6 w-6 text-success" />
          ) : isPartial ? (
            <AlertTriangle className="h-6 w-6 text-warning" />
          ) : (
            <XCircle className="h-6 w-6 text-destructive" />
          )}
          <CardTitle>
            {result.success
              ? copy.successTitle
              : isPartial
                ? t('partial_title')
                : copy.failTitle}
          </CardTitle>
        </div>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* Stats */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <Stat label={t('stat_created')} value={result.created} accent="success" />
          <Stat label={t('stat_updated')} value={result.updated} accent="warning" />
          <Stat label={t('stat_skipped')} value={result.skipped} />
          <Stat label={t('stat_failed')} value={result.failed} accent={result.failed > 0 ? 'destructive' : 'muted'} />
        </div>

        {totalProcessed === 0 && (
          <p className="text-sm text-muted-foreground">{t('no_rows')}</p>
        )}

        {/* Errors */}
        {result.errors.length > 0 && (
          <div className="space-y-2">
            <h4 className="text-sm font-medium">{t('failed_rows')}</h4>
            <div className="rounded-lg border border-destructive/30 bg-destructive/5 max-h-60 overflow-y-auto">
              <ul className="divide-y divide-destructive/20">
                {result.errors.map((e, i) => (
                  <li key={i} className="px-3 py-2 text-sm">
                    <span className="font-medium">{t('row_label', { row: e.row_index, name: e.name })}</span>
                    <span className="text-muted-foreground">: {e.reason}</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        )}

        {/* Non-fatal notes (e.g. dropped revenue-account overrides): one
            sentence if something needs a hand, the rest folded. */}
        <ImportNotices notices={resolveNotices(result)} />

        <div className="flex flex-wrap gap-3">
          <Button asChild>
            <Link href={copy.listHref}>
              {copy.listLabel}
              <ArrowRight className="h-4 w-4 ml-2" />
            </Link>
          </Button>
          <Button variant="ghost" onClick={onNewImport}>{t('new_import')}</Button>
        </div>
      </CardContent>
    </Card>
  )
}

function Stat({
  label,
  value,
  accent,
}: {
  label: string
  value: number
  accent?: 'success' | 'warning' | 'destructive' | 'muted'
}) {
  return (
    <div className="rounded-lg border bg-muted/30 p-4 text-center">
      <p
        className={
          accent === 'success' ? 'text-2xl font-semibold tabular-nums text-success' :
          accent === 'warning' ? 'text-2xl font-semibold tabular-nums text-warning' :
          accent === 'destructive' ? 'text-2xl font-semibold tabular-nums text-destructive' :
          'text-2xl font-semibold tabular-nums'
        }
      >
        {value}
      </p>
      <p className="text-sm text-muted-foreground mt-1">{label}</p>
    </div>
  )
}
