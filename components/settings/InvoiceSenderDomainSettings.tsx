'use client'

import { useCallback, useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { Skeleton } from '@/components/ui/skeleton'
import { useToast } from '@/components/ui/use-toast'
import { Check, Copy, Loader2, RefreshCw, Trash2 } from 'lucide-react'
import {
  SettingsGroup,
  SettingsRow,
  SettingsRowNote,
} from '@/components/settings/SettingsRows'
import type { CompanySendingDomain, SendingDomainDnsRecord } from '@/types'
import { getErrorMessage as getUserErrorMessage, type ErrorLocale } from '@/lib/errors/get-error-message'
import { useFormat } from '@/lib/hooks/use-format'
import { useCompany } from '@/contexts/CompanyContext'
import { copyToClipboard } from '@/lib/browser/copy-to-clipboard'

const BASE = '/api/extensions/ext/email/sending-domain'

const STATUS_VARIANT: Record<CompanySendingDomain['status'], 'secondary' | 'success' | 'destructive'> = {
  pending: 'secondary',
  verified: 'success',
  failed: 'destructive',
}

/**
 * Opt-in "send invoice email from our own domain" section. Rendered only
 * when the company holds the capability grant: the GET answers 403
 * capability_blocked otherwise and the section renders nothing, so every
 * other company keeps the unchanged invoicing settings page.
 *
 * Three states: no domain (claim form), pending (DNS records + re-check),
 * verified (sender address/name, pause toggle). Everything that touches the
 * From header is decided server-side; this surface only manages the claim.
 */
export function InvoiceSenderDomainSettings({ companyName }: { companyName: string | null }) {
  const t = useTranslations('settings_invoice_sender_domain')
  const { toast } = useToast()
  const { locale, formatDateLong } = useFormat()
  const errorLocale = locale as ErrorLocale
  const { role } = useCompany()
  const canManage = role === 'owner' || role === 'admin'

  const [available, setAvailable] = useState(false)
  const [isLoading, setIsLoading] = useState(true)
  const [loadFailed, setLoadFailed] = useState(false)
  const [domain, setDomain] = useState<CompanySendingDomain | null>(null)
  const [domainInput, setDomainInput] = useState('')
  const [localPart, setLocalPart] = useState('faktura')
  const [senderName, setSenderName] = useState('')
  const [isClaiming, setIsClaiming] = useState(false)
  const [isChecking, setIsChecking] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [isRemoving, setIsRemoving] = useState(false)

  const applyRow = useCallback((row: CompanySendingDomain | null) => {
    setDomain(row)
    setLocalPart(row?.sender_local_part ?? 'faktura')
    setSenderName(row?.sender_name ?? '')
  }, [])

  const fetchDomain = useCallback(async () => {
    setIsLoading(true)
    setLoadFailed(false)
    try {
      const res = await fetch(BASE)
      if (res.status === 403 || res.status === 404) {
        // Not opted in (no capability grant) or extension not mounted:
        // stay invisible rather than advertise a feature the company lacks.
        setAvailable(false)
        return
      }
      if (!res.ok) {
        setAvailable(true)
        setLoadFailed(true)
        return
      }
      const json = await res.json()
      setAvailable(true)
      applyRow(json.data ?? null)
    } catch {
      setAvailable(true)
      setLoadFailed(true)
    } finally {
      setIsLoading(false)
    }
  }, [applyRow])

  useEffect(() => {
    void fetchDomain()
  }, [fetchDomain])

  const fail = useCallback(
    (title: string, err: unknown) => {
      toast({
        title,
        description: err instanceof Error ? getUserErrorMessage(err, { locale: errorLocale }) : t('try_again'),
        variant: 'destructive',
      })
    },
    [errorLocale, t, toast],
  )

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
      applyRow(json.data)
      setDomainInput('')
      toast({ title: t('claim_success_title'), description: t('claim_success_description') })
    } catch (err) {
      fail(t('claim_error_title'), err)
    } finally {
      setIsClaiming(false)
    }
  }, [applyRow, domainInput, fail, t, toast])

  const handleVerify = useCallback(async () => {
    setIsChecking(true)
    try {
      const res = await fetch(`${BASE}/verify`, { method: 'POST' })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? t('verify_error_title'))
      applyRow(json.data)
      toast(
        json.data.status === 'verified'
          ? { title: t('verify_success_title'), description: t('verify_success_description') }
          : { title: t('verify_pending_title'), description: t('verify_pending_description') },
      )
    } catch (err) {
      fail(t('verify_error_title'), err)
    } finally {
      setIsChecking(false)
    }
  }, [applyRow, fail, t, toast])

  const patch = useCallback(
    async (body: { sender_local_part?: string; sender_name?: string | null; enabled?: boolean }) => {
      setIsSaving(true)
      try {
        const res = await fetch(BASE, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        })
        const json = await res.json()
        if (!res.ok) throw new Error(json.error ?? t('save_error_title'))
        applyRow(json.data)
        toast({ title: t('saved_title') })
      } catch (err) {
        fail(t('save_error_title'), err)
      } finally {
        setIsSaving(false)
      }
    },
    [applyRow, fail, t, toast],
  )

  const handleSaveSender = useCallback(() => {
    const name = senderName.trim()
    void patch({ sender_local_part: localPart.trim(), sender_name: name ? name : null })
  }, [localPart, patch, senderName])

  const handleRemove = useCallback(async () => {
    if (!domain) return
    if (!confirm(t('remove_confirm', { domain: domain.domain }))) return
    setIsRemoving(true)
    try {
      const res = await fetch(BASE, { method: 'DELETE' })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? t('remove_error_title'))
      applyRow(null)
      toast({ title: t('remove_success_title') })
    } catch (err) {
      fail(t('remove_error_title'), err)
    } finally {
      setIsRemoving(false)
    }
  }, [applyRow, domain, fail, t, toast])

  const handleCopy = useCallback(
    async (value: string) => {
      const result = await copyToClipboard(value)
      toast(
        result === 'copied'
          ? { title: t('copied') }
          : { title: t('copy_failed_title'), description: t('copy_failed_description'), variant: 'destructive' },
      )
    },
    [t, toast],
  )

  if (!canManage) return null
  // Stay invisible until the opt-in is confirmed: no skeleton flash for the
  // companies that do not hold the grant (i.e. almost all of them).
  if (!available) return null

  const records: SendingDomainDnsRecord[] = domain?.dns_records ?? []
  const statusLabels: Record<CompanySendingDomain['status'], string> = {
    pending: t('status_pending'),
    verified: t('status_verified'),
    failed: t('status_failed'),
  }
  const effectiveName = (domain?.sender_name ?? companyName ?? '').trim()
  const previewAddress = domain ? `${domain.sender_local_part}@${domain.domain}` : ''

  return (
    <SettingsGroup label={t('heading')} help={t('description')}>
      {isLoading ? (
        <div className="space-y-3 px-1 py-3">
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-16 w-full" />
        </div>
      ) : loadFailed ? (
        <div role="status" className="flex items-center justify-between gap-4 px-1 py-3 text-sm">
          <p className="text-muted-foreground">{t('load_error')}</p>
          <Button variant="outline" size="sm" onClick={() => void fetchDomain()}>
            {t('retry')}
          </Button>
        </div>
      ) : !domain ? (
        <>
          <SettingsRow label={t('domain_label')} htmlFor="invoice-sender-domain" help={t('domain_hint')}>
            <Input
              id="invoice-sender-domain"
              value={domainInput}
              onChange={(e) => setDomainInput(e.target.value)}
              placeholder="dittbolag.se"
              className="max-w-xs"
              onKeyDown={(e) => {
                if (e.key === 'Enter') void handleClaim()
              }}
            />
            <Button size="sm" onClick={() => void handleClaim()} disabled={isClaiming || !domainInput.trim()}>
              {isClaiming ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              {t('add_button')}
            </Button>
          </SettingsRow>
          <SettingsRowNote className="block px-1 pt-2">{t('fallback_note')}</SettingsRowNote>
        </>
      ) : (
        <>
          <SettingsRow label={t('domain_label')}>
            <code className="truncate font-mono text-sm">{domain.domain}</code>
            <Badge variant={STATUS_VARIANT[domain.status]}>{statusLabels[domain.status]}</Badge>
            <div className="ml-auto flex shrink-0 items-center gap-2">
              <Button variant="outline" size="sm" onClick={() => void handleVerify()} disabled={isChecking}>
                {isChecking ? (
                  <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                ) : (
                  <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
                )}
                {t('check_again')}
              </Button>
              <Button
                variant="outline"
                size="icon"
                onClick={() => void handleRemove()}
                disabled={isRemoving}
                aria-label={t('remove_aria')}
              >
                {isRemoving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
              </Button>
            </div>
          </SettingsRow>

          {domain.status === 'verified' ? (
            <>
              <SettingsRow label={t('enabled_label')} help={t('enabled_hint')}>
                <Switch
                  checked={domain.enabled}
                  disabled={isSaving}
                  onCheckedChange={(checked) => void patch({ enabled: checked })}
                  aria-label={t('enabled_label')}
                />
                <SettingsRowNote>{domain.enabled ? t('enabled_on') : t('enabled_off')}</SettingsRowNote>
              </SettingsRow>
              <SettingsRow label={t('address_label')} htmlFor="invoice-sender-local-part" help={t('address_hint')}>
                <Input
                  id="invoice-sender-local-part"
                  value={localPart}
                  onChange={(e) => setLocalPart(e.target.value)}
                  className="max-w-[10rem] font-mono"
                />
                <span className="font-mono text-sm text-muted-foreground">@{domain.domain}</span>
              </SettingsRow>
              <SettingsRow label={t('name_label')} htmlFor="invoice-sender-name" help={t('name_hint')}>
                <Input
                  id="invoice-sender-name"
                  value={senderName}
                  onChange={(e) => setSenderName(e.target.value)}
                  placeholder={companyName ?? ''}
                  className="max-w-xs"
                />
              </SettingsRow>
              <div className="flex items-start gap-3 rounded-lg border border-border p-4 text-sm">
                <Check className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                <div className="space-y-1">
                  <p className="font-medium">
                    {t('preview_label')}{' '}
                    <code className="font-mono text-xs">
                      {effectiveName ? `${effectiveName} <${previewAddress}>` : previewAddress}
                    </code>
                  </p>
                  <p className="text-muted-foreground">
                    {domain.verified_at
                      ? t('verified_description_with_date', { date: formatDateLong(domain.verified_at) })
                      : t('verified_description')}
                  </p>
                </div>
              </div>
              <div className="flex justify-end px-1 pt-4">
                <Button type="button" size="sm" onClick={handleSaveSender} disabled={isSaving}>
                  {isSaving ? t('saving') : t('save')}
                </Button>
              </div>
            </>
          ) : (
            <div className="space-y-3 px-1 py-3">
              <p className="text-sm text-muted-foreground">{t('dns_instructions')}</p>
              {records.length > 0 ? (
                <div className="overflow-x-auto rounded-lg border border-border">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-border">
                        <th className="px-3 py-2 text-left text-[11px] font-medium uppercase tracking-wider text-muted-foreground">{t('dns_type')}</th>
                        <th className="px-3 py-2 text-left text-[11px] font-medium uppercase tracking-wider text-muted-foreground">{t('dns_name')}</th>
                        <th className="px-3 py-2 text-left text-[11px] font-medium uppercase tracking-wider text-muted-foreground">{t('dns_value')}</th>
                        <th className="px-3 py-2 text-left text-[11px] font-medium uppercase tracking-wider text-muted-foreground">{t('dns_status')}</th>
                        <th className="px-3 py-2" />
                      </tr>
                    </thead>
                    <tbody>
                      {records.map((r, i) => (
                        <tr key={`${r.type}-${r.name}-${i}`} className="border-b border-border last:border-0">
                          <td className="px-3 py-2 font-mono text-xs">{r.type}</td>
                          <td className="px-3 py-2 font-mono text-xs break-all">{r.name}</td>
                          <td className="px-3 py-2 font-mono text-xs break-all">{r.value}</td>
                          <td className="px-3 py-2 font-mono text-xs">{r.status}</td>
                          <td className="px-3 py-2 text-right">
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              onClick={() => void handleCopy(r.value)}
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
                <p className="text-sm text-muted-foreground">{t('dns_empty')}</p>
              )}
              <SettingsRowNote className="block">{t('fallback_note')}</SettingsRowNote>
            </div>
          )}
        </>
      )}
    </SettingsGroup>
  )
}
