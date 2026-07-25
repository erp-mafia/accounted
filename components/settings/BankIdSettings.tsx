'use client'

import Image from 'next/image'
import { useTranslations } from 'next-intl'
import { useState, useEffect, useCallback } from 'react'
import { createClient } from '@/lib/supabase/client'
import { BankIdAuth } from '@/components/auth/BankIdAuth'
import type { BankIdResult } from '@/components/auth/BankIdAuth'
import { Button } from '@/components/ui/button'
import { Loader2 } from 'lucide-react'
import { useToast } from '@/components/ui/use-toast'
import { formatDateLong } from '@/lib/utils'
import {
  SettingsRow,
  SettingsRowEnd,
  SettingsRowNote,
} from '@/components/settings/SettingsRows'

interface BankIdIdentity {
  given_name: string | null
  surname: string | null
  linked_at: string
}

export function BankIdSettings() {
  const t = useTranslations('settings_bankid')
  const [identity, setIdentity] = useState<BankIdIdentity | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [isLinking, setIsLinking] = useState(false)
  const [isUnlinking, setIsUnlinking] = useState(false)
  const { toast } = useToast()

  const fetchIdentity = useCallback(async () => {
    const supabase = createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) { setIsLoading(false); return }

    const { data } = await supabase
      .from('bankid_identities')
      .select('given_name, surname, linked_at')
      .eq('user_id', user.id)
      .maybeSingle()

    setIdentity(data)
    setIsLoading(false)
  }, [])

  useEffect(() => {
    fetchIdentity()
  }, [fetchIdentity])

  const handleLinkComplete = async (result: BankIdResult) => {
    if (result.error) {
      const message = result.error === 'already_linked'
        ? t('toast_already_linked')
        : t('toast_link_failed')
      toast({ title: message, variant: 'destructive' })
      setIsLinking(false)
      return
    }

    toast({ title: t('toast_linked') })
    setIsLinking(false)
    fetchIdentity()
  }

  const handleUnlink = async () => {
    if (!confirm(t('confirm_unlink'))) return

    setIsUnlinking(true)
    try {
      const res = await fetch('/api/extensions/ext/tic/bankid/unlink', { method: 'POST' })
      if (!res.ok) throw new Error('Unlink failed')

      setIdentity(null)
      toast({ title: t('toast_unlinked') })
    } catch {
      toast({ title: t('toast_unlink_failed'), variant: 'destructive' })
    } finally {
      setIsUnlinking(false)
    }
  }

  if (isLoading) {
    return (
      <SettingsRow label={t('title')}>
        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
      </SettingsRow>
    )
  }

  return (
    <>
      <SettingsRow
        label={
          <span className="inline-flex items-center gap-2">
            <Image
              src="/logos/bankid-seeklogo.svg"
              alt=""
              aria-hidden="true"
              width={16}
              height={16}
              className="dark:invert"
            />
            {t('title')}
          </span>
        }
        help={identity ? t('linked_description') : t('not_linked_description')}
        borderless={isLinking}
      >
        {identity ? (
          <>
            <span className="text-sm font-medium">
              {identity.given_name} {identity.surname}
            </span>
            <SettingsRowNote>
              {t('linked_on', { date: formatDateLong(identity.linked_at) })}
            </SettingsRowNote>
            <SettingsRowEnd>
              <Button
                variant="outline"
                size="sm"
                onClick={handleUnlink}
                disabled={isUnlinking}
                className="text-destructive hover:text-destructive"
              >
                {isUnlinking ? t('unlinking') : t('unlink_button')}
              </Button>
            </SettingsRowEnd>
          </>
        ) : isLinking ? (
          // Active flow: the scan instruction is the actionable content and
          // stays visible while the QR block below is open.
          <SettingsRowNote>{t('link_bankid_description')}</SettingsRowNote>
        ) : (
          <SettingsRowEnd>
            <Button variant="outline" size="sm" onClick={() => setIsLinking(true)}>
              <Image
                src="/logos/bankid-seeklogo.svg"
                alt=""
                aria-hidden="true"
                width={16}
                height={16}
                className="mr-2 dark:invert"
              />
              {t('link_button')}
            </Button>
          </SettingsRowEnd>
        )}
      </SettingsRow>

      {/* QR flow: an expanding block below the row. Mounted only while
          linking so the BankID session starts exactly when requested. */}
      {isLinking && (
        <div className="flex flex-col items-center gap-3 border-b border-border px-1 py-4">
          <BankIdAuth mode="link" onComplete={handleLinkComplete} />
          {/* BankIdAuth's own Avbryt only resets its internal session; give
              the row an exit so isLinking can't get stuck. */}
          <Button variant="outline" size="sm" onClick={() => setIsLinking(false)}>
            {t('cancel_linking')}
          </Button>
        </div>
      )}
    </>
  )
}
