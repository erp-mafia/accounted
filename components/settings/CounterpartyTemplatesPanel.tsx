'use client'

import { useTranslations } from 'next-intl'
import { useState, useEffect, useCallback } from 'react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { useToast } from '@/components/ui/use-toast'
import { Loader2, Trash2, Users, ChevronDown } from 'lucide-react'
import { formatAccountWithName } from '@/lib/bookkeeping/client-account-names'
import { formatCounterpartyName } from '@/lib/bookkeeping/counterparty-templates'
import type { CategorizationTemplate } from '@/types'

function formatDate(iso: string | null) {
  if (!iso) return '—'
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
  }

  const [templates, setTemplates] = useState<CategorizationTemplate[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [expandedId, setExpandedId] = useState<string | null>(null)

  const fetchTemplates = useCallback(async () => {
    try {
      const res = await fetch('/api/settings/counterparty-templates')
      const json = await res.json()
      if (json.data) {
        setTemplates(json.data)
      }
    } catch {
      toast({ title: t('toast_fetch_failed'), variant: 'destructive' })
    } finally {
      setIsLoading(false)
    }
  }, [toast, t])

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

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>{t('title')}</CardTitle>
          <CardDescription>
            {t('description')}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : templates.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-8 text-center">
              <Users className="h-8 w-8 text-muted-foreground/50 mb-3" />
              <p className="text-sm text-muted-foreground">{t('empty_title')}</p>
              <p className="text-xs text-muted-foreground mt-1">
                {t('empty_help')}
              </p>
            </div>
          ) : (
            <div className="space-y-1">
              {templates.map((tt) => {
                const isExpanded = expandedId === tt.id
                const isMultiLine = tt.line_pattern && tt.line_pattern.length > 0

                return (
                  <div key={tt.id} className="rounded-md border overflow-hidden">
                    {/* Clickable summary row */}
                    <button
                      type="button"
                      onClick={() => setExpandedId(isExpanded ? null : tt.id)}
                      className="w-full text-left px-4 py-3 flex items-center gap-3 hover:bg-muted/50 transition-colors"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <p className="text-sm font-medium truncate">{formatCounterpartyName(tt.counterparty_name)}</p>
                        </div>
                        <div className="flex items-center gap-1.5 mt-0.5 text-xs text-muted-foreground">
                          {isMultiLine ? (
                            <span className="font-mono">
                              {tt.line_pattern!.filter(lp => lp.type === 'business').map(lp => lp.account).join(', ')}
                            </span>
                          ) : (
                            <>
                              <span className="font-mono">{tt.debit_account}</span>
                              <span className="text-muted-foreground/50">→</span>
                              <span className="font-mono">{tt.credit_account}</span>
                            </>
                          )}
                          {tt.vat_treatment && (
                            <>
                              <span className="text-muted-foreground/30">·</span>
                              <span>{VAT_LABELS[tt.vat_treatment] || tt.vat_treatment}</span>
                            </>
                          )}
                          <span className="text-muted-foreground/30">·</span>
                          <span>{t('times_count', { count: tt.occurrence_count })}</span>
                          <span className={`tabular-nums ${confidenceColor(Number(tt.confidence))}`}>
                            {Math.round(Number(tt.confidence) * 100)}%
                          </span>
                          <span className="text-muted-foreground/30">·</span>
                          <span>{SOURCE_LABELS[tt.source] || tt.source}</span>
                        </div>
                      </div>
                      <ChevronDown className={`h-4 w-4 text-muted-foreground shrink-0 transition-transform ${isExpanded ? 'rotate-180' : ''}`} />
                    </button>

                    {/* Expanded detail */}
                    {isExpanded && (
                      <div className="border-t bg-muted/30 px-4 py-3 space-y-3">
                        {/* Account lines */}
                        <div>
                          <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider mb-1.5">{t('booking_label')}</p>
                          {isMultiLine ? (
                            <div className="space-y-1">
                              {tt.line_pattern!.map((lp, i) => (
                                <div key={i} className="flex items-center gap-2 text-xs">
                                  <span className="w-14 shrink-0 text-[10px] uppercase tracking-wider text-muted-foreground">
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
                                <span className="w-14 shrink-0 text-[10px] uppercase tracking-wider text-muted-foreground">{t('debit_label')}</span>
                                <span className="font-mono">{formatAccountWithName(tt.debit_account)}</span>
                              </div>
                              <div className="flex items-center gap-2 text-xs">
                                <span className="w-14 shrink-0 text-[10px] uppercase tracking-wider text-muted-foreground">{t('credit_label')}</span>
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
                              <span className="text-right truncate ml-4">{tt.counterparty_aliases.slice(0, 3).join(', ')}{tt.counterparty_aliases.length > 3 ? ` +${tt.counterparty_aliases.length - 3}` : ''}</span>
                            </div>
                          )}
                        </div>

                        {/* Delete */}
                        <div className="flex justify-end pt-1">
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => handleDelete(tt.id)}
                            disabled={deletingId === tt.id}
                            className="text-destructive hover:text-destructive text-xs h-7"
                          >
                            {deletingId === tt.id ? (
                              <Loader2 className="mr-1.5 h-3 w-3 animate-spin" />
                            ) : (
                              <Trash2 className="mr-1.5 h-3 w-3" />
                            )}
                            {t('delete_button')}
                          </Button>
                        </div>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
