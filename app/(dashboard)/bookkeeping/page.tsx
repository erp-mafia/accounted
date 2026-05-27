'use client'

import { useState, useEffect, useMemo } from 'react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import { Button } from '@/components/ui/button'
import JournalEntryList from '@/components/bookkeeping/JournalEntryList'
import JournalEntryForm, { type FormLine } from '@/components/bookkeeping/JournalEntryForm'
import ChartOfAccountsManager from '@/components/bookkeeping/ChartOfAccountsManager'
import { FiscalYearSelector } from '@/components/common/FiscalYearSelector'
import { useToast } from '@/components/ui/use-toast'
import { Lock, Loader2, Copy } from 'lucide-react'
import { PageHeader } from '@/components/ui/page-header'
import { formatVoucher } from '@/lib/bookkeeping/voucher-series-resolver'
import type { JournalEntry, JournalEntryLine } from '@/types'

interface CopyPrefill {
  sourceId: string
  sourceVoucherLabel: string
  lines: FormLine[]
  description: string
  notes: string
}

interface NextVoucher {
  next: number
  series: string
}

type TabValue = 'journal' | 'new-entry' | 'accounts'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export default function BookkeepingPage() {
  const { toast } = useToast()
  const router = useRouter()
  const searchParams = useSearchParams()
  const copyFromId = useMemo<string | null>(() => {
    const raw = searchParams.get('copy_from')
    return raw && UUID_RE.test(raw) ? raw : null
  }, [searchParams])

  const [refreshKey, setRefreshKey] = useState(0)
  const [activeTab, setActiveTab] = useState<TabValue>('journal')
  const [periodId, setPeriodId] = useState<string | null>(null)
  const [copyPrefill, setCopyPrefill] = useState<CopyPrefill | null>(null)
  const [isLoadingCopy, setIsLoadingCopy] = useState(false)
  const [nextVoucher, setNextVoucher] = useState<NextVoucher | null>(null)
  const t = useTranslations('bookkeeping')

  // React to copy_from in URL: switch tab, fetch source entry, then clean URL.
  // useSearchParams keeps this reactive even when navigation happens within the
  // same route (e.g. clicking the Kopiera button in the expanded list row),
  // which a one-shot useState initializer wouldn't notice.
  /* eslint-disable react-hooks/set-state-in-effect -- URL→state sync requires sync setState */
  useEffect(() => {
    if (!copyFromId) return

    setActiveTab('new-entry')
    setCopyPrefill(null)
    setIsLoadingCopy(true)

    fetch(`/api/bookkeeping/journal-entries/${copyFromId}`)
      .then((res) => res.json())
      .then(({ data, error }: { data?: JournalEntry; error?: string }) => {
        if (error || !data) {
          toast({
            title: t('copy_failed_title'),
            description: error || t('copy_source_missing'),
            variant: 'destructive',
          })
          return
        }
        const sourceLines = ((data.lines || []) as JournalEntryLine[])
          .slice()
          .sort((a, b) => a.sort_order - b.sort_order)
        const lines: FormLine[] = sourceLines.map((l) => {
          const debit = Number(l.debit_amount) || 0
          const credit = Number(l.credit_amount) || 0
          return {
            account_number: l.account_number,
            debit_amount: debit > 0 ? debit.toFixed(2) : '',
            credit_amount: credit > 0 ? credit.toFixed(2) : '',
            line_description: l.line_description || '',
          }
        })
        setCopyPrefill({
          sourceId: copyFromId,
          sourceVoucherLabel: formatVoucher(data),
          lines,
          description: data.description || '',
          notes: data.notes || '',
        })
      })
      .catch(() => {
        toast({
          title: t('copy_failed_title'),
          description: t('copy_fetch_failed'),
          variant: 'destructive',
        })
      })
      .finally(() => {
        setIsLoadingCopy(false)
        // Clear copy_from so a refresh doesn't re-trigger and so clicking the
        // same entry's Kopiera button again re-fires this effect.
        router.replace('/bookkeeping')
      })
  }, [copyFromId, toast, router])
  /* eslint-enable react-hooks/set-state-in-effect */

  // Fetch the next voucher number for today's fiscal period + default series.
  // Re-runs after each commit (refreshKey++) so the tab label stays current.
  useEffect(() => {
    let cancelled = false
    fetch('/api/bookkeeping/voucher-sequences/next')
      .then((r) => r.json())
      .then(({ data }) => {
        if (cancelled) return
        if (data?.next != null) {
          setNextVoucher({ next: data.next, series: data.series })
        } else {
          setNextVoucher(null)
        }
      })
      .catch(() => {
        if (!cancelled) setNextVoucher(null)
      })
    return () => {
      cancelled = true
    }
  }, [refreshKey])

  return (
    <div className="space-y-8">
      <PageHeader
        title={t('title')}
        action={
          <div className="flex gap-2 w-full sm:w-auto">
            <Button variant="outline" asChild className="w-full sm:w-auto">
            <Link href="/bookkeeping/year-end">
              <Lock className="mr-2 h-4 w-4" />
              {t('year_end')}
            </Link>
          </Button>
          </div>
        }
      />

      <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as TabValue)}>
        <TabsList>
          <TabsTrigger value="journal">{t('tab_journal')}</TabsTrigger>
          <TabsTrigger value="new-entry">
            {t('tab_new_entry')}
            {nextVoucher && (
              <span className="ml-1 text-muted-foreground tabular-nums">
                ({nextVoucher.series}{nextVoucher.next})
              </span>
            )}
          </TabsTrigger>
          <TabsTrigger value="accounts">{t('tab_accounts')}</TabsTrigger>
        </TabsList>

        <TabsContent value="journal" className="space-y-4">
          <FiscalYearSelector value={periodId} onChange={setPeriodId} />
          <JournalEntryList key={`${refreshKey}-${periodId ?? 'all'}`} periodId={periodId ?? undefined} />
        </TabsContent>

        <TabsContent value="new-entry">
          {isLoadingCopy ? (
            <div className="flex items-center gap-2 py-12 justify-center text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              <span className="text-sm">{t('loading_source_voucher')}</span>
            </div>
          ) : (
            <>
              {copyPrefill && (
                <div className="mb-4 flex items-start gap-3 rounded-lg border border-border bg-muted/30 p-3 text-sm">
                  <Copy className="h-4 w-4 mt-0.5 shrink-0 text-muted-foreground" />
                  <div className="flex-1">
                    <p className="font-medium">
                      {t('copy_banner_title', { label: copyPrefill.sourceVoucherLabel || t('copy_banner_unknown_label') })}
                    </p>
                    <p className="text-muted-foreground mt-0.5">
                      {t('copy_banner_body')}
                    </p>
                  </div>
                </div>
              )}
              <JournalEntryForm
                key={copyPrefill?.sourceId ?? 'fresh'}
                onCreated={() => {
                  setRefreshKey((k) => k + 1)
                  setCopyPrefill(null)
                }}
                initialLines={copyPrefill?.lines}
                initialDescription={copyPrefill?.description}
                initialNotes={copyPrefill?.notes}
              />
            </>
          )}
        </TabsContent>

        <TabsContent value="accounts">
          <ChartOfAccountsManager />
        </TabsContent>
      </Tabs>
    </div>
  )
}
