'use client'

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { CheckCircle2, XCircle, ArrowRight, AlertTriangle } from 'lucide-react'
import Link from 'next/link'

export type RegisterResult = {
  success: boolean
  created: number
  updated: number
  skipped: number
  failed: number
  errors: { row_index: number; name: string; reason: string }[]
  /** Non-fatal notes (e.g. dropped revenue-account overrides on article import). */
  warnings?: string[]
}

interface RegisterResultStepProps {
  entity: 'customers' | 'suppliers' | 'articles'
  result: RegisterResult
  onNewImport: () => void
}

const ENTITY_COPY = {
  customers: {
    successTitle: 'Kunder importerade',
    failTitle: 'Importen misslyckades',
    listLabel: 'Visa alla kunder',
    listHref: '/customers',
  },
  suppliers: {
    successTitle: 'Leverantörer importerade',
    failTitle: 'Importen misslyckades',
    listLabel: 'Visa alla leverantörer',
    listHref: '/suppliers',
  },
  articles: {
    successTitle: 'Artiklar importerade',
    failTitle: 'Importen misslyckades',
    listLabel: 'Visa alla artiklar',
    listHref: '/articles',
  },
} as const

export default function RegisterResultStep({
  entity,
  result,
  onNewImport,
}: RegisterResultStepProps) {
  const copy = ENTITY_COPY[entity]
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
                ? 'Import slutförd med fel'
                : copy.failTitle}
          </CardTitle>
        </div>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* Stats */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <Stat label="Skapade" value={result.created} accent="success" />
          <Stat label="Uppdaterade" value={result.updated} accent="warning" />
          <Stat label="Hoppades över" value={result.skipped} />
          <Stat label="Misslyckades" value={result.failed} accent={result.failed > 0 ? 'destructive' : 'muted'} />
        </div>

        {totalProcessed === 0 && (
          <p className="text-sm text-muted-foreground">Inga rader bearbetades.</p>
        )}

        {/* Errors */}
        {result.errors.length > 0 && (
          <div className="space-y-2">
            <h4 className="text-sm font-medium">Rader som inte kunde importeras</h4>
            <div className="rounded-lg border border-destructive/30 bg-destructive/5 max-h-60 overflow-y-auto">
              <ul className="divide-y divide-destructive/20">
                {result.errors.map((e, i) => (
                  <li key={i} className="px-3 py-2 text-sm">
                    <span className="font-medium">Rad {e.row_index}: {e.name}</span>
                    <span className="text-muted-foreground">: {e.reason}</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        )}

        {/* Warnings (non-fatal: e.g. dropped revenue-account overrides) */}
        {result.warnings && result.warnings.length > 0 && (
          <div className="space-y-2">
            <h4 className="text-sm font-medium">Att notera</h4>
            <div className="rounded-lg border border-warning/30 bg-warning/5 px-4 py-3">
              <ul className="space-y-1 text-sm text-muted-foreground">
                {result.warnings.map((w, i) => (
                  <li key={i} className="flex items-start gap-2">
                    <AlertTriangle className="h-3.5 w-3.5 text-warning mt-0.5 shrink-0" />
                    <span>{w}</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        )}

        <div className="flex flex-wrap gap-3">
          <Button asChild>
            <Link href={copy.listHref}>
              {copy.listLabel}
              <ArrowRight className="h-4 w-4 ml-2" />
            </Link>
          </Button>
          <Button variant="ghost" onClick={onNewImport}>Ny import</Button>
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
