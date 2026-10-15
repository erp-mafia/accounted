'use client'

import { useEffect, useState } from 'react'
import { flushSync } from 'react-dom'
import { useTranslations } from 'next-intl'
import { useCompany } from '@/contexts/CompanyContext'
import { useFormat } from '@/lib/hooks/use-format'
import { cn, formatDate, formatOrgNumber } from '@/lib/utils'

/**
 * What a printed report page says about itself: company, org number, the
 * period the figures cover and the day it was printed. Hidden on screen, where
 * the top bar and its pickers carry the same facts; the dashboard's print rules
 * (globals.css) hide those controls on paper, so a page whose period lives in a
 * picker states it here. Sits right under the PageHeader, whose title prints as
 * the document heading.
 */
export function ReportPrintHeader({
  period,
  className,
}: {
  /** Inclusive YYYY-MM-DD bounds of the figures; null for a page without one. */
  period: { start: string; end: string } | null
  className?: string
}) {
  const t = useTranslations('reports')
  const { company } = useCompany()
  const { formatDateLong } = useFormat()
  // Restamped when printing starts, so a tab left open overnight does not
  // print yesterday's date. flushSync: the print snapshot is taken right
  // after the event, before a batched render would land.
  const [printedAt, setPrintedAt] = useState(() => new Date())
  useEffect(() => {
    const stamp = () => flushSync(() => setPrintedAt(new Date()))
    window.addEventListener('beforeprint', stamp)
    return () => window.removeEventListener('beforeprint', stamp)
  }, [])

  const facts = [
    company?.org_number ? t('print_org_number', { number: formatOrgNumber(company.org_number) }) : null,
    period ? t('print_period', { from: formatDate(period.start), to: formatDate(period.end) }) : null,
    t('print_printed_at', { date: formatDateLong(printedAt) }),
  ].filter((fact): fact is string => fact !== null)

  return (
    <div className={cn('hidden print:block', className)}>
      {company?.name && (
        // data-ph-mask: company name and org number are user data.
        <p data-ph-mask="" className="text-[15px] text-foreground">{company.name}</p>
      )}
      {/* The server's date can differ from the browser's near midnight; the
          client's own render (and every print) puts the right one in. */}
      <p data-ph-mask="" suppressHydrationWarning className="text-[12.5px] text-muted-foreground tabular-nums">
        {facts.join(' · ')}
      </p>
    </div>
  )
}
