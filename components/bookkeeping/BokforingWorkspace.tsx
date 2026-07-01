'use client'

import { useState, useEffect, useMemo } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { useTranslations } from 'next-intl'
import dynamic from 'next/dynamic'
import { Plus, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { PageHeader } from '@/components/ui/page-header'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { type FormLine } from '@/components/bookkeeping/JournalEntryForm'
import NewJournalEntryDialog, { type CopyPrefill } from '@/components/bookkeeping/NewJournalEntryDialog'
import AgentSparkleButton from '@/components/agent/AgentSparkleButton'
import { useToast } from '@/components/ui/use-toast'
import { formatVoucher } from '@/lib/bookkeeping/voucher-series-resolver'
import { getWorkspaceComponent } from '@/lib/extensions/workspace-registry'
import type { JournalEntry, JournalEntryLine } from '@/types'

/** The one home for accounting: bank transactions to book, receipts/underlag,
 *  and the journal (drafts + posted). Each pane is a heavy independent client
 *  tree, lazily mounted so only the active tab is live. */
const TransactionsWorkbench = dynamic(
  () => import('@/components/transactions/TransactionsWorkbench'),
  { ssr: false, loading: () => <PaneLoading /> },
)
const JournalEntryList = dynamic(() => import('@/components/bookkeeping/JournalEntryList'), {
  ssr: false,
  loading: () => <PaneLoading />,
})

// The invoice-inbox "Underlag" workspace is mounted through the extension
// registry (never a direct @/extensions import). Returns null in deployments
// where invoice-inbox is disabled — we then hide the tab rather than 404.
const InboxWorkspace = getWorkspaceComponent('general', 'invoice-inbox')
const inboxAvailable = InboxWorkspace != null

const TAB_KEYS = ['att-hantera', 'underlag', 'utkast', 'bokfort'] as const
type TabKey = (typeof TAB_KEYS)[number]

interface NextVoucher {
  next: number
  series: string
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function BokforingWorkspace({ userId }: { userId: string }) {
  const { toast } = useToast()
  const router = useRouter()
  const searchParams = useSearchParams()
  const t = useTranslations('bookkeeping')

  const copyFromId = useMemo<string | null>(() => {
    const raw = searchParams.get('copy_from')
    return raw && UUID_RE.test(raw) ? raw : null
  }, [searchParams])

  // Initial tab from ?tab (one-shot at mount); fall back to att-hantera, and
  // never land on a hidden Underlag tab. Tab state is owned locally afterwards.
  const [activeTab, setActiveTab] = useState<TabKey>(() => {
    const raw = searchParams.get('tab')
    if (raw && (TAB_KEYS as readonly string[]).includes(raw)) {
      if (raw === 'underlag' && !inboxAvailable) return 'att-hantera'
      return raw as TabKey
    }
    return 'att-hantera'
  })

  const [refreshKey, setRefreshKey] = useState(0)
  const [showNewEntry, setShowNewEntry] = useState(false)
  const [copyPrefill, setCopyPrefill] = useState<CopyPrefill | null>(null)
  const [isLoadingCopy, setIsLoadingCopy] = useState(false)
  const [nextVoucher, setNextVoucher] = useState<NextVoucher | null>(null)

  const handleTabChange = (raw: string) => {
    // Never settle on the Underlag tab in a deployment where invoice-inbox is
    // disabled (its trigger isn't rendered, but guard the URL defensively too).
    const tab: TabKey = raw === 'underlag' && !inboxAvailable ? 'att-hantera' : (raw as TabKey)
    setActiveTab(tab)
    const params = new URLSearchParams(searchParams.toString())
    params.set('tab', tab)
    params.delete('copy_from')
    router.replace(`/bookkeeping?${params.toString()}`, { scroll: false })
  }

  // React to copy_from in the URL: open the new-entry dialog prefilled from the
  // source voucher, then clear copy_from (preserving the current tab). Kept
  // reactive via useSearchParams so the in-list "Kopiera" button re-fires it.
  useEffect(() => {
    if (!copyFromId) return

    setShowNewEntry(true)
    setCopyPrefill(null)
    setIsLoadingCopy(true)

    fetch(`/api/bookkeeping/journal-entries/${encodeURIComponent(copyFromId)}`)
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
        const params = new URLSearchParams(searchParams.toString())
        params.delete('copy_from')
        params.set('tab', activeTab)
        router.replace(`/bookkeeping?${params.toString()}`, { scroll: false })
      })
    // eslint-disable-next-line react-hooks/exhaustive-deps -- run on copy_from change only, as the original page did
  }, [copyFromId, toast, router])

  // Next voucher number for today's period + default series, for the button
  // label. Re-runs after each commit so the hint stays current.
  useEffect(() => {
    let cancelled = false
    fetch('/api/bookkeeping/voucher-sequences/next')
      .then((r) => r.json())
      .then(({ data }) => {
        if (cancelled) return
        setNextVoucher(data?.next != null ? { next: data.next, series: data.series } : null)
      })
      .catch(() => {
        if (!cancelled) setNextVoucher(null)
      })
    return () => {
      cancelled = true
    }
  }, [refreshKey])

  // Actions for the journal tabs, rendered in-pane (not in the page header) so
  // the header stays a single stable "Bokföring" title and every tab keeps its
  // own controls at the same altitude.
  const journalToolbar = (
    <div className="flex flex-wrap justify-end gap-2">
      <Button
        size="sm"
        onClick={() => {
          setCopyPrefill(null)
          setShowNewEntry(true)
        }}
      >
        <Plus className="mr-2 h-4 w-4" />
        {t('tab_new_entry')}
        {nextVoucher && (
          <span className="ml-1 text-primary-foreground/70 tabular-nums">
            ({nextVoucher.series}
            {nextVoucher.next})
          </span>
        )}
      </Button>
      <AgentSparkleButton
        intentId="verifikation.draft"
        contextRef="verifikation:new"
        label={t('create_with_assistant')}
        size="sm"
      />
    </div>
  )

  return (
    <div className="space-y-6">
      <PageHeader title={t('title')} />

      <Tabs value={activeTab} onValueChange={handleTabChange} className="space-y-6">
        <TabsList>
          <TabsTrigger value="att-hantera">{t('tab_att_hantera')}</TabsTrigger>
          {inboxAvailable && <TabsTrigger value="underlag">{t('tab_underlag')}</TabsTrigger>}
          <TabsTrigger value="utkast">{t('tab_utkast')}</TabsTrigger>
          <TabsTrigger value="bokfort">{t('tab_bokfort')}</TabsTrigger>
        </TabsList>

        <TabsContent value="att-hantera">
          <TransactionsWorkbench />
        </TabsContent>

        {inboxAvailable && InboxWorkspace && (
          <TabsContent value="underlag">
            <InboxWorkspace userId={userId} />
          </TabsContent>
        )}

        <TabsContent value="utkast">
          <div className="space-y-4">
            {journalToolbar}
            <JournalEntryList key={`drafts-${refreshKey}`} initialMode="drafts" hideModeToggle />
          </div>
        </TabsContent>

        <TabsContent value="bokfort">
          <div className="space-y-4">
            {journalToolbar}
            <JournalEntryList key={`committed-${refreshKey}`} initialMode="committed" hideModeToggle />
          </div>
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

function PaneLoading() {
  return (
    <div className="flex items-center gap-3 p-6 text-muted-foreground">
      <Loader2 className="h-5 w-5 animate-spin" />
      Laddar…
    </div>
  )
}
