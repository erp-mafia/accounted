'use client'

/**
 * Settings panel for the whatsapp-inbox extension (Inställningar -> WhatsApp).
 *
 * Unlinked: mint a one-time code (10 min TTL) + wa.me deep link; the user
 * sends the code from their phone and the webhook binds the number.
 * Linked: masked phone, default-company select (multi-company routing),
 * revoke. Muted (user sent *stopp* in chat) shows a hint: unmuting happens
 * in the chat with *start*, not here.
 */

import { useCallback, useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Loader2, ExternalLink } from 'lucide-react'
import { WhatsAppMark } from '@/components/extensions/general/WhatsAppMark'
import { Button } from '@/components/ui/button'
import { useToast } from '@/components/ui/use-toast'
import { useCompany } from '@/contexts/CompanyContext'
import {
  SettingsGroup,
  SettingsRow,
  SettingsRowNote,
  SettingsSelect,
} from '@/components/settings/SettingsRows'

const BASE = '/api/extensions/ext/whatsapp-inbox'

interface LinkStatus {
  linked: boolean
  phoneMasked?: string
  defaultCompanyId?: string | null
  muted?: boolean
}

interface MintedCode {
  code: string
  expiresAt: string
  waLink: string | null
}

export function WhatsAppLinkPanel() {
  const t = useTranslations('settings_whatsapp')
  const { toast } = useToast()
  const { companies } = useCompany()

  const [isLoading, setIsLoading] = useState(true)
  const [loadFailed, setLoadFailed] = useState(false)
  const [status, setStatus] = useState<LinkStatus | null>(null)
  const [minted, setMinted] = useState<MintedCode | null>(null)
  const [isMinting, setIsMinting] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [minutesLeft, setMinutesLeft] = useState<number | null>(null)

  const fetchStatus = useCallback(async () => {
    setIsLoading(true)
    setLoadFailed(false)
    try {
      const response = await fetch(`${BASE}/link`)
      if (!response.ok) throw new Error('load failed')
      const { data } = (await response.json()) as { data: LinkStatus }
      setStatus(data)
    } catch {
      setLoadFailed(true)
    } finally {
      setIsLoading(false)
    }
  }, [])

  useEffect(() => {
    void fetchStatus()
  }, [fetchStatus])

  // Countdown hint for the minted code (10 min TTL server-side).
  useEffect(() => {
    if (!minted) {
      setMinutesLeft(null)
      return
    }
    const tick = () => {
      const msLeft = new Date(minted.expiresAt).getTime() - Date.now()
      setMinutesLeft(msLeft > 0 ? Math.ceil(msLeft / 60_000) : 0)
    }
    tick()
    const interval = setInterval(tick, 15_000)
    return () => clearInterval(interval)
  }, [minted])

  const startLinking = async () => {
    setIsMinting(true)
    try {
      const response = await fetch(`${BASE}/link/start`, { method: 'POST' })
      if (!response.ok) throw new Error('mint failed')
      const { data } = (await response.json()) as { data: MintedCode }
      setMinted(data)
    } catch {
      toast({ title: t('mint_failed'), variant: 'destructive' })
    } finally {
      setIsMinting(false)
    }
  }

  const saveDefaultCompany = async (companyId: string) => {
    setIsSaving(true)
    try {
      const response = await fetch(`${BASE}/link/default-company`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ companyId: companyId || null }),
      })
      if (!response.ok) throw new Error('save failed')
      setStatus((prev) => (prev ? { ...prev, defaultCompanyId: companyId || null } : prev))
      toast({ title: t('default_company_saved') })
    } catch {
      toast({ title: t('default_company_save_failed'), variant: 'destructive' })
    } finally {
      setIsSaving(false)
    }
  }

  const revoke = async () => {
    if (!window.confirm(t('revoke_confirm'))) return
    setIsSaving(true)
    try {
      const response = await fetch(`${BASE}/link/revoke`, { method: 'POST' })
      if (!response.ok) throw new Error('revoke failed')
      setStatus({ linked: false })
      setMinted(null)
      toast({ title: t('revoked_toast') })
    } catch {
      toast({ title: t('revoke_failed'), variant: 'destructive' })
    } finally {
      setIsSaving(false)
    }
  }

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 px-1 py-6 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
        {t('loading')}
      </div>
    )
  }

  if (loadFailed) {
    return (
      <div className="px-1 py-6 text-sm text-muted-foreground">
        {t('load_failed')}{' '}
        <button type="button" className="underline" onClick={() => void fetchStatus()}>
          {t('retry')}
        </button>
      </div>
    )
  }

  if (status?.linked) {
    return (
      <SettingsGroup label={t('group_label')}>
        <SettingsRow label={t('linked_number_label')}>
          <span className="font-mono text-sm">{status.phoneMasked}</span>
        </SettingsRow>

        {status.muted ? (
          <SettingsRow label={t('muted_label')}>
            <SettingsRowNote>{t('muted_hint')}</SettingsRowNote>
          </SettingsRow>
        ) : null}

        <SettingsRow label={t('default_company_label')} help={t('default_company_help')}>
          <SettingsSelect
            aria-label={t('default_company_label')}
            value={status.defaultCompanyId ?? ''}
            disabled={isSaving}
            onChange={(event) => void saveDefaultCompany(event.target.value)}
          >
            <option value="">{t('default_company_none')}</option>
            {companies.map(({ company }) => (
              <option key={company.id} value={company.id}>
                {company.name}
              </option>
            ))}
          </SettingsSelect>
        </SettingsRow>

        <SettingsRow label={t('disconnect_label')} borderless>
          <Button type="button" variant="outline" size="sm" disabled={isSaving} onClick={() => void revoke()}>
            {t('revoke_button')}
          </Button>
          <SettingsRowNote>{t('revoke_note')}</SettingsRowNote>
        </SettingsRow>
      </SettingsGroup>
    )
  }

  return (
    <SettingsGroup label={t('group_label')}>
      <div className="space-y-4 px-1 py-4">
        <p className="max-w-prose text-sm text-muted-foreground">{t('unlinked_intro')}</p>

        {minted ? (
          <div className="space-y-3">
            <div className="flex items-center gap-3">
              <span className="rounded-md border border-border bg-muted/50 px-3 py-1.5 font-mono text-base tracking-wider">
                {minted.code}
              </span>
              {minted.waLink ? (
                <Button asChild type="button" size="sm">
                  <a href={minted.waLink} target="_blank" rel="noreferrer">
                    <WhatsAppMark size={16} className="mr-1.5" />
                    {t('open_whatsapp')}
                    <ExternalLink className="ml-1.5 h-3.5 w-3.5" aria-hidden="true" />
                  </a>
                </Button>
              ) : null}
            </div>
            <ol className="ml-4 list-decimal space-y-1 text-sm text-muted-foreground">
              <li>{t('step_open')}</li>
              <li>{t('step_send_code')}</li>
              <li>{t('step_confirm')}</li>
            </ol>
            <p className="text-xs text-muted-foreground">
              {minutesLeft != null && minutesLeft > 0
                ? t('expires_in', { minutes: minutesLeft })
                : minutesLeft === 0
                  ? t('code_expired')
                  : t('expires_hint')}
            </p>
          </div>
        ) : (
          <Button type="button" disabled={isMinting} onClick={() => void startLinking()}>
            {isMinting ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" aria-hidden="true" /> : null}
            {t('connect_button')}
          </Button>
        )}
      </div>
    </SettingsGroup>
  )
}

export default WhatsAppLinkPanel
