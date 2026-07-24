'use client'

import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { QUIET_LINK_CLASS } from '@/components/ui/dry-table'
import { AlertTriangle, Info, XCircle } from 'lucide-react'
import Link from 'next/link'
import type { BokslutReadinessReport } from '@/lib/bokslut/readiness-aggregator'

interface PreflightStepProps {
  report: BokslutReadinessReport | null
  isLoading: boolean
  error: string | null
  onContinue: () => void
}

/** Sans eyebrow section head with a trailing hairline (house idiom). */
function SectionHead({ icon, children }: { icon?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="mb-1 flex items-center gap-2 px-1">
      {icon}
      <h3 className="font-sans text-xs font-medium uppercase tracking-wider text-muted-foreground">
        {children}
      </h3>
      <div className="h-px flex-1 bg-border/60" />
    </div>
  )
}

export function PreflightStep({ report, isLoading, error, onContinue }: PreflightStepProps) {
  if (isLoading) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-6 w-1/3" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-3/4" />
        <Skeleton className="h-4 w-2/3" />
      </div>
    )
  }

  if (error) {
    return <p className="py-4 text-sm text-destructive">{error}</p>
  }

  if (!report) {
    return null
  }

  return (
    <div className="space-y-8">
      {/* Period line: muted text for the normal state, chip only when the
          period deviates (design.md: chips mark exceptions). */}
      <div className="flex flex-wrap items-baseline justify-between gap-3 px-1">
        <div className="flex items-baseline gap-3">
          <h2 className="font-sans text-sm font-medium">{report.period.name}</h2>
          <span className="text-xs tabular-nums text-muted-foreground">
            {report.period.period_start} till {report.period.period_end}
          </span>
        </div>
        {report.ready ? (
          <span className="text-xs text-muted-foreground">Redo för bokslut</span>
        ) : (
          <Badge variant="destructive" className="font-normal">Inte redo</Badge>
        )}
      </div>

      {report.blockers.length > 0 && (
        <section>
          <SectionHead icon={<XCircle className="h-3.5 w-3.5 text-destructive" aria-hidden="true" />}>
            Måste åtgärdas innan bokslut
          </SectionHead>
          {report.blockers.map((blocker, i) => (
            <BlockerRow key={i} blocker={blocker} report={report} />
          ))}
        </section>
      )}

      {report.warnings.length > 0 && (
        <section>
          <SectionHead icon={<AlertTriangle className="h-3.5 w-3.5 text-attn" aria-hidden="true" />}>
            Varningar
          </SectionHead>
          {report.warnings.map((warning, i) => (
            <p key={i} className="border-b border-border/60 px-1 py-3 text-[13px] leading-5 last:border-b-0">
              {warning}
            </p>
          ))}
        </section>
      )}

      {report.reminders.length > 0 && (
        <section>
          <SectionHead icon={<Info className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />}>
            Påminnelser
          </SectionHead>
          {report.reminders.map((reminder) => (
            <div
              key={reminder.code}
              className="flex items-baseline justify-between gap-3 border-b border-border/60 px-1 py-3 text-[13px] leading-5 text-muted-foreground last:border-b-0"
            >
              <p className="flex-1">{reminder.message}</p>
              {reminder.href && (
                <Link href={reminder.href} className={QUIET_LINK_CLASS}>
                  Öppna
                </Link>
              )}
            </div>
          ))}
        </section>
      )}

      <div className="flex justify-end">
        <Button variant="outline" size="sm" onClick={onContinue} disabled={!report.ready}>
          Nästa: Periodiseringar →
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
    <div className="flex items-baseline justify-between gap-3 border-b border-border/60 px-1 py-3 text-[13px] leading-5 last:border-b-0">
      <p className="flex-1">{blocker}</p>
      {href && actionLabel && (
        <Link href={href} className={QUIET_LINK_CLASS}>
          {actionLabel}
        </Link>
      )}
    </div>
  )
}
