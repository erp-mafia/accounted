'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { Badge } from '@/components/ui/badge'
import { cn, formatCurrency } from '@/lib/utils'
import { BookOpen, ChevronRight, FileText, HandCoins } from 'lucide-react'
import type { ResumeItem } from '@/lib/worklist/resume'

/**
 * "Fortsätt" (concept scene 14, right pane): in-progress work you can jump
 * back into, derived purely from draft state (lib/worklist/resume). Renders
 * null when empty: never a blank-but-present card.
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
          icon: FileText,
          title: t('resume_invoice_draft', { customer: item.context ?? '' }),
          sub: [
            item.amount != null ? formatCurrency(item.amount, item.currency ?? 'SEK') : null,
            t('resume_edited', { when: relativeLabel(item.updated_at) }),
          ]
            .filter(Boolean)
            .join(' · '),
        }
      case 'invoice_unsent':
        return {
          icon: FileText,
          title: t('resume_invoice_unsent', { number: item.number ?? '' }),
          sub: [
            item.context,
            item.amount != null ? formatCurrency(item.amount, item.currency ?? 'SEK') : null,
            t('resume_edited', { when: relativeLabel(item.updated_at) }),
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
          icon: HandCoins,
          title: t(key, { period: item.context ?? '' }),
          sub: t('resume_edited', { when: relativeLabel(item.updated_at) }),
        }
      }
      case 'journal_draft':
      default:
        return {
          icon: BookOpen,
          title: t('resume_journal_draft'),
          sub: [item.context, t('resume_edited', { when: relativeLabel(item.updated_at) })]
            .filter(Boolean)
            .join(' · '),
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
          return (
            <Link
              key={item.ref}
              href={item.href}
              className="group flex w-full items-start gap-3 border-b border-border px-1 py-3.5 transition-colors duration-150 hover:bg-secondary/30"
            >
              <span className="mt-px w-[18px] shrink-0 text-muted-foreground" aria-hidden>
                <Icon className="h-[15px] w-[15px]" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13.5px]">{row.title}</span>
                {row.sub && (
                  <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                    {row.sub}
                  </span>
                )}
              </span>
              <span className="ml-auto flex shrink-0 items-center gap-2.5 pt-px">
                {item.late && (
                  <Badge variant="warning" className="font-normal">
                    {t('resume_late')}
                  </Badge>
                )}
                <ChevronRight
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
