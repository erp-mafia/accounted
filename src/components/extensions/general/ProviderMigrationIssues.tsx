'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { formatCurrency, formatDate } from '@/lib/utils'
import {
  migrationIssueHref,
  migrationIssueReason,
  type MigrationIssueReason,
  type ProviderMigrationIssue,
} from '@/lib/providers/migration-contract'
import { PROVIDER_DISPLAY_NAMES } from '@/lib/providers/unfinished-connect'
import type { ProviderName } from '@/lib/providers/types'

/** Records shown per reason before the rest folds behind a "Visa N till" button. */
const VISIBLE_PER_REASON = 8

export function migrationProviderName(provider: string | null | undefined): string {
  return PROVIDER_DISPLAY_NAMES[provider as ProviderName] ?? provider ?? ''
}

interface ReasonGroup {
  key: string
  reason: MigrationIssueReason
  issues: ProviderMigrationIssue[]
}

/** One group per reason, in the order the records were listed. */
function groupByReason(issues: ProviderMigrationIssue[]): ReasonGroup[] {
  const groups = new Map<string, ReasonGroup>()
  for (const issue of issues) {
    const reason = migrationIssueReason(issue)
    const group = groups.get(reason) ?? { key: reason, reason, issues: [] }
    group.issues.push(issue)
    groups.set(reason, group)
  }
  return [...groups.values()]
}

/**
 * The records an import could not finish, each with the reason in plain
 * Swedish: the ones that never reached Accounted first, then the ones that
 * did but whose voucher link or payment could not be confirmed. Shared by the
 * review before acceptance and by the result after it, so an accepted import
 * keeps listing exactly what it left out.
 */
export default function ProviderMigrationIssues({ issues, provider, total, truncated }: {
  issues: ProviderMigrationIssue[]
  provider: string | null | undefined
  /** Records that need attention in the whole job, listed or not. */
  total: number
  truncated: boolean
}) {
  const t = useTranslations('extensions')
  const providerName = migrationProviderName(provider)
  const missing = groupByReason(issues.filter(issue => !issue.imported))
  const imported = groupByReason(issues.filter(issue => issue.imported))
  const missingCount = missing.reduce((n, g) => n + g.issues.length, 0)
  const importedCount = imported.reduce((n, g) => n + g.issues.length, 0)
  if (!issues.length) return null
  return (
    <div className="space-y-6">
      {missing.length > 0 && <section className="space-y-3">
        <h3 className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
          {t('ext_arcim_review_section_missing', { count: missingCount })}
        </h3>
        {missing.map(group => <ReasonBlock key={group.key} group={group} provider={providerName} />)}
      </section>}
      {imported.length > 0 && <section className="space-y-3">
        <h3 className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
          {t('ext_arcim_review_section_imported', { count: importedCount })}
        </h3>
        <p className="text-[13px] text-muted-foreground">{t('ext_arcim_review_section_imported_note')}</p>
        {imported.map(group => <ReasonBlock key={group.key} group={group} provider={providerName} />)}
      </section>}
      {truncated && <p className="text-[13px] text-muted-foreground">
        {t('ext_arcim_review_truncated', { shown: issues.length, total })}
      </p>}
    </div>
  )
}

function ReasonBlock({ group, provider }: { group: ReasonGroup; provider: string }) {
  const t = useTranslations('extensions')
  const [expanded, setExpanded] = useState(false)
  const shown = expanded ? group.issues : group.issues.slice(0, VISIBLE_PER_REASON)
  const hidden = group.issues.length - shown.length
  return (
    <div className="space-y-2">
      <p className="text-sm">{t(`ext_arcim_review_reason_${group.reason}`, { provider })}</p>
      <ul className="divide-y divide-border border-y border-border">
        {shown.map(issue => <IssueLine key={issue.id} issue={issue} />)}
      </ul>
      {hidden > 0 && <Button variant="ghost" size="sm" onClick={() => setExpanded(true)}>
        {t('ext_arcim_review_more', { count: hidden })}
      </Button>}
    </div>
  )
}

function IssueLine({ issue }: { issue: ProviderMigrationIssue }) {
  const t = useTranslations('extensions')
  const label = issue.label
  const kind = t(`ext_arcim_review_record_${issue.resource}`)
  // Only a record whose snapshot was read is known to lack a number: one past
  // the snapshots a read opens is named by its id, without that claim.
  const name = label?.number
    ? `${kind} ${label.number}`
    : `${kind} ${t(label ? 'ext_arcim_review_record_source_id' : 'ext_arcim_review_record_unnamed', { id: issue.source_id })}`
  // A record that reached Accounted opens on its own page, in a new tab so
  // the list stays: that page is where its payment is linked or marked.
  const href = migrationIssueHref(issue)
  const facts = [
    label?.party,
    label?.date ? formatDate(label.date) : null,
    typeof label?.amount === 'number' ? formatCurrency(label.amount, label.currency) : null,
  ].filter(Boolean).join(' · ')
  const voucher = issue.voucher
    ? t('ext_arcim_review_voucher', { voucher: [issue.voucher.series, issue.voucher.number].filter(v => v !== null).join(' ') })
    : null
  const booked = issue.review?.bookedSek
  const expected = issue.review?.expectedSek
  const amounts = typeof booked === 'number' && typeof expected === 'number'
    ? t('ext_arcim_review_amounts', { booked: formatCurrency(booked), expected: formatCurrency(expected) })
    : null
  const detail = [voucher, amounts].filter(Boolean).join(': ')
  return (
    <li className="py-2 text-sm">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        {href
          ? <Link href={href} target="_blank" rel="noopener" title={t('ext_arcim_review_open_record')}
              className="underline decoration-border underline-offset-2 hover:decoration-foreground">{name}</Link>
          : <span>{name}</span>}
        {facts && <span className="tabular-nums text-muted-foreground">{facts}</span>}
      </div>
      {detail && <p className="mt-1 text-xs tabular-nums text-muted-foreground">{detail}</p>}
    </li>
  )
}
