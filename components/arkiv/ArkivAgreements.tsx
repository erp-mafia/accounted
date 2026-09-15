'use client'

import { useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useLocale, useTranslations } from 'next-intl'
import { EmptyState } from '@/components/ui/empty-state'
import { HelpPopover } from '@/components/ui/help-popover'
import { ToolbarSearch } from '@/components/ui/toolbar-search'
import { PageHeader } from '@/components/ui/page-header'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { QUIET_LINK_CLASS, TD_CLASS, TH_CLASS } from '@/components/ui/dry-table'
import type { AgreementListItem } from '@/app/api/arkiv/agreements/route'
import type { AgreementKind } from '@/lib/arkiv/agreements/derive'
import { formatCurrency, formatDateLong } from '@/lib/utils'

const KINDS: AgreementKind[] = ['rental', 'lease', 'loan', 'subscription']

/**
 * The agreements table: type dropdown and search on the left (decision 8 of
 * the plan), no attention line. Every row's source opens the document at the
 * page the amount was read from.
 */
export function ArkivAgreements() {
  const t = useTranslations('arkiv')
  const locale = useLocale()
  const router = useRouter()
  const [items, setItems] = useState<AgreementListItem[] | null>(null)
  const [failed, setFailed] = useState(false)
  const [kind, setKind] = useState<'all' | AgreementKind>('all')
  const [query, setQuery] = useState('')

  useEffect(() => {
    let cancelled = false
    fetch('/api/arkiv/agreements')
      .then(async (res) => {
        if (!res.ok) throw new Error(String(res.status))
        const { data } = (await res.json()) as { data: AgreementListItem[] }
        if (!cancelled) setItems(data)
      })
      .catch(() => {
        if (!cancelled) setFailed(true)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return (items ?? []).filter((a) => (kind === 'all' || a.kind === kind) && (!needle || `${a.title} ${a.counterparty.name ?? ''}`.toLowerCase().includes(needle)))
  }, [items, kind, query])

  const periodLabel = (period: AgreementListItem['period']) => (period ? t(`period_${period}`) : '')
  const sourceHref = (a: AgreementListItem) => `/api/documents/${a.source.document_id}/inline${a.source.page ? `#page=${a.source.page}` : ''}`

  return (
    <div className="space-y-6">
      <PageHeader title={t('agreements_title')} help={<HelpPopover>{t('agreements_help')}</HelpPopover>} />

      <div className="flex flex-wrap items-center gap-2">
        <Select value={kind} onValueChange={(v) => setKind(v as 'all' | AgreementKind)}>
          <SelectTrigger className="h-8 w-auto gap-1.5 rounded-full px-3.5 text-[13px]" aria-label={t('col_type')}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t('all_agreements')}</SelectItem>
            {KINDS.map((k) => (
              <SelectItem key={k} value={k}>
                {t(`types.agreement.${k}` as never)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <ToolbarSearch id="agreement-search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t('search_agreements')} containerClassName="w-72" />
      </div>

      {failed && <p className="text-[13px] text-muted-foreground">{t('load_failed')}</p>}
      {!items && !failed && (
        <div className="space-y-3">
          <Skeleton className="h-6 w-1/3" />
          <Skeleton className="h-6 w-2/3" />
        </div>
      )}
      {items && visible.length === 0 && <EmptyState title={t('agreements_empty_title')} description={t('agreements_empty_body')} />}
      {items && visible.length > 0 && (
        <table className="w-full border-collapse text-[13px]">
          <thead>
            <tr>
              <th className={`${TH_CLASS} pl-0`}>{t('col_agreement')}</th>
              <th className={`${TH_CLASS} text-right`}>{t('col_amount')}</th>
              <th className={TH_CLASS}>{t('col_next_payment')}</th>
              <th className={TH_CLASS}>{t('col_ends')}</th>
              <th className={TH_CLASS}>{t('col_notice')}</th>
              <th className={`${TH_CLASS} pr-0`}>{t('col_source')}</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((a) => (
              <tr key={a.id} className="cursor-pointer hover:bg-secondary/35" onClick={() => router.push(`/arkiv/avtal/${a.id}`)}>
                <td className={`${TD_CLASS} pl-0`}>
                  <div className="truncate" title={a.title}>
                    {a.title}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {t(`types.agreement.${a.kind}` as never)}
                    {a.counterparty.name ? ` · ${a.counterparty.name}` : ''}
                    {a.status === 'ended' ? ` · ${t('agreement_ended')}` : ''}
                  </div>
                </td>
                <td className={`${TD_CLASS} text-right tabular-nums`}>
                  {a.amount != null ? formatCurrency(a.amount, a.currency) : ''}
                  {a.amount != null && a.period ? <span className="text-muted-foreground"> {periodLabel(a.period)}</span> : null}
                </td>
                <td className={`${TD_CLASS} tabular-nums`}>
                  {a.next_payment ? (
                    <>
                      {formatDateLong(a.next_payment.due_on, locale)}
                      <span className="text-muted-foreground"> · {formatCurrency(a.next_payment.amount, a.next_payment.currency)}</span>
                      <span className={a.next_payment.status === 'missed' ? ' text-destructive' : ' text-muted-foreground'}> · {t(`obligation_${a.next_payment.status}`)}</span>
                    </>
                  ) : (
                    ''
                  )}
                </td>
                <td className={`${TD_CLASS} tabular-nums`}>{a.ends_on ? formatDateLong(a.ends_on, locale) : ''}</td>
                <td className={`${TD_CLASS} tabular-nums`}>{a.notice_deadline ? formatDateLong(a.notice_deadline.due_date, locale) : ''}</td>
                <td className={`${TD_CLASS} pr-0`}>
                  <a href={sourceHref(a)} target="_blank" rel="noreferrer" className={QUIET_LINK_CLASS} title={a.source.file_name}>
                    {a.source.page ? t('source_page', { page: a.source.page }) : t('source_open')}
                  </a>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}
