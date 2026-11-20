'use client'

import { useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { Switch } from '@/components/ui/switch'
import {
  SettingsDangerZone,
  SettingsGroup,
  SettingsInput,
  SettingsReveal,
  SettingsRow,
  SettingsRowEnd,
  SettingsRowNote,
  SettingsSelect,
} from '@/components/settings/SettingsRows'
import { validateBookingAccounts, validateRulesStep, type ActivationErrorKey } from '@/lib/collections/activation-form'
import type { CollectionConnectionView } from '@/lib/collections/connection'
import { resolveStartStep, startStepsFor } from '@/lib/collections/start-step'
import { todayIsoStockholm } from '@/lib/dates/iso'
import { collectionsAction, useCollectionsWords, type CollectionsSettingsData } from './collections-client'
import { parseDecimalInput } from '@/lib/money'

/**
 * An active connection: its rules under Regler (the two approvals locked
 * on, the first step, the minimum, the reminder fee and interest terms, and
 * the morning proposals when the installation offers them), the booking
 * accounts and automatic booking, delivery when offered, and ending the
 * connection, which waits until nothing is open at the provider. Activation
 * sets the rules' defaults; owners and admins change them here any time,
 * everyone else reads.
 */

interface RulesForm {
  minimumAmount: string
  defaultStartStep: 'reminder' | 'collection'
  reminderFeeTermsSince: string
  interestPercent: string
  interestSince: string
}

function formOf(connection: CollectionConnectionView): RulesForm {
  const s = connection.settings
  return {
    minimumAmount: String(s.minimumAmount),
    defaultStartStep: s.defaultStartStep,
    reminderFeeTermsSince: s.reminderFeeTermsSince ?? '',
    interestPercent: s.lateInterestPercent === null ? '' : String(s.lateInterestPercent),
    interestSince: s.lateInterestAgreedSince ?? '',
  }
}

// Empty reads as 0, as Number('') did; text that is no number stays NaN for the
// server's validation to name.
const toNumber = (value: string): number =>
  value.trim() === '' ? 0 : (parseDecimalInput(value) ?? Number.NaN)

interface Props {
  data: CollectionsSettingsData
  connection: CollectionConnectionView
  onChanged: () => Promise<void> | void
}

export function ConnectionSettingsPanel({ data, connection, onChanged }: Props) {
  const { t, tp, locale } = useCollectionsWords(data.availability.displayName ?? connection.displayName)
  const canManage = data.canManage
  const initial = useMemo(() => formOf(connection), [connection])
  const [form, setForm] = useState<RulesForm>(initial)
  const [errors, setErrors] = useState<Record<string, ActivationErrorKey>>({})
  const [busy, setBusy] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const [confirmDisconnect, setConfirmDisconnect] = useState(false)
  const initialAccounts = useMemo(
    () => ({ clearingAccount: connection.settings.clearingAccount, payoutAccount: connection.settings.payoutAccount }),
    [connection],
  )
  const [accounts, setAccounts] = useState(initialAccounts)
  const [accountsSaved, setAccountsSaved] = useState(false)
  const accountsDirty = JSON.stringify(accounts) !== JSON.stringify(initialAccounts)
  const [ladderDays, setLadderDays] = useState(String(connection.settings.ladderDaysAfterDue))
  const [ladderDaysError, setLadderDaysError] = useState(false)

  const dirty = JSON.stringify(form) !== JSON.stringify(initial)
  const allowedStartSteps = startStepsFor(
    data.availability.provider?.features.startSteps ?? ['reminder', 'collection'],
    form.reminderFeeTermsSince.trim() !== '',
  )
  const shownStartStep = resolveStartStep(form.defaultStartStep, allowedStartSteps) ?? form.defaultStartStep
  const blocked = data.availability.obligations

  const errorNote = (field: string) =>
    errors[field] ? <SettingsRowNote className="basis-full text-destructive">{t(`error_${errors[field]}`)}</SettingsRowNote> : null

  async function patch(key: string, body: Record<string, unknown>): Promise<boolean> {
    setBusy(key)
    setMessage(null)
    const result = await collectionsAction('', body, locale, 'PATCH')
    setBusy(null)
    if (!result.ok) {
      setErrors(result.fieldErrors)
      setMessage(Object.keys(result.fieldErrors).length > 0 ? null : result.message)
      return false
    }
    await onChanged()
    return true
  }

  async function saveLadderDays() {
    const days = Number(ladderDays.trim())
    if (days === connection.settings.ladderDaysAfterDue) return
    if (!Number.isInteger(days) || days < 1 || days > 60) {
      setLadderDaysError(true)
      return
    }
    setLadderDaysError(false)
    await patch('ladder_days', { ladderDaysAfterDue: days })
  }

  async function save() {
    const interest = form.interestPercent.trim() !== '' || form.interestSince.trim() !== ''
    const lateInterest = interest ? { percent: toNumber(form.interestPercent), agreedSince: form.interestSince.trim() } : null
    const body = {
      minimumAmount: toNumber(form.minimumAmount),
      defaultStartStep: form.defaultStartStep,
      reminderFeeTermsSince: form.reminderFeeTermsSince.trim() || null,
      lateInterest,
    }
    const found = validateRulesStep(
      { ...body, ladderMode: connection.settings.ladderMode },
      { today: todayIsoStockholm(), requireLadderChoice: false },
    )
    const local: Record<string, ActivationErrorKey> = {}
    for (const [field, key] of Object.entries(found)) if (key) local[field] = key
    setErrors(local)
    if (Object.keys(local).length > 0) return
    if (await patch('save', body)) {
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    }
  }

  async function saveAccounts() {
    const body = { clearingAccount: accounts.clearingAccount.trim(), payoutAccount: accounts.payoutAccount.trim() }
    const local = validateBookingAccounts(body)
    setErrors(local)
    if (Object.keys(local).length > 0) return
    if (await patch('accounts', body)) {
      setAccountsSaved(true)
      setTimeout(() => setAccountsSaved(false), 2000)
    }
  }

  return (
    <div>
      <SettingsGroup label={t('section_rules')}>
        <SettingsRow label={t('rule_legal_action')} help={t('rule_legal_action_locked')}>
          <Switch checked disabled aria-label={t('rule_legal_action')} />
        </SettingsRow>
        <SettingsRow label={t('rule_collection_notice')} help={t('rule_collection_notice_locked')}>
          <Switch checked disabled aria-label={t('rule_collection_notice')} />
        </SettingsRow>
        <SettingsRow label={t('rule_minimum')} htmlFor="coll-set-min" align="baseline">
          <SettingsInput
            id="coll-set-min"
            inputMode="decimal"
            className="tabular-nums"
            disabled={!canManage}
            value={form.minimumAmount}
            onChange={(e) => setForm({ ...form, minimumAmount: e.target.value })}
          />
          {errorNote('minimumAmount')}
        </SettingsRow>
        <SettingsRow label={t('rule_reminder_fee_since')} htmlFor="coll-set-fee" help={t('rule_reminder_fee_help')} align="baseline">
          <SettingsInput
            id="coll-set-fee"
            type="date"
            disabled={!canManage}
            value={form.reminderFeeTermsSince}
            onChange={(e) => setForm({ ...form, reminderFeeTermsSince: e.target.value })}
          />
          {errorNote('reminderFeeTermsSince')}
        </SettingsRow>
        {/* Without an agreed reminder fee no invoice can start with a reminder (start-step.ts): the select shows
            the step that will go out and offers the reminder only once a date is set. The stored default is
            left as it is, so setting a date later brings the company's choice back. */}
        <SettingsRow label={t('rule_start_step')} htmlFor="coll-set-start" help={t('rule_start_step_help')}>
          <SettingsSelect
            id="coll-set-start"
            disabled={!canManage}
            value={shownStartStep}
            onChange={(e) => setForm({ ...form, defaultStartStep: e.target.value as RulesForm['defaultStartStep'] })}
          >
            <option value="reminder" disabled={!allowedStartSteps.includes('reminder')}>
              {allowedStartSteps.includes('reminder') ? t('start_reminder') : t('start_reminder_needs_fee')}
            </option>
            <option value="collection">{t('start_collection')}</option>
          </SettingsSelect>
        </SettingsRow>
        <SettingsRow label={t('rule_interest')} htmlFor="coll-set-interest" help={t('rule_interest_help')} align="baseline">
          <SettingsInput
            id="coll-set-interest"
            inputMode="decimal"
            className="tabular-nums"
            disabled={!canManage}
            value={form.interestPercent}
            onChange={(e) => setForm({ ...form, interestPercent: e.target.value })}
          />
          {errorNote('lateInterestPercent')}
        </SettingsRow>
        <SettingsReveal open={form.interestPercent.trim() !== '' || form.interestSince.trim() !== ''}>
          <SettingsRow label={t('rule_interest_since')} htmlFor="coll-set-interest-since" align="baseline">
            <SettingsInput
              id="coll-set-interest-since"
              type="date"
              disabled={!canManage}
              value={form.interestSince}
              onChange={(e) => setForm({ ...form, interestSince: e.target.value })}
            />
            {errorNote('lateInterestAgreedSince')}
          </SettingsRow>
        </SettingsReveal>
        {/* The morning proposals are one of the rules (on from activation); they save as they are switched. */}
        {data.availability.ladderEnabled ? (
          <>
            <SettingsRow
              label={tp('ladder_toggle')}
              help={connection.settings.ladderMode === 'staged' ? `${t('ladder_help')} ${t('ladder_off_note')}` : t('ladder_help')}
            >
              <Switch
                checked={connection.settings.ladderMode === 'staged'}
                disabled={!canManage || busy === 'ladder'}
                onCheckedChange={(v) => void patch('ladder', { ladderMode: v ? 'staged' : 'off' })}
                aria-label={tp('ladder_toggle')}
              />
            </SettingsRow>
            <SettingsReveal open={connection.settings.ladderMode === 'staged'}>
              <SettingsRow label={t('ladder_days')} htmlFor="coll-set-ladder-days" align="baseline">
                <SettingsInput
                  id="coll-set-ladder-days"
                  inputMode="numeric"
                  className="tabular-nums"
                  disabled={!canManage || busy === 'ladder_days'}
                  value={ladderDays}
                  onChange={(e) => setLadderDays(e.target.value)}
                  onBlur={() => void saveLadderDays()}
                />
                {ladderDaysError ? <SettingsRowNote className="basis-full text-destructive">{t('ladder_days_invalid')}</SettingsRowNote> : null}
              </SettingsRow>
            </SettingsReveal>
          </>
        ) : null}
        {canManage && (dirty || saved) ? (
          <div className="flex items-center justify-end gap-3 pt-4">
            {saved && !dirty ? <SettingsRowNote>{t('saved')}</SettingsRowNote> : null}
            <Button disabled={!dirty} loading={busy === 'save'} onClick={save}>
              {t('save')}
            </Button>
          </div>
        ) : null}
      </SettingsGroup>

      <SettingsGroup label={t('section_booking')}>
        <SettingsRow label={tp('clearing_account')} htmlFor="coll-set-clearing" help={tp('clearing_account_help')} align="baseline">
          <SettingsInput
            id="coll-set-clearing"
            inputMode="numeric"
            maxLength={4}
            className="tabular-nums"
            disabled={!canManage}
            value={accounts.clearingAccount}
            onChange={(e) => setAccounts({ ...accounts, clearingAccount: e.target.value })}
          />
          {errorNote('clearingAccount')}
        </SettingsRow>
        <SettingsRow label={tp('payout_account')} htmlFor="coll-set-payout" align="baseline">
          <SettingsInput
            id="coll-set-payout"
            inputMode="numeric"
            maxLength={4}
            className="tabular-nums"
            disabled={!canManage}
            value={accounts.payoutAccount}
            onChange={(e) => setAccounts({ ...accounts, payoutAccount: e.target.value })}
          />
          {errorNote('payoutAccount')}
        </SettingsRow>
        {canManage && (accountsDirty || accountsSaved) ? (
          <div className="flex items-center justify-end gap-3 pt-4">
            {accountsSaved && !accountsDirty ? <SettingsRowNote>{t('saved')}</SettingsRowNote> : null}
            <Button disabled={!accountsDirty} loading={busy === 'accounts'} onClick={saveAccounts}>
              {t('save')}
            </Button>
          </div>
        ) : null}
        <SettingsRow label={tp('auto_book_payments')} help={t('auto_book_help')}>
          <Switch
            checked={connection.settings.autoBookCollectedPayments}
            disabled={!canManage || busy === 'auto_payments'}
            onCheckedChange={(v) => void patch('auto_payments', { autoBookCollectedPayments: v })}
            aria-label={tp('auto_book_payments')}
          />
        </SettingsRow>
        <SettingsRow label={tp('auto_book')} help={t('auto_book_help')}>
          <Switch
            checked={connection.settings.autoBookSettlements}
            disabled={!canManage || busy === 'auto_settlements'}
            onCheckedChange={(v) => void patch('auto_settlements', { autoBookSettlements: v })}
            aria-label={tp('auto_book')}
          />
        </SettingsRow>
      </SettingsGroup>

      {data.availability.deliveryEnabled ? (
        <SettingsGroup label={t('section_distribution')}>
          <SettingsRow label={tp('distribution_toggle')} help={tp('distribution_help')}>
            <Switch
              checked={connection.settings.distributionEnabled}
              disabled={!canManage || busy === 'distribution'}
              onCheckedChange={(v) => void patch('distribution', { distributionEnabled: v })}
              aria-label={tp('distribution_toggle')}
            />
          </SettingsRow>
        </SettingsGroup>
      ) : null}

      {message ? <p className="pt-4 text-xs text-attn">{message}</p> : null}

      {canManage ? (
        <SettingsDangerZone label={t('danger_zone')}>
          <SettingsRow label={t('disconnect')} borderless>
            {blocked ? <SettingsRowNote>{t('disconnect_blocked')}</SettingsRowNote> : null}
            <SettingsRowEnd>
              <Button variant="outline" disabled={blocked} onClick={() => setConfirmDisconnect(true)}>
                {t('disconnect')}
              </Button>
            </SettingsRowEnd>
          </SettingsRow>
        </SettingsDangerZone>
      ) : null}

      <ConfirmDialog
        open={confirmDisconnect}
        onOpenChange={setConfirmDisconnect}
        title={t('disconnect')}
        description={tp('disconnect_confirm')}
        confirmLabel={t('disconnect')}
        destructive
        onConfirm={async () => {
          setBusy('disconnect')
          const result = await collectionsAction('/disconnect', {}, locale)
          setBusy(null)
          setConfirmDisconnect(false)
          if (!result.ok) setMessage(result.message)
          await onChanged()
        }}
      />
    </div>
  )
}
