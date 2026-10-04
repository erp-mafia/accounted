'use client'

import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { SettingsGroup, SettingsInput, SettingsRow, SettingsRowEnd, SettingsRowNote } from '@/components/settings/SettingsRows'
import { isEmail } from '@/lib/collections/activation-form'
import type { CollectionConnectionView } from '@/lib/collections/connection'
import { collectionsAction, useCollectionsWords, type CollectionsSettingsData } from './collections-client'

/**
 * Where the company's connection stands, in the words of build spec 1.7,
 * and what the admin can do about it at each step: accept another version
 * of the provider's terms, sign, read the status again, or cancel.
 */

/** The status line's message key for a connection. */
export function connectionStatusKey(connection: CollectionConnectionView): string {
  if (connection.state === 'active') return 'status_active'
  if (connection.state === 'disconnected') return 'status_disconnected'
  if (connection.subStatus === 'rejected') return 'status_rejected'
  if (connection.subStatus === 'disabled' || connection.state === 'needs_setup') return 'status_disabled'
  if (connection.subStatus === 'awaiting_terms') return 'status_awaiting_terms'
  if (connection.subStatus === 'awaiting_signature') return 'status_awaiting_signature'
  if (connection.subStatus === 'awaiting_kyc') return 'status_awaiting_kyc'
  if (connection.subStatus === 'in_review') return 'status_in_review'
  return connection.submittedAt || connection.onboarded ? 'status_submitted' : 'status_not_started'
}

interface Props {
  data: CollectionsSettingsData
  connection: CollectionConnectionView
  onChanged: () => Promise<void> | void
}

export function ConnectionStatusPanel({ data, connection, onChanged }: Props) {
  const { t, tp, locale } = useCollectionsWords(data.availability.displayName ?? connection.displayName)
  const canManage = data.canManage
  const [busy, setBusy] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [termsAccepted, setTermsAccepted] = useState(false)
  const [signerEmail, setSignerEmail] = useState('')
  const [sentTo, setSentTo] = useState<string | null>(null)
  const [signOpened, setSignOpened] = useState(false)
  const [confirmCancel, setConfirmCancel] = useState(false)

  async function run(key: string, path: string, body: unknown = {}): Promise<Record<string, unknown> | null> {
    setBusy(key)
    setMessage(null)
    const result = await collectionsAction<Record<string, unknown>>(path, body, locale)
    setBusy(null)
    if (!result.ok) {
      setMessage(result.message)
      await onChanged()
      return null
    }
    await onChanged()
    return result.data
  }

  async function sign() {
    // Opened on the click itself, so the browser does not block it as a popup.
    const tab = window.open('', '_blank')
    const result = await run('sign', '/signature', { sendToSigner: false, signerEmail: null, language: locale })
    const url = typeof result?.signUrl === 'string' ? result.signUrl : null
    if (tab && url) {
      tab.opener = null
      tab.location.href = url
      setSignOpened(true)
    } else {
      tab?.close()
    }
  }

  async function sendLink() {
    const email = signerEmail.trim()
    const result = await run('link', '/signature', { sendToSigner: true, signerEmail: email, language: locale })
    if (result) setSentTo(email)
  }

  const terms = connection.providerTerms
  const termsUrl = terms?.url ?? data.provider?.profile.termsUrl ?? null
  const termsChanged = !!terms && terms.version !== connection.catalogueTermsVersion

  return (
    <div>
      <SettingsGroup>
        <SettingsRow label={t('status_label')}>
          <SettingsRowNote className="text-foreground">{tp(connectionStatusKey(connection))}</SettingsRowNote>
          {canManage && connection.state !== 'disconnected' && (connection.submittedAt || connection.onboarded) ? (
            <SettingsRowEnd>
              <Button variant="outline" size="sm" loading={busy === 'refresh'} onClick={() => run('refresh', '/refresh')}>
                {t('refresh')}
              </Button>
            </SettingsRowEnd>
          ) : null}
        </SettingsRow>
      </SettingsGroup>

      {canManage && connection.subStatus === 'awaiting_terms' && terms ? (
        <SettingsGroup label={t('step_terms')} help={termsChanged ? tp('terms_changed') : undefined}>
          {termsUrl ? (
            <SettingsRow label={tp('terms_read')}>
              <a href={termsUrl} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2">
                {terms.version}
              </a>
            </SettingsRow>
          ) : null}
          <label className="flex items-start gap-3 border-b border-border py-3 text-[13px]">
            <Checkbox className="mt-0.5" checked={termsAccepted} onCheckedChange={(v) => setTermsAccepted(v === true)} />
            <span>{tp('terms_accept')}</span>
          </label>
          <div className="flex justify-end pt-4">
            <Button
              disabled={!termsAccepted}
              loading={busy === 'terms'}
              onClick={() => run('terms', '/terms', { termsVersion: terms.version, accept: true })}
            >
              {t('terms_accept_button')}
            </Button>
          </div>
        </SettingsGroup>
      ) : null}

      {canManage && connection.subStatus === 'awaiting_signature' ? (
        <SettingsGroup label={t('step_sign')} help={tp('sign_help')}>
          <SettingsRow label={t('sign')}>
            {signOpened ? <SettingsRowNote>{t('sign_opened')}</SettingsRowNote> : null}
            <SettingsRowEnd>
              <Button size="sm" loading={busy === 'sign'} onClick={sign}>
                {t('sign')}
              </Button>
            </SettingsRowEnd>
          </SettingsRow>
          <SettingsRow label={t('sign_send_link')} htmlFor="coll-signer" align="baseline">
            <SettingsInput
              id="coll-signer"
              type="email"
              placeholder={t('sign_signer_email')}
              aria-label={t('sign_signer_email')}
              value={signerEmail}
              onChange={(e) => setSignerEmail(e.target.value)}
            />
            <Button variant="outline" size="sm" disabled={!isEmail(signerEmail.trim())} loading={busy === 'link'} onClick={sendLink}>
              {t('sign_send_link')}
            </Button>
            {sentTo ? <SettingsRowNote className="basis-full">{t('sign_link_sent', { email: sentTo })}</SettingsRowNote> : null}
          </SettingsRow>
        </SettingsGroup>
      ) : null}

      {message ? <p className="pt-4 text-[12.5px] text-attn">{message}</p> : null}

      {canManage && connection.state !== 'active' && connection.state !== 'disconnected' ? (
        <div className="flex justify-end pt-6">
          <Button variant="outline" onClick={() => setConfirmCancel(true)}>
            {t('cancel_activation')}
          </Button>
        </div>
      ) : null}

      <ConfirmDialog
        open={confirmCancel}
        onOpenChange={setConfirmCancel}
        title={t('cancel_activation')}
        description={t('cancel_activation_confirm')}
        confirmLabel={t('cancel_activation')}
        destructive
        onConfirm={async () => {
          await run('cancel', '/cancel')
          setConfirmCancel(false)
        }}
      />
    </div>
  )
}
