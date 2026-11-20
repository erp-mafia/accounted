'use client'

import { Button } from '@/components/ui/button'
import { StepBar } from '@/components/ui/step-bar'
import { Badge } from '@/components/ui/badge'
import { Skeleton, LateReveal } from '@/components/ui/skeleton'
import { LoadError } from '@/components/ui/empty-state'
import { QUIET_LINK_CLASS } from '@/components/ui/dry-table'
import { ExclamationTriangleIcon, InformationCircleIcon, XCircleIcon } from '@/components/icons'
import Link from 'next/link'
import { useTranslations } from 'next-intl'
import type { BokslutReadinessReport } from '@/lib/bokslut/readiness-aggregator'
import { BokslutChecklist } from './BokslutChecklist'
import { K3TransitionCard } from './K3TransitionCard'

interface PreflightStepProps {
  report: BokslutReadinessReport | null
  isLoading: boolean
  error: string | null
  /** Runs the readiness check again after a failed load. */
  onRetry: () => void
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
      <h3 className="font-sans text-xs font-medium text-muted-foreground">
        {children}
      </h3>
      <div className="h-px flex-1 bg-border/60" />
    </div>
  )
}

export function PreflightStep({ report, isLoading, error, onRetry, onContinue }: PreflightStepProps) {
  if (isLoading) {
    return (
      <LateReveal className="space-y-3">
        <Skeleton className="h-6 w-1/3" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-3/4" />
        <Skeleton className="h-4 w-2/3" />
      </LateReveal>
    )
  }

  if (error) {
    return <LoadError title={error} onRetry={onRetry} />
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
      {/* Readiness: muted text for the normal state, chip only when the
          period deviates (chips mark exceptions). The period
          itself is named by the picker in the top bar, so no second title. */}
      <div className="px-1">
        {report.ready ? (
          <span className="text-xs text-muted-foreground">Redo för bokslut</span>
        ) : (
          <Badge variant="destructive" className="font-normal">Inte redo</Badge>
        )}
      </div>

      {blockerItems.length > 0 && (
        <section>
          <SectionHead icon={<XCircleIcon className="h-3.5 w-3.5 text-destructive" aria-hidden="true" />}>
            Måste åtgärdas innan bokslut
          </SectionHead>
          {blockerItems.map((blocker, i) => (
            <BlockerRow
              key={`${blocker.code ?? 'blocker'}-${i}`}
              blocker={blocker}
              periodId={report.period.id}
            />
          ))}
        </section>
      )}

      {report.warnings.length > 0 && (
        <section>
          <SectionHead icon={<ExclamationTriangleIcon className="h-3.5 w-3.5 text-attn" aria-hidden="true" />}>
            Varningar
          </SectionHead>
          {report.warnings.map((warning, i) => (
            <p key={i} className="border-b-hairline px-1 py-3 text-[13px] leading-5 last:border-b-0">
              {warning}
            </p>
          ))}
        </section>
      )}

      <K3TransitionCard periodId={report.period.id} />

      <BokslutChecklist periodId={report.period.id} />

      {report.reminders.length > 0 && (
        <section>
          <SectionHead icon={<InformationCircleIcon className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />}>
            Påminnelser
          </SectionHead>
          {report.reminders.map((reminder) => (
            <div
              key={reminder.code}
              className="flex items-baseline justify-between gap-3 border-b-hairline px-1 py-3 text-[13px] leading-5 text-muted-foreground last:border-b-0"
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

      <StepBar>
        <Button onClick={onContinue} disabled={!report.ready}>
          Nästa: Periodiseringar
        </Button>
      </StepBar>
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
/**
 * One blocker line with its remediation link, where a surface exists for the
 * remedy. periodId scopes links into period-oriented lists (the verifikat
 * list's gap rows) to the räkenskapsår this preflight is for.
 */
function BlockerRow({ blocker, periodId }: { blocker: DisplayBlocker; periodId: string }) {
  const t = useTranslations('year_end_preflight')
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
  } else if (blocker.code === 'UNEXPLAINED_VOUCHER_GAP') {
    // The verifikat list shows every gap of the year above the table with the
    // Förklara action; the param scopes the list to this räkenskapsår.
    href = `/bookkeeping?gaps=${periodId}`
    actionLabel = 'Förklara luckan'
  } else if (blocker.code === 'COMPANY_LOCK_DATE') {
    // Periodlåsning there holds both the lock date and automatic locking,
    // the two things the message says to change.
    href = '/settings/bookkeeping'
    actionLabel = t('open_bookkeeping_settings')
  }

  return (
    <div className="flex items-baseline justify-between gap-3 border-b-hairline px-1 py-3 text-[13px] leading-5 last:border-b-0">
      <p className="flex-1">{blocker.message}</p>
      {href && actionLabel && (
        <Link href={href} className={QUIET_LINK_CLASS}>
          {actionLabel}
        </Link>
      )}
    </div>
  )
}
