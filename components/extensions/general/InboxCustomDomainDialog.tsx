'use client'

import { useState, useCallback, useEffect } from 'react'
import { useTranslations } from 'next-intl'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { useToast } from '@/components/ui/use-toast'
import { AlertTriangle, Check, Copy, Loader2, RefreshCw, Trash2 } from 'lucide-react'
import type { CompanyInboundDomain, InboundDomainDnsRecord } from '@/types'
import { getErrorMessage as getUserErrorMessage, type ErrorLocale } from '@/lib/errors/get-error-message'
import { useFormat } from '@/lib/hooks/use-format'
import { useCompany } from '@/contexts/CompanyContext'
import { copyToClipboard } from '@/lib/browser/copy-to-clipboard'

const BASE = '/api/extensions/ext/invoice-inbox/inbox/domain'

const STATUS_VARIANT: Record<
  CompanyInboundDomain['status'],
  'secondary' | 'success' | 'destructive'
> = {
  pending: 'secondary',
  verified: 'success',
  failed: 'destructive',
}

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
}

// Settings dialog for a company's own inbound domain. Claims the domain via
// the extension API, renders the DNS records the user must publish, and
// re-checks verification on demand. Everything mail-routing happens
// server-side: this surface only manages the claim lifecycle.
export default function InboxCustomDomainDialog({ open, onOpenChange }: Props) {
  const { toast } = useToast()
  const t = useTranslations('inbox_custom_domain')
  const { locale, formatDateLong } = useFormat()
  const errorLocale = locale as ErrorLocale
  const { role } = useCompany()
  const canManage = role === 'owner' || role === 'admin'
  const [isLoading, setIsLoading] = useState(true)
  const [loadFailed, setLoadFailed] = useState(false)
  const [domain, setDomain] = useState<CompanyInboundDomain | null>(null)
  const [domainInput, setDomainInput] = useState('')
  const [isClaiming, setIsClaiming] = useState(false)
  const [isChecking, setIsChecking] = useState(false)
  const [isRemoving, setIsRemoving] = useState(false)

  const fetchDomain = useCallback(async () => {
    setIsLoading(true)
    setLoadFailed(false)
    try {
      const res = await fetch(BASE)
      if (!res.ok) {
        setLoadFailed(true)
        return
      }
      const json = await res.json()
      setDomain(json.data ?? null)
    } catch {
      setLoadFailed(true)
    } finally {
      setIsLoading(false)
    }
  }, [])

  useEffect(() => {
    if (open) fetchDomain()
  }, [open, fetchDomain])

  const handleClaim = useCallback(async () => {
    if (!domainInput.trim()) return
    setIsClaiming(true)
    try {
      const res = await fetch(BASE, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ domain: domainInput }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? t('claim_error_title'))
      setDomain(json.data)
      setDomainInput('')
      toast({
        title: t('claim_success_title'),
        description: t('claim_success_description'),
      })
    } catch (err) {
      toast({
        title: t('claim_error_title'),
        description: err instanceof Error ? getUserErrorMessage(err, { locale: errorLocale }) : t('try_again'),
        variant: 'destructive',
      })
    } finally {
      setIsClaiming(false)
    }
  }, [domainInput, errorLocale, t, toast])

  const handleVerify = useCallback(async () => {
    setIsChecking(true)
    try {
      const res = await fetch(`${BASE}/verify`, { method: 'POST' })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? t('verify_error_title'))
      setDomain(json.data)
      toast(
        json.data.status === 'verified'
          ? { title: t('verify_success_title'), description: t('verify_success_description') }
          : { title: t('verify_pending_title'), description: t('verify_pending_description') }
      )
    } catch (err) {
      toast({
        title: t('verify_error_title'),
        description: err instanceof Error ? getUserErrorMessage(err, { locale: errorLocale }) : t('try_again'),
        variant: 'destructive',
      })
    } finally {
      setIsChecking(false)
    }
  }, [errorLocale, t, toast])

  const handleRemove = useCallback(async () => {
    if (!domain) return
    if (!confirm(t('remove_confirm', { domain: domain.domain }))) return
    setIsRemoving(true)
    try {
      const res = await fetch(BASE, { method: 'DELETE' })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? t('remove_error_title'))
      setDomain(null)
      toast({ title: t('remove_success_title') })
    } catch (err) {
      toast({
        title: t('remove_error_title'),
        description: err instanceof Error ? getUserErrorMessage(err, { locale: errorLocale }) : t('try_again'),
        variant: 'destructive',
      })
    } finally {
      setIsRemoving(false)
    }
  }, [domain, errorLocale, t, toast])

  const handleCopy = useCallback(
    async (value: string) => {
      const result = await copyToClipboard(value)
      toast(
        result === 'copied'
          ? { title: t('copied') }
          : {
              title: t('copy_failed_title'),
              description: t('copy_failed_description'),
              variant: 'destructive',
            }
      )
    },
    [t, toast]
  )

  const records: InboundDomainDnsRecord[] = domain?.dns_records ?? []
  const statusLabels: Record<CompanyInboundDomain['status'], string> = {
    pending: t('status_pending'),
    verified: t('status_verified'),
    failed: t('status_failed'),
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t('title')}</DialogTitle>
          <DialogDescription>
            {t('description')}
          </DialogDescription>
        </DialogHeader>

        {isLoading ? (
          <div className="space-y-3">
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-24 w-full" />
          </div>
        ) : loadFailed ? (
          <div role="status" className="flex items-center justify-between gap-4 text-sm">
            <p className="text-muted-foreground">{t('load_error')}</p>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                void fetchDomain()
              }}
            >
              {t('retry')}
            </Button>
          </div>
        ) : !domain ? (
          <div className="space-y-4">
            <div className="flex items-start gap-3 rounded-lg border border-border p-4 text-sm">
              <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5 text-muted-foreground" />
              <div className="space-y-1">
                <p className="font-medium">{t('warning_title')}</p>
                <p className="text-muted-foreground">
                  {t('warning_before_subdomain')}{' '}
                  <code className="font-mono text-xs">faktura.dittbolag.se</code>{' '}
                  {t('warning_after_subdomain')}
                </p>
              </div>
            </div>

            {canManage ? (
              <div className="flex gap-2">
                <Input
                  value={domainInput}
                  onChange={(e) => setDomainInput(e.target.value)}
                  placeholder="faktura.dittbolag.se"
                  aria-label={t('domain_input_aria')}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleClaim()
                  }}
                />
                <Button onClick={handleClaim} disabled={isClaiming || !domainInput.trim()}>
                  {isClaiming ? (
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  ) : null}
                  {t('add_button')}
                </Button>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">{t('manage_permission')}</p>
            )}
          </div>
        ) : (
          <div className="space-y-4">
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2 min-w-0">
                <code className="font-mono text-sm truncate">{domain.domain}</code>
                <Badge variant={STATUS_VARIANT[domain.status]}>
                  {statusLabels[domain.status]}
                </Badge>
              </div>
              {canManage ? (
                <div className="flex items-center gap-2 shrink-0">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handleVerify}
                    disabled={isChecking}
                  >
                    {isChecking ? (
                      <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                    ) : (
                      <RefreshCw className="h-3.5 w-3.5 mr-1.5" />
                    )}
                    {t('check_again')}
                  </Button>
                  <Button
                    variant="outline"
                    size="icon"
                    onClick={handleRemove}
                    disabled={isRemoving}
                    aria-label={t('remove_aria')}
                  >
                    {isRemoving ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Trash2 className="h-3.5 w-3.5" />
                    )}
                  </Button>
                </div>
              ) : null}
            </div>

            {domain.status === 'verified' ? (
              <div className="flex items-start gap-3 rounded-lg border border-border p-4 text-sm">
                <Check className="h-4 w-4 shrink-0 mt-0.5 text-muted-foreground" />
                <div className="space-y-1">
                  <p className="font-medium">
                    {t('verified_title')}{' '}
                    <code className="font-mono text-xs">faktura@{domain.domain}</code>
                  </p>
                  <p className="text-muted-foreground">
                    {domain.verified_at
                      ? t('verified_description_with_date', {
                          date: formatDateLong(domain.verified_at),
                        })
                      : t('verified_description')}
                  </p>
                </div>
              </div>
            ) : (
              <div className="space-y-3">
                <p className="text-sm text-muted-foreground">
                  {t('dns_instructions')}
                </p>
                {records.length > 0 ? (
                  <div className="rounded-lg border border-border overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b border-border">
                          <th className="px-3 py-2 text-left text-[11px] font-medium uppercase tracking-wider text-muted-foreground">{t('dns_type')}</th>
                          <th className="px-3 py-2 text-left text-[11px] font-medium uppercase tracking-wider text-muted-foreground">{t('dns_name')}</th>
                          <th className="px-3 py-2 text-left text-[11px] font-medium uppercase tracking-wider text-muted-foreground">{t('dns_value')}</th>
                          <th className="px-3 py-2 text-right text-[11px] font-medium uppercase tracking-wider text-muted-foreground">{t('dns_priority')}</th>
                          <th className="px-3 py-2" />
                        </tr>
                      </thead>
                      <tbody>
                        {records.map((r, i) => (
                          <tr key={`${r.type}-${r.name}-${i}`} className="border-b border-border last:border-0">
                            <td className="px-3 py-2 font-mono text-xs">{r.type}</td>
                            <td className="px-3 py-2 font-mono text-xs break-all">{r.name}</td>
                            <td className="px-3 py-2 font-mono text-xs break-all">{r.value}</td>
                            <td className="px-3 py-2 font-mono text-xs text-right tabular-nums">
                              {r.priority ?? '-'}
                            </td>
                            <td className="px-3 py-2 text-right">
                              <Button
                                type="button"
                                variant="ghost"
                                size="icon"
                                onClick={() => {
                                  void handleCopy(r.value)
                                }}
                                aria-label={t('copy_record_aria', { type: r.type })}
                              >
                                <Copy className="h-3.5 w-3.5" />
                              </Button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground">
                    {t('dns_empty')}
                  </p>
                )}
              </div>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
