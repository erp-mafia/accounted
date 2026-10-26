'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { useLocale, useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { ConfirmationDialog } from '@/components/ui/confirmation-dialog'
import { useToast } from '@/components/ui/use-toast'
import { SettingsGroup, SettingsRow, SettingsRowNote, SettingsSeg } from '@/components/settings/SettingsRows'
import { formatCurrency } from '@/lib/utils'
import { getErrorMessage, type ErrorLocale } from '@/lib/errors/get-error-message'

type Account = '1630' | '2012'

interface AccountState {
  account: Account
  chosen: Account | null
  choices: Account[]
  books_suggest: Account | null
  balances: Array<{ account: Account; balance: number }>
}

interface ErrorEnvelope {
  error?: { message?: string } | string
}

/**
 * Kopplingar → Skatteverket: which account the skattekonto runs on in the
 * books (PH 175). Shown only for a form with a choice (an enskild firma:
 * 1630, or 2012 in eget kapital). Changing it moves nothing that is posted:
 * the row says what is left on the other account and drafts the transfer
 * verifikat on request, which the user then posts in Bokföring.
 */
export function SkattekontoAccountSetting() {
  const t = useTranslations('settings_skattekonto_account')
  const errorLocale = useLocale() as ErrorLocale
  const { toast } = useToast()
  const [state, setState] = useState<AccountState | null>(null)
  const [pending, setPending] = useState<Account | null>(null)
  const [saving, setSaving] = useState(false)
  const [drafting, setDrafting] = useState(false)
  const [draftId, setDraftId] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/settings/skattekonto-account')
      if (!res.ok) return
      const json = (await res.json()) as { data?: AccountState }
      if (json.data) setState(json.data)
    } catch {
      // The setting is optional chrome on the connection page: no row, no harm.
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  if (!state || state.choices.length < 2) return null

  const other = state.choices.find((a) => a !== state.account) ?? null
  const leftOnOther = other ? (state.balances.find((b) => b.account === other)?.balance ?? 0) : 0
  const pendingLeft = pending ? (state.balances.find((b) => b.account === state.account)?.balance ?? 0) : 0
  const label = (account: Account) => (account === '2012' ? t('option_2012') : t('option_1630'))

  async function save(account: Account) {
    setSaving(true)
    try {
      const res = await fetch('/api/settings/skattekonto-account', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ account }),
      })
      const json = (await res.json()) as { data?: { state: AccountState } } & ErrorEnvelope
      if (!res.ok || !json.data) {
        toast({ title: t('save_failed'), description: getErrorMessage(json, { locale: errorLocale, fallback: t('save_failed') }), variant: 'destructive' })
        return
      }
      setState(json.data.state)
      setDraftId(null)
      toast({ title: t('saved', { account }) })
    } catch {
      toast({ title: t('save_failed'), variant: 'destructive' })
    } finally {
      setSaving(false)
      setPending(null)
    }
  }

  async function draftTransfer() {
    setDrafting(true)
    try {
      const res = await fetch('/api/settings/skattekonto-account/transfer-draft', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      const json = (await res.json()) as { data?: { journal_entry_id: string } } & ErrorEnvelope
      if (!res.ok || !json.data) {
        toast({ title: t('draft_failed'), description: getErrorMessage(json, { locale: errorLocale, fallback: t('draft_failed') }), variant: 'destructive' })
        return
      }
      setDraftId(json.data.journal_entry_id)
      toast({ title: t('draft_created') })
    } catch {
      toast({ title: t('draft_failed'), variant: 'destructive' })
    } finally {
      setDrafting(false)
    }
  }

  return (
    <SettingsGroup label={t('group_label')}>
      <SettingsRow label={t('account_label')} help={t('account_help')}>
        <SettingsSeg<Account>
          value={state.account}
          onChange={(account) => {
            if (account !== state.account) setPending(account)
          }}
          options={state.choices.map((account) => ({ value: account, label: label(account) }))}
          aria-label={t('account_label')}
          disabled={saving}
        />
        {state.chosen === null && state.books_suggest && state.books_suggest !== state.account ? (
          <SettingsRowNote>{t('books_suggest', { account: state.books_suggest })}</SettingsRowNote>
        ) : null}
      </SettingsRow>
      {other && leftOnOther !== 0 ? (
        <SettingsRow label={t('left_label', { account: other })} help={t('left_help')} borderless>
          <SettingsRowNote>{t('left_amount', { amount: formatCurrency(leftOnOther), account: other })}</SettingsRowNote>
          {draftId ? (
            <Link href={`/bookkeeping/${draftId}`} className="text-[13px] underline underline-offset-2">
              {t('draft_open')}
            </Link>
          ) : (
            <Button variant="outline" size="sm" loading={drafting} onClick={() => void draftTransfer()}>
              {t('draft_button', { from: other, to: state.account })}
            </Button>
          )}
        </SettingsRow>
      ) : null}

      <ConfirmationDialog
        open={pending !== null}
        onOpenChange={(open) => {
          if (!open) setPending(null)
        }}
        onConfirm={() => {
          if (pending) void save(pending)
        }}
        isSubmitting={saving}
        title={t('confirm_title', { account: pending ?? '' })}
        confirmLabel={t('confirm_button')}
      >
        <div className="space-y-3 text-[13px]">
          <p>{t('confirm_body', { account: pending ?? '', previous: state.account })}</p>
          {pendingLeft !== 0 ? (
            <p>{t('confirm_left', { amount: formatCurrency(pendingLeft), previous: state.account })}</p>
          ) : null}
        </div>
      </ConfirmationDialog>
    </SettingsGroup>
  )
}
