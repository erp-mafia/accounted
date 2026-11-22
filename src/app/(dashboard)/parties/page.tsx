'use client'

import { Suspense, useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { useLocale, useTranslations } from 'next-intl'
import { ContextPicker } from '@/components/common/ContextPicker'
import { AttnLine } from '@/components/ui/attn-line'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { QUIET_LINK_CLASS } from '@/components/ui/dry-table'
import { EmptyState, LoadError } from '@/components/ui/empty-state'
import { HelpPopover } from '@/components/ui/help-popover'
import { Input } from '@/components/ui/input'
import { PageHeader } from '@/components/ui/page-header'
import { LateReveal, Skeleton } from '@/components/ui/skeleton'
import { ToastAction } from '@/components/ui/toast'
import { ToolbarSearch, TOOLBAR_SEARCH_END_CLASS } from '@/components/ui/toolbar-search'
import { useToast } from '@/components/ui/use-toast'
import { CounterpartList } from '@/components/parties/CounterpartList'
import { MergeDialog, type MergeCandidate } from '@/components/parties/MergeDialog'
import { PartyDossier } from '@/components/parties/PartyDossier'
import { ScbPickerDialog } from '@/components/parties/ScbPickerDialog'
import type { ScbCandidate } from '@/lib/parties/scb/client'
import { useCanWrite } from '@/lib/hooks/use-can-write'
import type { CounterpartList as CounterpartListData, CounterpartRow } from '@/lib/parties/list'
import type { PartyRole, RegisterPeriod } from '@/lib/parties/register'
import { refreshCounterparts } from '@/lib/parties/refresh'
import { getErrorMessage, type ErrorLocale } from '@/lib/errors/get-error-message'

/** A refused POST, with the route's body so the toast can say why (not only "Det gick inte"). */
class PostRefused extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
  ) {
    super(String(status))
  }
}

async function post<T>(url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (!res.ok) throw new PostRefused(res.status, await res.json().catch(() => null))
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
  const errorLocale = locale as ErrorLocale
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
  const searchParams = useSearchParams()

  // ?party=<id> opens the dossier straight away: the archive and the graph link to a counterparty this way.
  useEffect(() => {
    const id = searchParams.get('party')
    if (id && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) setDossierId(id)
  }, [searchParams])

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

  const fail = useCallback(
    (err?: unknown) =>
      toast({
        title:
          err instanceof PostRefused
            ? getErrorMessage(err.body, { statusCode: err.status, locale: errorLocale, fallback: t('cp_action_failed') })
            : getErrorMessage(err, { locale: errorLocale, fallback: t('cp_action_failed') }),
        variant: 'destructive',
      }),
    [toast, t, errorLocale],
  )

  // Read new ledger suggestions and bank strings on the explicit action.
  const refresh = useCallback(
    async () => {
      if (refreshing) return
      setRefreshing(true)
      try {
        const result = await refreshCounterparts(post)
        if (result.status === 'success') toast({ title: t('cp_refreshed', { count: result.count }) })
        else toast({ title: t(result.status === 'partial' ? 'cp_refresh_partial' : 'cp_refresh_failed'), variant: 'destructive' })
      } finally {
        // Attachments, merges and partially committed requests also change rows.
        reload()
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
    } catch (err) {
      fail(err)
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
    } catch (err) {
      fail(err)
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
    } catch (err) {
      fail(err)
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
    } catch (err) {
      fail(err)
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
    } catch (err) {
      fail(err)
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
            <button type="button" className={QUIET_LINK_CLASS} disabled={refreshing} onClick={() => void refresh()}>
              {refreshing ? t('cp_refreshing') : t('cp_refresh')}
            </button>
          ) : undefined
        }
      />

      {/* Toolbar: the period filter first, search at the right end (V7 list toolbars). */}
      <div className="flex flex-wrap items-center gap-2">
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
        <ToolbarSearch
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t('cp_search')}
          aria-label={t('cp_search')}
          containerClassName={TOOLBAR_SEARCH_END_CLASS}
        />
      </div>

      {/* A failed reload keeps the rows on screen, with one line above them. */}
      {failed && list && (
        <AttnLine action={{ label: tCommon('retry'), onClick: reload }}>{tCommon('refresh_failed')}</AttnLine>
      )}

      {failed && !list ? (
        <LoadError title={t('cp_load_failed')} onRetry={reload} />
      ) : loading && !list ? (
        <LateReveal>
          {[1, 2, 3, 4, 5, 6].map((i) => (
            <div key={i} className="flex h-11 items-center gap-8 border-b-hairline">
              <Skeleton className="h-3.5 w-48" />
              <Skeleton className="ml-auto h-3.5 w-24" />
              <Skeleton className="h-3.5 w-20" />
            </div>
          ))}
        </LateReveal>
      ) : rows.length === 0 && debounced ? (
        <div className="flex flex-wrap items-center gap-x-3 py-3 text-[13px] text-muted-foreground">
          <span>{t('cp_empty_search')}</span>
          <Button variant="link" onClick={() => setQuery('')}>
            {tCommon('clear_search')}
          </Button>
        </div>
      ) : rows.length === 0 && period === '12m' ? (
        // The default view is the last 12 months: older counterparts may exist.
        <EmptyState
          title={t('cp_empty_12m_title')}
          description={t('cp_empty')}
          secondaryActionLabel={t('cp_empty_show_all')}
          onSecondaryAction={() => setPeriod('all')}
        />
      ) : rows.length === 0 ? (
        <EmptyState title={t('cp_empty_title')} description={t('cp_empty')} />
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
        <p className="text-xs text-muted-foreground">
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
