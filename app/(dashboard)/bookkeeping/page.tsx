'use client'

import { useState, useEffect, useMemo } from 'react'
import dynamic from 'next/dynamic'
import { useRouter, useSearchParams } from 'next/navigation'
import { useTranslations } from 'next-intl'
import JournalEntryList from '@/components/bookkeeping/JournalEntryList'
import { StartCard } from '@/components/dashboard/StartCard'
import { type FormLine } from '@/components/bookkeeping/JournalEntryForm'
import type { CopyPrefill } from '@/components/bookkeeping/NewJournalEntryDialog'
import { DialogLoadingSkeleton } from '@/components/ui/dialog-loading-skeleton'
import { SplitButton } from '@/components/ui/split-button'
import { useAgentSheet } from '@/components/agent/AgentSheetProvider'
import { useUiState } from '@/lib/hooks/use-ui-state'
import { resolveInitialMode } from '@/lib/ui-state/client'
import { useToast } from '@/components/ui/use-toast'
import { Plus, LayoutTemplate, Sparkles } from 'lucide-react'
import { PageHeader } from '@/components/ui/page-header'
import { formatVoucher } from '@/lib/bookkeeping/voucher-series-resolver'
import type { JournalEntry, JournalEntryLine } from '@/types'

const NewJournalEntryDialog = dynamic(
  () => import('@/components/bookkeeping/NewJournalEntryDialog'),
  { loading: DialogLoadingSkeleton },
)
const TemplateBookDialog = dynamic(
  () => import('@/components/bookkeeping/TemplateBookDialog'),
  { loading: DialogLoadingSkeleton },
)

// SplitButton modes for "Nytt verifikat" (concept scene 9). The last-used
// mode persists per user in ui_state.create_mode.bookkeeping.
const CREATE_MODES = ['tomt', 'mall', 'assistent'] as const

interface NextVoucher {
  next: number
  series: string
}

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
  const [showNewEntry, setShowNewEntry] = useState(false)
  const [showTemplateDialog, setShowTemplateDialog] = useState(false)
  const [copyPrefill, setCopyPrefill] = useState<CopyPrefill | null>(null)
  const [isLoadingCopy, setIsLoadingCopy] = useState(false)
  const [nextVoucher, setNextVoucher] = useState<NextVoucher | null>(null)
  const t = useTranslations('bookkeeping')
  const tStart = useTranslations('start_cards')
  const { openAgentSheet } = useAgentSheet()
  const { uiState, loaded: uiStateLoaded } = useUiState()

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
          <SplitButton
            // Remount once ui_state loads so the primary face re-resolves
            // to the persisted last-used mode.
            key={uiStateLoaded ? 'loaded' : 'initial'}
            persistKey="bookkeeping"
            initialModeKey={resolveInitialMode(uiState, 'bookkeeping', CREATE_MODES, 'tomt')}
            options={[
              {
                key: 'tomt',
                label: nextVoucher
                  ? `${t('create_tomt')} (${nextVoucher.series}${nextVoucher.next})`
                  : t('create_tomt'),
                icon: Plus,
                description: t('create_tomt_desc'),
                onSelect: () => {
                  setCopyPrefill(null)
                  setShowNewEntry(true)
                },
              },
              {
                key: 'mall',
                label: t('create_mall'),
                icon: LayoutTemplate,
                description: t('create_mall_desc'),
                onSelect: () => setShowTemplateDialog(true),
              },
              {
                key: 'assistent',
                label: t('create_with_assistant'),
                icon: Sparkles,
                description: t('create_assistent_desc'),
                onSelect: () =>
                  openAgentSheet({
                    intentId: 'verifikation.draft',
                    contextRef: 'verifikation:new',
                  }),
              },
            ]}
          />
        }
      />

      <JournalEntryList
        key={refreshKey}
        pristineSlot={
          <div className="animate-fade-in space-y-4">
            <StartCard
              card="ledger"
              layout="bleed-left"
              title={tStart('bookkeeping_title')}
              body={tStart('bookkeeping_body')}
              primary={{ label: tStart('bookkeeping_primary'), href: '/import?mode=migration' }}
              secondary={{ label: tStart('bookkeeping_secondary'), href: '/import?mode=sie' }}
            />
            {/* The split button's three create modes, laid out as cards so the
                pristine page shows what the ledger can do instead of a bare table. */}
            <div className="grid gap-4 sm:grid-cols-3">
              {(
                [
                  ['mall', () => setShowTemplateDialog(true)],
                  [
                    'assistent',
                    () => openAgentSheet({ intentId: 'verifikation.draft', contextRef: 'verifikation:new' }),
                  ],
                  [
                    'tomt',
                    () => {
                      setCopyPrefill(null)
                      setShowNewEntry(true)
                    },
                  ],
                ] as const
              ).map(([mode, onClick]) => (
                <button
                  key={mode}
                  type="button"
                  onClick={onClick}
                  className="rounded-lg border border-border bg-background p-4 text-left transition-colors duration-150 hover:bg-secondary/35 active:bg-secondary/35 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <div className="text-[13px] font-medium">{tStart(`bookkeeping_mini_${mode}_title`)}</div>
                  <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                    {tStart(`bookkeeping_mini_${mode}_body`)}
                  </p>
                </button>
              ))}
            </div>
          </div>
        }
      />

      {showTemplateDialog && (
        <TemplateBookDialog
          open
          onOpenChange={setShowTemplateDialog}
          onCreated={() => setRefreshKey((k) => k + 1)}
        />
      )}

      {showNewEntry && (
        <NewJournalEntryDialog
          open
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
      )}
    </div>
  )
}
