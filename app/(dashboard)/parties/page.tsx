'use client'

import { Suspense, useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { useLocale, useTranslations } from 'next-intl'
import { ContextPicker } from '@/components/common/ContextPicker'
import { AttnLine } from '@/components/ui/attn-line'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { QUIET_LINK_CLASS } from '@/components/ui/dry-table'
import { EmptyState } from '@/components/ui/empty-state'
import { HelpPopover } from '@/components/ui/help-popover'
import { Input } from '@/components/ui/input'
import { PageHeader } from '@/components/ui/page-header'
import { Skeleton } from '@/components/ui/skeleton'
import { ToastAction } from '@/components/ui/toast'
import { ToolbarSearch } from '@/components/ui/toolbar-search'
import { useToast } from '@/components/ui/use-toast'
import { CounterpartList } from '@/components/parties/CounterpartList'
import { MergeDialog, type MergeCandidate } from '@/components/parties/MergeDialog'
import { PartyDossier } from '@/components/parties/PartyDossier'
import { ScbPickerDialog } from '@/components/parties/ScbPickerDialog'
import type { ScbCandidate } from '@/lib/parties/scb/client'
import { useCanWrite } from '@/lib/hooks/use-can-write'
import type { CounterpartList as CounterpartListData, CounterpartRow } from '@/lib/parties/list'
import type { PartyRole, RegisterPeriod } from '@/lib/parties/register'

async function post<T>(url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (!res.ok) throw new Error(String(res.status))
  const json = (await res.json()) as { data: T }
  return json.data
}

/**
 * Motparter: the other side of every transaction, one list. Names come from
 * the bank text, the documents and the register; a suggestion is a row like
 * any other, marked "ny", and the actions live on the row. Unnamed spend
 * stays off the list and shows on the transactions as cleansed text.
 */
function CounterpartsPage() {
  const t = useTranslations('parties')
  const tCommon = useTranslations('common')
  const locale = useLocale()
  const { toast } = useToast()
  const { canWrite } = useCanWrite()

  const [query, setQuery] = useState('')
  const [debounced, setDebounced] = useState('')
  const [period, setPeriod] = useState<RegisterPeriod>('12m')
  const [list, setList] = useState<CounterpartListData | null>(null)
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)
  const [reloadKey, setReloadKey] = useState(0)
  const [busy, setBusy] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [fetchingRegistry, setFetchingRegistry] = useState(false)
  const [dossierId, setDossierId] = useState<string | null>(null)
  const [dossierReload, setDossierReload] = useState(0)
  const [merge, setMerge] = useState<{ subject: MergeCandidate; suggested: MergeCandidate[] } | null>(null)
  const [picker, setPicker] = useState<{ partyId: string; name: string } | null>(null)
  const [rename, setRename] = useState<{ row: CounterpartRow; name: string } | null>(null)

  useEffect(() => {
    const id = setTimeout(() => setDebounced(query.trim()), 250)
    return () => clearTimeout(id)
  }, [query])

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    const params = new URLSearchParams({ period })
    if (debounced) params.set('q', debounced)
    fetch(`/api/parties/list?${params.toString()}`)
      .then(async (res) => {
        if (!res.ok) throw new Error(String(res.status))
        const json = (await res.json()) as { data: CounterpartListData }
        if (!cancelled) {
          setList(json.data)
          setFailed(false)
        }
      })
      .catch(() => {
        if (!cancelled) setFailed(true)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [debounced, period, reloadKey])

  const reload = useCallback(() => {
    setReloadKey((k) => k + 1)
    setDossierReload((k) => k + 1)
  }, [])

  const fail = useCallback(() => toast({ title: t('cp_action_failed'), variant: 'destructive' }), [toast, t])

  // Read what is new: the ledger's suggestions and the bank strings the
  // resolver has not seen. Once per visit by itself, and on the quiet link.
  const refresh = useCallback(
    async (auto: boolean) => {
      if (refreshing) return
      setRefreshing(true)
      try {
        const [suggested, resolved] = await Promise.all([
          post<{ created: number; attached: number }>('/api/parties/suggest').catch(() => ({ created: 0, attached: 0 })),
          post<{ written: number }>('/api/parties/resolver/run').catch(() => ({ written: 0 })),
        ])
        const count = suggested.created + resolved.written
        if (!auto || count > 0) toast({ title: t('cp_refreshed', { count }) })
        if (count > 0) reload()
      } catch {
        if (!auto) toast({ title: t('cp_refresh_failed'), variant: 'destructive' })
      } finally {
        setRefreshing(false)
      }
    },
    [refreshing, toast, t, reload],
  )

  // Opening the page reads; it never writes. New bank strings are read by
  // the nightly resolver cron, or when the person presses Läs nya.

  function undoToast(title: string, undoUrl: string, ids: string[]) {
    toast({
      title,
      action: (
        <ToastAction altText={tCommon('undo')} onClick={() => void post(undoUrl, { partyIds: ids }).then(reload).catch(fail)}>
          {tCommon('undo')}
        </ToastAction>
      ),
    })
  }

  async function promote(partyId: string, roles: PartyRole[]) {
    setBusy(true)
    try {
      await post('/api/parties/promote', { items: [{ partyId, roles }] })
      undoToast(t('promoted_title', { count: 1, detail: roles.includes('supplier') ? t('summary_suppliers', { count: 1 }) : t('summary_customers', { count: 1 }) }), '/api/parties/promote/undo', [partyId])
      reload()
    } catch {
      fail()
    } finally {
      setBusy(false)
    }
  }

  async function dismiss(partyId: string) {
    setBusy(true)
    try {
      await post('/api/parties/decide', { partyIds: [partyId], kind: 'dismiss' })
      undoToast(t('dismissed_title', { count: 1 }), '/api/parties/decide/undo', [partyId])
      reload()
    } catch {
      fail()
    } finally {
      setBusy(false)
    }
  }

  async function runMerge(survivorId: string, mergedIds: string[]) {
    setBusy(true)
    try {
      const { decisionId } = await post<{ decisionId: string }>('/api/parties/merge', { survivorId, mergedIds })
      toast({
        title: t('merged_title'),
        action: (
          <ToastAction altText={tCommon('undo')} onClick={() => void post('/api/parties/merge/undo', { decisionId }).then(reload).catch(fail)}>
            {tCommon('undo')}
          </ToastAction>
        ),
      })
      setMerge(null)
      reload()
    } catch {
      fail()
    } finally {
      setBusy(false)
    }
  }

  async function fetchRegistry(id: string, orgNumber?: string) {
    setFetchingRegistry(true)
    try {
      const res = await fetch(`/api/parties/${id}/enrich`, {
        method: 'POST',
        headers: orgNumber ? { 'Content-Type': 'application/json' } : undefined,
        body: orgNumber ? JSON.stringify({ orgNumber }) : undefined,
      })
      const json = (await res.json()) as { data?: { found: boolean; orgNumber: string; inserted: number; superseded: number; refreshed: number } }
      if (!res.ok || !json.data) {
        toast({ title: t('registry_unavailable_title'), variant: 'destructive' })
        return
      }
      setPicker(null)
      if (!json.data.found) {
        toast({ title: t('registry_not_found_title'), description: t('registry_not_found_description', { org: json.data.orgNumber }) })
        return
      }
      toast({ title: t('registry_fetched_title'), description: t('registry_fetched_description', { inserted: json.data.inserted, superseded: json.data.superseded, refreshed: json.data.refreshed }) })
      setDossierReload((k) => k + 1)
    } catch {
      toast({ title: t('registry_unavailable_title'), variant: 'destructive' })
    } finally {
      setFetchingRegistry(false)
    }
  }

  async function saveRename() {
    if (!rename) return
    const name = rename.name.trim()
    if (!name) return
    setBusy(true)
    try {
      await post('/api/parties/aliases', { aliasKeys: rename.row.aliasKeys, action: 'rename', name })
      toast({ title: t('cp_renamed') })
      setRename(null)
      reload()
    } catch {
      fail()
    } finally {
      setBusy(false)
    }
  }

  async function notSame(row: CounterpartRow) {
    setBusy(true)
    try {
      await post('/api/parties/aliases', { aliasKeys: row.aliasKeys, action: 'not_same' })
      toast({ title: t('cp_not_same_done') })
      reload()
    } catch {
      fail()
    } finally {
      setBusy(false)
    }
  }

  const rows = list?.rows ?? []
  const scbEnabled = !!list?.scbConfigured

  return (
    <div className="space-y-4">
      <PageHeader
        title={t('cp_title')}
        help={<HelpPopover>{t('cp_help')}</HelpPopover>}
        action={
          canWrite ? (
            <button type="button" className={QUIET_LINK_CLASS} disabled={refreshing} onClick={() => void refresh(false)}>
              {refreshing ? t('cp_refreshing') : t('cp_refresh')}
            </button>
          ) : undefined
        }
      />

      <div className="flex flex-wrap items-center gap-2">
        <ToolbarSearch value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t('cp_search')} aria-label={t('cp_search')} />
        <div className="ml-auto">
          <ContextPicker
            ariaLabel={t('period_label')}
            triggerLabel={period === '12m' ? t('period_12m') : t('period_all')}
            items={[
              { id: '12m', label: t('period_12m') },
              { id: 'all', label: t('period_all') },
            ]}
            value={period}
            onChange={(id) => setPeriod(id as RegisterPeriod)}
          />
        </div>
      </div>

      {failed ? (
        <AttnLine action={{ label: t('cp_retry'), onClick: reload }}>{t('cp_load_failed')}</AttnLine>
      ) : loading && !list ? (
        <div className="space-y-2" aria-busy>
          <Skeleton className="h-9 w-full" />
          <Skeleton className="h-9 w-full" />
          <Skeleton className="h-9 w-full" />
        </div>
      ) : rows.length === 0 ? (
        <EmptyState
          title={debounced ? t('cp_empty_search') : t('cp_empty_title')}
          description={debounced ? t('empty_search_description') : t('cp_empty')}
        />
      ) : (
        <CounterpartList
          rows={rows}
          locale={locale}
          canWrite={canWrite}
          onOpen={(row) => row.partyId && setDossierId(row.partyId)}
          onRename={(row) => setRename({ row, name: row.name })}
          onNotSame={(row) => void notSame(row)}
          onMerge={(row) =>
            row.partyId && setMerge({ subject: { id: row.partyId, displayName: row.name, orgNumber: row.orgNumber, status: row.status }, suggested: [] })
          }
          onPromote={(row, roles) => row.partyId && void promote(row.partyId, roles)}
          onDismiss={(row) => row.partyId && void dismiss(row.partyId)}
        />
      )}

      {list && list.counts.unnamedTransactions > 0 ? (
        <p className="text-[12.5px] text-muted-foreground">
          {t('cp_unnamed', { count: list.counts.unnamedTransactions })}
          {' · '}
          <Link href="/transactions" className={QUIET_LINK_CLASS}>
            {t('cp_unnamed_link')}
          </Link>
        </p>
      ) : null}

      <PartyDossier
        partyId={dossierId}
        period={period}
        canWrite={canWrite}
        busy={busy}
        reloadKey={dossierReload}
        onClose={() => setDossierId(null)}
        onPromote={(id, roles) => void promote(id, roles)}
        onDismiss={(id) => {
          void dismiss(id)
          setDossierId(null)
        }}
        onMerge={(subject, suggested) => setMerge({ subject, suggested })}
        onFetchRegistry={scbEnabled ? (id) => void fetchRegistry(id) : undefined}
        onPickRegistry={scbEnabled ? (id, name) => setPicker({ partyId: id, name }) : undefined}
        fetching={fetchingRegistry}
      />

      {picker ? (
        <ScbPickerDialog
          open
          onOpenChange={(open) => (!open ? setPicker(null) : undefined)}
          partyId={picker.partyId}
          partyName={picker.name}
          busy={fetchingRegistry}
          onPick={async (c: ScbCandidate) => {
            await fetchRegistry(picker.partyId, c.orgNumber)
          }}
        />
      ) : null}

      {merge ? (
        <MergeDialog open onOpenChange={(open) => (!open ? setMerge(null) : undefined)} subject={merge.subject} suggested={merge.suggested} busy={busy} onMerge={runMerge} />
      ) : null}

      <Dialog open={!!rename} onOpenChange={(open) => (!open ? setRename(null) : undefined)}>
        {rename ? (
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{t('cp_rename_title')}</DialogTitle>
              <DialogDescription>{t('cp_rename_body', { sample: rename.row.name })}</DialogDescription>
            </DialogHeader>
            <Input
              autoFocus
              value={rename.name}
              placeholder={t('cp_rename_placeholder')}
              onChange={(e) => setRename({ row: rename.row, name: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void saveRename()
              }}
            />
            <DialogFooter>
              <Button variant="outline" onClick={() => setRename(null)}>
                {tCommon('cancel')}
              </Button>
              <Button onClick={() => void saveRename()} disabled={busy || !rename.name.trim()}>
                {t('cp_rename_save')}
              </Button>
            </DialogFooter>
          </DialogContent>
        ) : null}
      </Dialog>
    </div>
  )
}

export default function PartiesPage() {
  return (
    <Suspense fallback={null}>
      <CounterpartsPage />
    </Suspense>
  )
}
