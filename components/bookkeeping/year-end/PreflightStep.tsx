'use client'

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { CheckCircle2, AlertTriangle, XCircle, Info } from 'lucide-react'
import Link from 'next/link'
import type { BokslutReadinessReport } from '@/lib/bokslut/readiness-aggregator'

interface PreflightStepProps {
  report: BokslutReadinessReport | null
  isLoading: boolean
  error: string | null
  onContinue: () => void
}

export function PreflightStep({ report, isLoading, error, onContinue }: PreflightStepProps) {
  if (isLoading) {
    return (
      <Card>
        <CardContent className="p-6 space-y-3">
          <Skeleton className="h-6 w-1/3" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-3/4" />
          <Skeleton className="h-4 w-2/3" />
        </CardContent>
      </Card>
    )
  }

  if (error) {
    return (
      <Card>
        <CardContent className="p-6">
          <p className="text-destructive">{error}</p>
        </CardContent>
      </Card>
    )
  }

  if (!report) {
    return null
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between gap-4">
            <div>
              <CardTitle className="text-base">{report.period.name}</CardTitle>
              <p className="text-sm text-muted-foreground tabular-nums">
                {report.period.period_start}: {report.period.period_end}
              </p>
            </div>
            {report.ready ? (
              <Badge variant="success" className="gap-1">
                <CheckCircle2 className="h-3.5 w-3.5" /> Redo för bokslut
              </Badge>
            ) : (
              <Badge variant="destructive" className="gap-1">
                <XCircle className="h-3.5 w-3.5" /> Inte redo
              </Badge>
            )}
          </div>
        </CardHeader>
      </Card>

      {report.blockers.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <XCircle className="h-4 w-4 text-destructive" />
              Måste åtgärdas innan bokslut
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {report.blockers.map((blocker, i) => (
              <BlockerRow key={i} blocker={blocker} report={report} />
            ))}
          </CardContent>
        </Card>
      )}

      {report.warnings.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-warning-foreground" />
              Varningar
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {report.warnings.map((warning, i) => (
              <p key={i} className="text-sm">
                {warning}
              </p>
            ))}
          </CardContent>
        </Card>
      )}

      {report.reminders.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <Info className="h-4 w-4 text-muted-foreground" />
              Påminnelser
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {report.reminders.map((reminder) => (
              <div key={reminder.code} className="flex items-start gap-3 text-sm">
                <span className="mt-1 h-1.5 w-1.5 rounded-full bg-muted-foreground shrink-0" />
                <div className="flex-1">
                  <p>{reminder.message}</p>
                  {reminder.href && (
                    <Link
                      href={reminder.href}
                      className="text-xs text-primary hover:underline"
                    >
                      Öppna
                    </Link>
                  )}
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      <div className="flex justify-end">
        <Button onClick={onContinue} disabled={!report.ready}>
          Fortsätt
        </Button>
      </div>
    </div>
  )
}

/**
 * Renders a blocker with a contextual action link when we can derive one.
 * Falls back to plain text otherwise.
 */
function BlockerRow({ blocker, report }: { blocker: string; report: BokslutReadinessReport }) {
  let href: string | null = null
  let actionLabel: string | null = null

  if (/draft journal entries/i.test(blocker) && report.draftCount > 0) {
    href = '/bookkeeping?status=draft'
    actionLabel = 'Visa utkast'
  } else if (/voucher gap/i.test(blocker)) {
    href = '/bookkeeping/voucher-gaps'
    actionLabel = 'Hantera nummerlucka'
  } else if (/trial balance/i.test(blocker)) {
    href = '/reports/trial-balance'
    actionLabel = 'Öppna balansrapport'
  } else if (/continuity/i.test(blocker)) {
    href = '/bookkeeping'
    actionLabel = 'Granska ingående balans'
  }

  return (
    <div className="flex items-start justify-between gap-3 text-sm">
      <p className="flex-1">{blocker}</p>
      {href && actionLabel && (
        <Link href={href} className="text-xs text-primary hover:underline shrink-0 mt-0.5">
          {actionLabel}
        </Link>
      )}
    </div>
  )
}
