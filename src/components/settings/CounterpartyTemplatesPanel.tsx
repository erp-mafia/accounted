'use client'

import { useTranslations } from 'next-intl'
import { useState, useEffect, useCallback } from 'react'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { EmptyState, LoadError } from '@/components/ui/empty-state'
import { Input } from '@/components/ui/input'
import { useToast } from '@/components/ui/use-toast'
import { useViewerLock } from '@/components/ui/viewer-lock'
import { SettingsGroup } from '@/components/settings/SettingsRows'
import { ChevronDownIcon, PencilIcon, TrashIcon, UsersIcon } from '@/components/icons'
import { formatAccountWithName } from '@/lib/bookkeeping/client-account-names'
import { formatCounterpartyName } from '@/lib/bookkeeping/counterparty-template-format'
import type { CategorizationTemplate } from '@/types'

function formatDate(iso: string | null) {
  if (!iso) return '-'
  return new Date(iso).toLocaleDateString('sv-SE', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  })
}

function confidenceColor(c: number): string {
  if (c >= 0.8) return 'text-success'
  if (c >= 0.5) return 'text-warning'
  return 'text-muted-foreground'
}

export function CounterpartyTemplatesPanel() {
  const t = useTranslations('settings_counterparty_templates')
  const { toast } = useToast()
  const { canWrite, lockedTitle } = useViewerLock()

  const SOURCE_LABELS: Record<string, string> = {
    sie_import: t('source_sie_import'),
    user_approved: t('source_user_approved'),
    auto_learned: t('source_auto_learned'),
    sni_default: t('source_sni_default'),
  }

  const VAT_LABELS: Record<string, string> = {
    standard_25: '25%',
    reduced_12: '12%',
    reduced_6: '6%',
    reverse_charge: t('vat_reverse_charge'),
    export: t('vat_export'),
    exempt: t('vat_exempt'),
    unknown: t('vat_unknown'),
  }

  const [templates, setTemplates] = useState<CategorizationTemplate[]>([])
  const [isLoading, setIsLoading] = useState(true)
  // The list could not be read: it says so in place of the rows, never the
  // "no templates yet" state, which is only true after a real answer.
  const [loadFailed, setLoadFailed] = useState(false)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editName, setEditName] = useState('')
  const [savingId, setSavingId] = useState<string | null>(null)

  const fetchTemplates = useCallback(async () => {
    try {
      const res = await fetch('/api/settings/counterparty-templates')
      if (!res.ok) {
        setLoadFailed(true)
        return
      }
      const json = await res.json()
      if (!Array.isArray(json?.data)) {
        setLoadFailed(true)
        return
      }
      setTemplates(json.data)
      setLoadFailed(false)
    } catch {
      setLoadFailed(true)
    } finally {
      setIsLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchTemplates()
  }, [fetchTemplates])

  async function handleDelete(id: string) {
    setDeletingId(id)
    try {
      const res = await fetch('/api/settings/counterparty-templates', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
      })
      if (!res.ok) {
        toast({ title: t('toast_delete_failed'), variant: 'destructive' })
        return
      }
      setTemplates((prev) => prev.filter((tt) => tt.id !== id))
      if (expandedId === id) setExpandedId(null)
      toast({ title: t('toast_deleted') })
    } catch {
      toast({ title: t('toast_delete_failed'), variant: 'destructive' })
    } finally {
      setDeletingId(null)
    }
  }

  function startRename(tt: CategorizationTemplate) {
    setEditingId(tt.id)
    setEditName(formatCounterpartyName(tt.counterparty_name))
  }

  function cancelRename() {
    setEditingId(null)
    setEditName('')
  }

  async function handleRename(id: string) {
    const name = editName.trim()
    if (!name) return
    setSavingId(id)
    try {
      const res = await fetch('/api/settings/counterparty-templates', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, counterparty_name: name }),
      })
      if (res.status === 409) {
        toast({ title: t('toast_duplicate_name'), variant: 'destructive' })
        return
      }
      if (!res.ok) {
        toast({ title: t('toast_rename_failed'), variant: 'destructive' })
        return
      }
      const json = (await res.json()) as { data?: CategorizationTemplate }
      if (json.data) {
        const updated = json.data
        setTemplates((prev) => prev.map((tt) => (tt.id === id ? { ...tt, ...updated } : tt)))
      }
      cancelRename()
      toast({ title: t('toast_renamed') })
    } catch {
      toast({ title: t('toast_rename_failed'), variant: 'destructive' })
    } finally {
      setSavingId(null)
    }
  }

  return (
    <SettingsGroup label={t('title')} help={t('description')}>
      {isLoading ? (
        <div aria-busy className="space-y-3 py-3">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-4 w-full" />
          ))}
        </div>
      ) : loadFailed && templates.length === 0 ? (
        <LoadError
          title={t('toast_fetch_failed')}
          onRetry={() => {
            setIsLoading(true)
            void fetchTemplates()
          }}
        />
      ) : templates.length === 0 ? (
        <EmptyState
          icon={UsersIcon}
          title={t('empty_title')}
          description={t('empty_help')}
        />
      ) : (
        templates.map((tt) => {
          const isExpanded = expandedId === tt.id
          const isMultiLine = tt.line_pattern && tt.line_pattern.length > 0

          return (
            <div key={tt.id} className="border-b-hairline">
              {/* Clickable summary row: flat hairline, one line. */}
              <button
                type="button"
                onClick={() => setExpandedId(isExpanded ? null : tt.id)}
                aria-expanded={isExpanded}
                className="flex w-full items-center gap-3 px-1 py-3 text-left transition-colors duration-150 hover:bg-secondary/60"
              >
                <div className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-3 gap-y-1">
                  <span className="truncate text-sm">{formatCounterpartyName(tt.counterparty_name)}</span>
                  <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                    {isMultiLine ? (
                      <span className="font-mono">
                        {tt.line_pattern!.filter(lp => lp.type === 'business').map(lp => lp.account).join(', ')}
                      </span>
                    ) : (
                      <span className="font-mono">
                        {tt.debit_account}
                        <span className="text-muted-foreground"> → </span>
                        {tt.credit_account}
                      </span>
                    )}
                    {tt.vat_treatment && (
                      <span>· {VAT_LABELS[tt.vat_treatment] || tt.vat_treatment}</span>
                    )}
                    <span>· {t('times_count', { count: tt.occurrence_count })}</span>
                    <span className={`tabular-nums ${confidenceColor(Number(tt.confidence))}`}>
                      {Math.round(Number(tt.confidence) * 100)}%
                    </span>
                    <span>· {SOURCE_LABELS[tt.source] || tt.source}</span>
                  </span>
                </div>
                <ChevronDownIcon
                  className={`h-4 w-4 shrink-0 text-muted-foreground transition-transform ${isExpanded ? 'rotate-180' : ''}`}
                />
              </button>

              {/* Expanded detail */}
              {isExpanded && (
                <div className="space-y-3 px-1 pb-3">
                  {/* Account lines */}
                  <div>
                    <p className="mb-2 text-xs font-medium text-muted-foreground">{t('booking_label')}</p>
                    {isMultiLine ? (
                      <div className="space-y-1">
                        {tt.line_pattern!.map((lp, i) => (
                          <div key={i} className="flex items-center gap-2 text-xs">
                            <span className="w-14 shrink-0 text-xs text-muted-foreground">
                              {lp.side === 'debit' ? t('debit_label') : t('credit_label')}
                            </span>
                            <span className="font-mono">{formatAccountWithName(lp.account)}</span>
                            {lp.type === 'vat' && lp.vat_rate && (
                              <span className="text-muted-foreground">{t('vat_paren', { rate: Math.round(lp.vat_rate * 100) })}</span>
                            )}
                            {lp.ratio !== undefined && (
                              <span className="text-muted-foreground">({Math.round(lp.ratio * 100)}%)</span>
                            )}
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className="space-y-1">
                        <div className="flex items-center gap-2 text-xs">
                          <span className="w-14 shrink-0 text-xs text-muted-foreground">{t('debit_label')}</span>
                          <span className="font-mono">{formatAccountWithName(tt.debit_account)}</span>
                        </div>
                        <div className="flex items-center gap-2 text-xs">
                          <span className="w-14 shrink-0 text-xs text-muted-foreground">{t('credit_label')}</span>
                          <span className="font-mono">{formatAccountWithName(tt.credit_account)}</span>
                        </div>
                      </div>
                    )}
                  </div>

                  {/* Metadata */}
                  <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-xs">
                    {tt.vat_treatment && (
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">{t('vat_label')}</span>
                        <span>{VAT_LABELS[tt.vat_treatment] || tt.vat_treatment}</span>
                      </div>
                    )}
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">{t('occurrence_count_label')}</span>
                      <span className="tabular-nums">{tt.occurrence_count}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">{t('confidence_label')}</span>
                      <span className={`tabular-nums ${confidenceColor(Number(tt.confidence))}`}>
                        {Math.round(Number(tt.confidence) * 100)}%
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">{t('last_seen_label')}</span>
                      <span>{formatDate(tt.last_seen_date)}</span>
                    </div>
                    {tt.counterparty_aliases && tt.counterparty_aliases.length > 1 && (
                      <div className="col-span-2 flex justify-between">
                        <span className="text-muted-foreground">{t('aliases_label')}</span>
                        <span className="ml-4 truncate text-right">{tt.counterparty_aliases.slice(0, 3).join(', ')}{tt.counterparty_aliases.length > 3 ? ` +${tt.counterparty_aliases.length - 3}` : ''}</span>
                      </div>
                    )}
                  </div>

                  {/* Rename + delete */}
                  {editingId === tt.id ? (
                    <form
                      className="flex items-center gap-2 pt-1"
                      onSubmit={(e) => {
                        e.preventDefault()
                        handleRename(tt.id)
                      }}
                    >
                      <Input
                        value={editName}
                        onChange={(e) => setEditName(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Escape') cancelRename()
                        }}
                        maxLength={100}
                        autoFocus
                        aria-label={t('rename_label')}
                        className="h-8 max-w-xs text-sm"
                      />
                      <Button
                        type="submit"
                        disabled={editName.trim().length < 2}
                        loading={savingId === tt.id}
                      >
                        {t('rename_save')}
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        onClick={cancelRename}
                        disabled={savingId === tt.id}
                      >
                        {t('rename_cancel')}
                      </Button>
                    </form>
                  ) : (
                  <div className="flex justify-end gap-2 pt-1">
                    <Button
                      variant="outline"
                      onClick={() => startRename(tt)}
                      disabled={!canWrite || deletingId === tt.id}
                      title={lockedTitle}
                    >
                      <PencilIcon className="h-3 w-3" />
                      {t('rename_button')}
                    </Button>
                    <Button
                      variant="outline"
                      onClick={() => handleDelete(tt.id)}
                      loading={deletingId === tt.id}
                      disabled={!canWrite}
                      title={lockedTitle}
                      className="text-destructive hover:text-destructive"
                    >
                      {deletingId !== tt.id && <TrashIcon className="h-3 w-3" />}
                      {t('delete_button')}
                    </Button>
                  </div>
                  )}
                </div>
              )}
            </div>
          )
        })
      )}
    </SettingsGroup>
  )
}
