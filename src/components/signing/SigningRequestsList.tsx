'use client'

import { Fragment, useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { ChevronDownIcon, ChevronRightIcon, PencilSquareIcon } from '@/components/icons'
import { Button } from '@/components/ui/button'
import { EmptyState, LoadError } from '@/components/ui/empty-state'
import { AttnLine } from '@/components/ui/attn-line'
import { RowFoldout, TD_CLASS, TH_CLASS } from '@/components/ui/dry-table'
import { SegmentedControl } from '@/components/ui/segmented-control'
import { LateReveal, Skeleton } from '@/components/ui/skeleton'
import { cn, formatDate } from '@/lib/utils'
import type { SigningRequestStatusFilter, SigningRequestView } from '@/lib/signing/requests'
import { SigningRequestCard, SigningRequestState } from './SigningRequestCard'
import { listSigningRequests } from './signing-client'
import { useSigningAvailability } from './use-signing-availability'

type Filter = 'all' | SigningRequestStatusFilter

const FILTERS: Filter[] = ['all', 'open', 'completed', 'declined', 'cancelled']

/**
 * /arkiv/signeringar: every signing request of the company, newest first,
 * filtered by status. One line per request (the document, who is asked,
 * when it was sent, where it stands); the row folds open to the same card
 * the Arkiv record shows, with each signer's status, Påminn, Avbryt and the
 * signed copy. An open request past its expiry is listed under Öppna and
 * says it has expired.
 */
export function SigningRequestsList() {
  const t = useTranslations('signing')
  const tCommon = useTranslations('common')
  // Chasing a request already sent needs the feature, not the plan (only sending a new one does).
  const available = useSigningAvailability().offered
  const [filter, setFilter] = useState<Filter>('all')
  const [requests, setRequests] = useState<SigningRequestView[] | null>(null)
  const [failed, setFailed] = useState(false)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [reloadKey, setReloadKey] = useState(0)

  const load = useCallback(() => listSigningRequests({ status: filter === 'all' ? null : filter }), [filter])

  useEffect(() => {
    let cancelled = false
    load().then(
      (list) => {
        if (!cancelled) {
          setRequests(list)
          setFailed(false)
        }
      },
      () => {
        if (!cancelled) setFailed(true)
      },
    )
    return () => {
      cancelled = true
    }
  }, [load, reloadKey])

  const toolbar = (
    <div className="flex items-center justify-between gap-4">
      <SegmentedControl
        value={filter}
        onChange={(next) => {
          setFilter(next)
          setRequests(null)
          setExpanded(null)
        }}
        options={FILTERS.map((f) => ({ value: f, label: t(`filter_${f}`) }))}
        aria-label={t('filter_label')}
      />
    </div>
  )

  let body: React.ReactNode
  const retry = () => {
    setFailed(false)
    setReloadKey((n) => n + 1)
  }
  if (failed && !requests) body = <LoadError title={t('list_load_failed')} onRetry={retry} />
  else if (!requests)
    body = (
      <LateReveal className="space-y-2">
        <Skeleton className="h-8 w-full" />
        <Skeleton className="h-8 w-full" />
        <Skeleton className="h-8 w-2/3" />
      </LateReveal>
    )
  else if (requests.length === 0)
    body = <EmptyState icon={PencilSquareIcon} title={filter === 'all' ? t('list_empty_title') : t('list_empty_filtered_title')} description={t('list_empty_body')} actionLabel={t('list_empty_action')} actionHref="/arkiv" />
  else
    body = (
      <div className="-mx-2 overflow-x-auto">
        <table className="w-full border-collapse text-[13px]">
          <thead>
            <tr>
              <th className={TH_CLASS}>{t('col_title')}</th>
              <th className={TH_CLASS}>{t('col_signers')}</th>
              <th className={TH_CLASS}>{t('col_sent')}</th>
              <th className={TH_CLASS}>{t('col_state')}</th>
              <th className={cn(TH_CLASS, 'w-10')}>
                <span className="sr-only">{t('col_details')}</span>
              </th>
            </tr>
          </thead>
          <tbody className="stagger-enter">
            {requests.map((r) => {
              const open = expanded === r.signing_request_id
              return (
                <Fragment key={r.signing_request_id}>
                  <tr className="hover:bg-secondary/35">
                    <td className={cn(TD_CLASS, 'w-[40%] max-w-0')}>
                      <Link href={`/arkiv/dokument/${r.document_id}`} className="block truncate hover:underline" data-ph-mask="">
                        {r.title}
                      </Link>
                    </td>
                    <td className={cn(TD_CLASS, 'max-w-0 text-muted-foreground')}>
                      <span className="block truncate" data-ph-mask="">
                        {r.signers.map((s) => s.name).join(', ')}
                      </span>
                    </td>
                    <td className={cn(TD_CLASS, 'whitespace-nowrap date-figures text-muted-foreground')}>{formatDate(r.created_at)}</td>
                    <td className={cn(TD_CLASS, 'whitespace-nowrap')}>
                      <SigningRequestState request={r} />
                    </td>
                    <td className={cn(TD_CLASS, 'py-1 text-right align-middle')}>
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-expanded={open}
                        aria-label={open ? t('row_collapse', { title: r.title }) : t('row_expand', { title: r.title })}
                        onClick={() => setExpanded(open ? null : r.signing_request_id)}
                      >
                        {open ? <ChevronDownIcon className="h-4 w-4" /> : <ChevronRightIcon className="h-4 w-4" />}
                      </Button>
                    </td>
                  </tr>
                  {open && (
                    <tr>
                      <td colSpan={5} className="border-b-hairline p-0">
                        <RowFoldout>
                          <div className="px-4 py-3">
                            <SigningRequestCard request={r} available={available} onChanged={() => setReloadKey((n) => n + 1)} showHeading={false} />
                          </div>
                        </RowFoldout>
                      </td>
                    </tr>
                  )}
                </Fragment>
              )
            })}
          </tbody>
        </table>
      </div>
    )

  return (
    <div className="space-y-4">
      {toolbar}
      {failed && requests && (
        <AttnLine action={{ label: tCommon('retry'), onClick: retry }}>{tCommon('refresh_failed')}</AttnLine>
      )}
      {body}
    </div>
  )
}
