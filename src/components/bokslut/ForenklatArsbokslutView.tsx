'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { useLocale, useTranslations } from 'next-intl'
import {
  ArrowLeftIcon,
  DocumentArrowDownIcon,
  ExclamationTriangleIcon,
  PlusIcon,
  TrashIcon,
  XCircleIcon,
} from '@/components/icons'
import { Button } from '@/components/ui/button'
import { useViewerLock } from '@/components/ui/viewer-lock'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Skeleton, LateReveal } from '@/components/ui/skeleton'
import { EmptyState, LoadError } from '@/components/ui/empty-state'
import { AttnLine } from '@/components/ui/attn-line'
import { PageHeader } from '@/components/ui/page-header'
import { HelpPopover } from '@/components/ui/help-popover'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { useUrlFiscalPeriod } from '@/components/providers/FiscalScopeProvider'
import { useToast } from '@/components/ui/use-toast'
import { formatCurrency, formatDate } from '@/lib/utils'
import { getErrorMessage, type ErrorLocale } from '@/lib/errors/get-error-message'
import type { ForenklatArsbokslut } from '@/lib/bokslut/forenklat-arsbokslut/service'
import type { K1StatementRow } from '@/lib/bokslut/forenklat-arsbokslut/types'

/**
 * The förenklat årsbokslut (BFNAR 2010:1) of one räkenskapsår: the checks,
 * the eligibility confirmation, the resultaträkning and balansräkning in the
 * bilaga 2 layout with comparatives, the tilläggsupplysningar and the
 * styrelseledamöter who sign, and the PDF. The statements' rubriker and posts
 * are BFN's Swedish names in both locales: they are the document.
 */

interface Signatory {
  name: string
  role: string
}

const PAGE = '/bookkeeping/year-end/forenklat-arsbokslut'

function amount(value: number | null): string {
  return value === null ? '' : formatCurrency(value, 'SEK', { minimumFractionDigits: 2 })
}

function Statement({
  title,
  rows,
  currentHead,
  previousHead,
  emptyLabel,
}: {
  title: string
  rows: K1StatementRow[]
  currentHead: string
  previousHead: string | null
  emptyLabel: string
}) {
  return (
    <section>
      <div className="mb-1 flex items-center gap-2 px-1">
        <h3 className="font-sans text-xs font-medium text-muted-foreground">{title}</h3>
        <div className="h-px flex-1 bg-border/60" />
      </div>
      <div className="px-1 pt-2">
        {rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">{emptyLabel}</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="px-0" />
                <TableHead className="px-0 text-right">{currentHead}</TableHead>
                {previousHead !== null && <TableHead className="px-0 text-right">{previousHead}</TableHead>}
              </TableRow>
            </TableHeader>
            <TableBody className="stagger-enter">
              {rows.map((row) =>
                row.kind === 'rubrik' ? (
                  <TableRow key={row.key} className="hover:bg-transparent">
                    <TableCell className="px-0 pt-4 font-medium" colSpan={previousHead !== null ? 3 : 2}>
                      {row.label}
                    </TableCell>
                  </TableRow>
                ) : (
                  <TableRow key={row.key} className={row.kind === 'summa' ? 'font-medium' : undefined}>
                    <TableCell className="px-0">
                      <span title={row.accounts?.map((a) => `${a.account_number} ${a.account_name}`).join('\n')}>
                        {row.label}
                      </span>
                    </TableCell>
                    <TableCell className="px-0 text-right tabular-nums">{amount(row.current)}</TableCell>
                    {previousHead !== null && (
                      <TableCell className="px-0 text-right tabular-nums text-muted-foreground">
                        {amount(row.previous)}
                      </TableCell>
                    )}
                  </TableRow>
                ),
              )}
            </TableBody>
          </Table>
        )}
      </div>
    </section>
  )
}

export function ForenklatArsbokslutView({ periodId }: { periodId: string | null }) {
  const t = useTranslations('forenklat_arsbokslut')
  const { canWrite, lockedTitle } = useViewerLock()
  // The top bar names Bokslut before the page (the menu row these pages sit under).
  const tNav = useTranslations('nav')
  const tCommon = useTranslations('common')
  const locale = useLocale() as ErrorLocale
  const { toast } = useToast()
  // The year is app-wide context: a visit without ?period takes the sidebar
  // year into the URL, and a pick in the sidebar moves the URL.
  useUrlFiscalPeriod(periodId, PAGE, { allowAll: false, hideFuture: true })

  const [data, setData] = useState<ForenklatArsbokslut | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  // The server's answer that this year has no förenklat årsbokslut (only an
  // ideell förening has one): said as it is, with nothing to retry.
  const [refusal, setRefusal] = useState<string | null>(null)
  const [notes, setNotes] = useState('')
  const [signatories, setSignatories] = useState<Signatory[]>([])
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [checked, setChecked] = useState([false, false, false])

  const load = useCallback(async () => {
    if (!periodId) return
    setLoading(true)
    setError(null)
    setRefusal(null)
    try {
      const res = await fetch(`/api/bookkeeping/fiscal-periods/${periodId}/forenklat-arsbokslut`)
      const body = await res.json().catch(() => null)
      if (!res.ok) {
        const message = getErrorMessage(body?.error, { locale }) || t('load_error')
        const transient = res.status >= 500 || res.status === 408 || res.status === 429
        if (transient) setError(message)
        else setRefusal(message)
        return
      }
      const report = body.data as ForenklatArsbokslut
      setData(report)
      setNotes(report.notes ?? '')
      setSignatories(report.signatories.map((s) => ({ name: s.name, role: s.role ?? '' })))
      setDirty(false)
      setChecked([report.eligibility.confirmed, report.eligibility.confirmed, report.eligibility.confirmed])
    } catch {
      setError(t('load_error'))
    } finally {
      setLoading(false)
    }
  }, [periodId, locale, t])

  useEffect(() => {
    void load()
  }, [load])

  const patch = useCallback(
    async (body: Record<string, unknown>): Promise<boolean> => {
      if (!periodId) return false
      const res = await fetch(`/api/bookkeeping/fiscal-periods/${periodId}/forenklat-arsbokslut`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!res.ok) {
        const payload = await res.json().catch(() => null)
        toast({ title: t('save_error'), description: getErrorMessage(payload?.error, { locale }), variant: 'destructive' })
        return false
      }
      return true
    },
    [periodId, locale, t, toast],
  )

  const saveDocument = async () => {
    setSaving(true)
    try {
      const ok = await patch({
        notes: notes.trim() === '' ? null : notes,
        signatories: signatories
          .filter((s) => s.name.trim() !== '')
          .map((s) => ({ name: s.name.trim(), role: s.role.trim() === '' ? null : s.role.trim() })),
      })
      if (ok) {
        toast({ title: t('saved') })
        await load()
      }
    } finally {
      setSaving(false)
    }
  }

  const setConfirmation = async (confirmed: boolean) => {
    setConfirming(true)
    try {
      if (await patch({ eligibility_confirmed: confirmed })) await load()
    } finally {
      setConfirming(false)
    }
  }

  const header = (title: string, action?: React.ReactNode) => (
    <PageHeader parent={{ label: tNav('v2_closing'), href: '/bookkeeping/year-end' }} title={title} help={<HelpPopover>{t('help')}</HelpPopover>} action={action} />
  )

  if (!periodId) {
    return (
      <div className="space-y-8">
        {header(t('title'))}
        <div className="max-w-xl space-y-4 px-1">
          <p className="text-sm text-muted-foreground">{t('choose_year')}</p>
        </div>
      </div>
    )
  }

  if (loading && !data) {
    return (
      <div className="space-y-8">
        {header(t('title'))}
        <LateReveal className="space-y-3">
          <Skeleton className="h-6 w-1/3" />
          <Skeleton className="h-64 w-full" />
        </LateReveal>
      </div>
    )
  }

  if (!data && refusal) {
    return (
      <div className="space-y-8">
        {header(t('title'))}
        <EmptyState title={refusal} />
      </div>
    )
  }

  if (!data) {
    return (
      <div className="space-y-8">
        {header(t('title'))}
        <LoadError title={error ?? t('load_error')} onRetry={() => void load()} />
      </div>
    )
  }

  const period = data.fiscal_period
  const previous = data.previous_period
  const pdfUrl = `/api/bookkeeping/fiscal-periods/${periodId}/forenklat-arsbokslut/pdf`
  const blocked = data.blockers.length > 0
  const allChecked = checked.every(Boolean)
  const statements = [
    {
      key: 'rr',
      title: 'Resultaträkning',
      rows: data.resultatrakning,
      currentHead: `${formatDate(period.period_start)} - ${formatDate(period.period_end)}`,
      previousHead: previous ? `${formatDate(previous.period_start)} - ${formatDate(previous.period_end)}` : null,
    },
    {
      key: 'br',
      title: 'Balansräkning',
      rows: data.balansrakning,
      currentHead: formatDate(period.period_end),
      previousHead: previous ? formatDate(previous.period_end) : null,
    },
  ]
  const eligibilityStatements = [t('eligibility_turnover'), t('eligibility_parent'), t('eligibility_all_activities')]

  return (
    <div className="space-y-8">
      {header(
        `${t('title')} ${period.name}`,
        <div className="flex flex-wrap items-center gap-2">
          <Button size="toolbar" variant="outline" asChild>
            <Link href={`/bookkeeping/year-end?period=${periodId}`}>
              <ArrowLeftIcon className="mr-2 h-4 w-4" /> {t('back')}
            </Link>
          </Button>
          {blocked ? (
            <Button size="toolbar" disabled>
              <DocumentArrowDownIcon className="h-4 w-4" /> {t('download_pdf')}
            </Button>
          ) : (
            <Button size="toolbar" asChild>
              <Link href={pdfUrl} target="_blank" rel="noopener noreferrer">
                <DocumentArrowDownIcon className="mr-2 h-4 w-4" /> {t('download_pdf')}
              </Link>
            </Button>
          )}
        </div>,
      )}

      {/* A failed reload keeps the report on screen (Stil v3 states). */}
      {error && (
        <AttnLine action={{ label: tCommon('retry'), onClick: () => void load() }}>{tCommon('refresh_failed')}</AttnLine>
      )}

      <section className="space-y-2 px-1">
        <p className="text-sm" data-ph-mask="">
          {data.company.name}
          {data.company.org_number ? ` · ${data.company.org_number}` : ''}
        </p>
        {data.blockers.length === 0 && data.warnings.length === 0 && (
          <p className="text-sm text-muted-foreground">{t('checks_ok')}</p>
        )}
        {data.blockers.map((check) => (
          <div key={check.code} className="flex items-start gap-2 text-sm">
            <XCircleIcon className="mt-0.5 h-4 w-4 shrink-0 text-destructive" aria-label={t('blocker_label')} />
            <p className="leading-5">{check.message}</p>
          </div>
        ))}
        {data.warnings.map((check) => (
          <div key={check.code} className="flex items-start gap-2 text-sm">
            <ExclamationTriangleIcon className="mt-0.5 h-4 w-4 shrink-0 text-attn" aria-label={t('warning_label')} />
            <p className="leading-5 text-muted-foreground">{check.message}</p>
          </div>
        ))}
      </section>

      <section>
        <div className="mb-1 flex items-center gap-2 px-1">
          <h3 className="font-sans text-xs font-medium text-muted-foreground">
            {t('eligibility_title')}
          </h3>
          <div className="h-px flex-1 bg-border/60" />
        </div>
        <div className="space-y-3 px-1 pt-2">
          {eligibilityStatements.map((statement, index) => (
            <label key={index} className="flex cursor-pointer items-start gap-3">
              <Checkbox
                checked={checked[index]}
                disabled={data.eligibility.confirmed || confirming}
                onCheckedChange={(value) =>
                  setChecked((current) => current.map((c, i) => (i === index ? value === true : c)))
                }
                className="mt-0.5"
              />
              <span className="text-sm leading-relaxed">{statement}</span>
            </label>
          ))}
          <div className="flex flex-wrap items-center gap-3 pt-1">
            {data.eligibility.confirmed ? (
              <>
                <span className="text-sm text-muted-foreground">
                  {t('eligibility_confirmed', { date: formatDate(data.eligibility.confirmed_at ?? '') })}
                </span>
                <Button variant="outline" loading={confirming} onClick={() => void setConfirmation(false)} disabled={!canWrite} title={lockedTitle}>
                  {t('eligibility_withdraw')}
                </Button>
              </>
            ) : (
              <Button disabled={!canWrite || !allChecked} title={lockedTitle} loading={confirming} onClick={() => void setConfirmation(true)}>
                {t('eligibility_confirm')}
              </Button>
            )}
          </div>
        </div>
      </section>

      {statements.map((statement) => (
        <Statement
          key={statement.key}
          title={statement.title}
          rows={statement.rows}
          currentHead={statement.currentHead}
          previousHead={statement.previousHead}
          emptyLabel={t('empty_statement')}
        />
      ))}

      <section>
        <div className="mb-1 flex items-center gap-2 px-1">
          <h3 className="font-sans text-xs font-medium text-muted-foreground">
            Tilläggsupplysningar
          </h3>
          <div className="h-px flex-1 bg-border/60" />
        </div>
        <div className="px-1 pt-2">
          <Textarea
            value={notes}
            rows={5}
            maxLength={10_000}
            placeholder={t('notes_placeholder')}
            onChange={(event) => {
              setNotes(event.target.value)
              setDirty(true)
            }}
          />
        </div>
      </section>

      <section>
        <div className="mb-1 flex items-center gap-2 px-1">
          <h3 className="font-sans text-xs font-medium text-muted-foreground">
            {t('signatories_title')}
          </h3>
          <div className="h-px flex-1 bg-border/60" />
        </div>
        <div className="space-y-3 px-1 pt-2">
          <p className="text-sm text-muted-foreground">{t('signatories_hint')}</p>
          {signatories.map((signatory, index) => (
            <div key={index} className="flex flex-wrap items-center gap-2">
              <Input
                className="max-w-xs"
                value={signatory.name}
                maxLength={200}
                placeholder={t('signatory_name')}
                aria-label={t('signatory_name')}
                onChange={(event) => {
                  const name = event.target.value
                  setSignatories((current) => current.map((s, i) => (i === index ? { ...s, name } : s)))
                  setDirty(true)
                }}
              />
              <Input
                className="max-w-[12rem]"
                value={signatory.role}
                maxLength={100}
                placeholder={t('signatory_role')}
                aria-label={t('signatory_role')}
                onChange={(event) => {
                  const role = event.target.value
                  setSignatories((current) => current.map((s, i) => (i === index ? { ...s, role } : s)))
                  setDirty(true)
                }}
              />
              <Button
                variant="ghost"
                size="icon"
                aria-label={t('signatory_remove')}
                onClick={() => {
                  setSignatories((current) => current.filter((_, i) => i !== index))
                  setDirty(true)
                }}
              >
                <TrashIcon className="h-4 w-4" />
              </Button>
            </div>
          ))}
          <div className="flex flex-wrap gap-3">
            <Button
              variant="outline"
              disabled={signatories.length >= 30}
              onClick={() => {
                setSignatories((current) => [...current, { name: '', role: '' }])
                setDirty(true)
              }}
            >
              <PlusIcon className="h-4 w-4" /> {t('signatory_add')}
            </Button>
            <Button disabled={!canWrite || !dirty} title={lockedTitle} loading={saving} onClick={() => void saveDocument()}>
              {t('save')}
            </Button>
          </div>
        </div>
      </section>
    </div>
  )
}
