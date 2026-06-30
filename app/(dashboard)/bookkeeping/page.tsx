'use client'

import { useState, useEffect, useMemo } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import { Button } from '@/components/ui/button'
import JournalEntryList from '@/components/bookkeeping/JournalEntryList'
import { type FormLine } from '@/components/bookkeeping/JournalEntryForm'
import NewJournalEntryDialog, { type CopyPrefill } from '@/components/bookkeeping/NewJournalEntryDialog'
import ChartOfAccountsManager from '@/components/bookkeeping/ChartOfAccountsManager'
import { useToast } from '@/components/ui/use-toast'
import { Plus } from 'lucide-react'
import { PageHeader } from '@/components/ui/page-header'
import { formatVoucher } from '@/lib/bookkeeping/voucher-series-resolver'
import type { JournalEntry, JournalEntryLine } from '@/types'

interface NextVoucher {
  next: number
  series: string
}

type TabValue = 'journal' | 'accounts'

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
  const [showNewEntry, setShowNewEntry] = useState(false)
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

    setShowNewEntry(true)
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
          <Button
            className="w-full sm:w-auto"
            onClick={() => {
              setCopyPrefill(null)
              setShowNewEntry(true)
            }}
          >
            <Plus className="mr-2 h-4 w-4" />
            {t('tab_new_entry')}
            {nextVoucher && (
              <span className="ml-1 text-primary-foreground/70 tabular-nums">
                ({nextVoucher.series}{nextVoucher.next})
              </span>
            )}
          </Button>
        }
      />

      <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as TabValue)}>
        <TabsList>
          <TabsTrigger value="journal">{t('tab_journal')}</TabsTrigger>
          <TabsTrigger value="accounts">{t('tab_accounts')}</TabsTrigger>
        </TabsList>

        <TabsContent value="journal" forceMount className="space-y-4">
          <JournalEntryList key={refreshKey} />
        </TabsContent>

        <TabsContent value="accounts" forceMount>
          <ChartOfAccountsManager />
        </TabsContent>
      </Tabs>

      <NewJournalEntryDialog
        open={showNewEntry}
        onOpenChange={(o) => {
          setShowNewEntry(o)
          if (!o) setCopyPrefill(null)
        }}
        onCreated={() => {
          setRefreshKey((k) => k + 1)
          setShowNewEntry(false)
          setCopyPrefill(null)
        }}
        copyPrefill={copyPrefill}
        isLoading={isLoadingCopy}
      />
    </div>
  )
}
