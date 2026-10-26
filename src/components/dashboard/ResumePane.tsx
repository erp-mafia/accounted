'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { Badge } from '@/components/ui/badge'
import { cn, formatCurrency } from '@/lib/utils'
import { BanknotesIcon, BookOpenIcon, ChevronRightIcon, DocumentTextIcon } from '@/components/icons'
import type { ResumeItem } from '@/lib/worklist/resume'

/**
 * "Fortsätt" (concept scene 14, right pane): in-progress work you can jump
 * back into, derived purely from draft state (lib/worklist/resume). Renders
 * null when empty: never a blank-but-present card. Each row is one line
 * (convention 4): the title with its context and amount as a muted suffix,
 * and how long ago it was edited, muted at the right edge where the Att
 * göra rows beside it keep their counts.
 */
export default function ResumePane({ items }: { items: ResumeItem[] }) {
  const t = useTranslations('dashboard')

  // Captured once: render must stay pure and the labels stable per mount.
  const [nowMs] = useState(() => Date.now())

  if (items.length === 0) return null

  const relativeLabel = (iso: string): string => {
    const days = Math.floor((nowMs - new Date(iso).getTime()) / 86_400_000)
    if (days <= 0) return t('rel_today')
    if (days === 1) return t('rel_yesterday')
    return t('rel_days', { count: days })
  }

  const rowFor = (item: ResumeItem) => {
    switch (item.kind) {
      case 'invoice_draft':
        return {
          icon: DocumentTextIcon,
          title: t('resume_invoice_draft', { customer: item.context ?? '' }),
          meta: item.amount != null ? formatCurrency(item.amount, item.currency ?? 'SEK') : null,
        }
      case 'invoice_unsent':
      case 'quote_unsent':
      case 'quote_to_invoice':
        return {
          icon: DocumentTextIcon,
          title: t(
            item.kind === 'quote_unsent'
              ? 'resume_quote_unsent'
              : item.kind === 'quote_to_invoice'
                ? 'resume_quote_to_invoice'
                : 'resume_invoice_unsent',
            { number: item.number ?? '' },
          ),
          meta: [
            item.context,
            item.amount != null ? formatCurrency(item.amount, item.currency ?? 'SEK') : null,
          ]
            .filter(Boolean)
            .join(' · '),
        }
      case 'salary_run': {
        const key =
          item.salaryStatus === 'review'
            ? 'resume_salary_review'
            : item.salaryStatus === 'approved'
              ? 'resume_salary_approved'
              : item.salaryStatus === 'paid'
                ? 'resume_salary_paid'
                : 'resume_salary_draft'
        return {
          icon: BanknotesIcon,
          title: t(key, { period: item.context ?? '' }),
          meta: null,
        }
      }
      case 'journal_draft':
      default:
        return {
          icon: BookOpenIcon,
          title: t('resume_journal_draft'),
          meta: item.context,
        }
    }
  }

  return (
    <section aria-label={t('resume_title')}>
      {/* Pane header: Geist title over a hairline */}
      <div className="flex items-baseline justify-between border-b border-border px-1 pb-2.5">
        <h2 className="font-sans text-sm font-medium">{t('resume_title')}</h2>
      </div>
      <div>
        {items.map((item) => {
          const row = rowFor(item)
          const Icon = row.icon
          const edited = relativeLabel(item.updated_at)
          return (
            <Link
              key={item.ref}
              href={item.href}
              className="group flex w-full items-start gap-3 border-b border-border px-1 py-3.5 transition-colors duration-150 hover:bg-secondary/35"
            >
              <span className="mt-px w-[18px] shrink-0 text-muted-foreground" aria-hidden>
                <Icon className="h-[15px] w-[15px]" />
              </span>
              <span className="min-w-0 flex-1 truncate text-[13px]">
                {row.title}
                {row.meta && <span className="text-muted-foreground"> · {row.meta}</span>}
              </span>
              <span className="ml-auto flex shrink-0 items-center gap-2.5 pt-px">
                {item.late && (
                  <Badge variant="warning" className="font-normal">
                    {t('resume_late')}
                  </Badge>
                )}
                <span
                  className="text-xs tabular-nums text-muted-foreground"
                  title={t('resume_edited', { when: edited })}
                >
                  {edited}
                </span>
                <ChevronRightIcon
                  className={cn(
                    'h-3.5 w-3.5 text-muted-foreground opacity-0 transition-opacity duration-150 group-hover:opacity-100',
                  )}
                />
              </span>
            </Link>
          )
        })}
      </div>
    </section>
  )
}
