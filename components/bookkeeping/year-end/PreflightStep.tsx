'use client'

import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { QUIET_LINK_CLASS } from '@/components/ui/dry-table'
import { AlertTriangle, Info, XCircle } from 'lucide-react'
import Link from 'next/link'
import type { BokslutReadinessReport } from '@/lib/bokslut/readiness-aggregator'
import { BokslutChecklist } from './BokslutChecklist'

interface PreflightStepProps {
  report: BokslutReadinessReport | null
  isLoading: boolean
  error: string | null
  onContinue: () => void
}

/** A blocker as rendered: code is null for legacy responses without codes. */
interface DisplayBlocker {
  code: string | null
  message: string
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

  // A response cached from before blockerItems shipped only has the plain
  // strings: fall back so blockers never disappear, just without links.
  const blockerItems: DisplayBlocker[] =
    report.blockerItems ?? report.blockers.map((message) => ({ code: null, message }))

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

      {blockerItems.length > 0 && (
        <section>
          <SectionHead icon={<XCircle className="h-3.5 w-3.5 text-destructive" aria-hidden="true" />}>
            Måste åtgärdas innan bokslut
          </SectionHead>
          {blockerItems.map((blocker, i) => (
            <BlockerRow key={`${blocker.code ?? 'blocker'}-${i}`} blocker={blocker} />
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

      <BokslutChecklist periodId={report.period.id} />

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
 * Renders a blocker with a contextual action link derived from its stable
 * machine code (YearEndBlockerCode). Codes without an existing remediation
 * page (voucher gaps, sequence counter, period state) render as plain text:
 * a link must never point at a page that does not exist. UNBOOKED_CHECK_FAILED
 * is deliberately link-less too: the remedy is to re-run the check, not to
 * visit a page.
 */
function BlockerRow({ blocker }: { blocker: DisplayBlocker }) {
  let href: string | null = null
  let actionLabel: string | null = null

  if (blocker.code === 'DRAFT_ENTRIES') {
    // The verifikat list has its own Utkast tab; it does not read a status
    // query param, so the link goes to the plain list.
    href = '/bookkeeping'
    actionLabel = 'Visa utkast'
  } else if (blocker.code === 'UNBOOKED_TRANSACTIONS') {
    // Transaktionslistan is where an unbooked transaction is either booked or
    // marked private, the two remedies the message names.
    href = '/transactions'
    actionLabel = 'Visa transaktioner'
  } else if (blocker.code === 'TRIAL_BALANCE_UNBALANCED') {
    href = '/reports/trial-balance'
    actionLabel = 'Öppna saldobalansen'
  } else if (blocker.code === 'CONTINUITY_MISMATCH') {
    // Saldobalansen lists ingående och utgående saldo per konto: the closest
    // existing surface for reviewing IB against prior-year UB.
    href = '/reports/trial-balance'
    actionLabel = 'Granska ingående balans'
  }

  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-border/60 px-1 py-3 text-[13px] leading-5 last:border-b-0">
      <p className="flex-1">{blocker.message}</p>
      {href && actionLabel && (
        <Link href={href} className={QUIET_LINK_CLASS}>
          {actionLabel}
        </Link>
      )}
    </div>
  )
}
