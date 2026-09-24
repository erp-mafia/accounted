'use client'

import { useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { AlertTriangle } from 'lucide-react'
import { isStandardBASAccountNumber } from '@/lib/bookkeeping/bas-account-numbers'
import { classifyAccountClient as classifyAccount } from '@/lib/bookkeeping/account-classifier-client'
import { useBasReference } from '@/lib/bookkeeping/use-bas-reference'
import type { BASAccount } from '@/types'
import { getErrorMessage as getUserErrorMessage } from '@/lib/errors/get-error-message'
import { AccountVatTreatmentSelect } from './AccountVatTreatmentSelect'
import {
  defaultRateForVatTreatment,
  isVatTreatmentAllowedForAccountClass,
  type AccountVatTreatment,
} from '@/lib/vat/account-vat-treatment'

/**
 * The create path hands back the full row the API inserted. The reactivate
 * path only learns the account number back from /accounts/activate, and the
 * stored account is deliberately left untouched, so the rest is unknown here.
 * Every host refetches its own list and reads only account_number.
 */
type CreatedAccount = Partial<BASAccount> & { account_number: string }

interface AddAccountDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreated: (account: CreatedAccount) => void
  initialAccountNumber?: string
  initialAccountName?: string
}

export function AddAccountDialog({
  open,
  onOpenChange,
  onCreated,
  initialAccountNumber,
  initialAccountName,
}: AddAccountDialogProps) {
  // Loads the BAS chart chunk after mount so classification and the
  // standard-account check get the authoritative answer once it lands.
  useBasReference()
  const t = useTranslations('add_account_dialog')
  const tc = useTranslations('common')
  const [accountNumber, setAccountNumber] = useState('')
  const [accountName, setAccountName] = useState('')
  const [description, setDescription] = useState('')
  // "Standard moms": the moms-sats a booking line defaults to when this konto is
  // picked. 'none' = no default. SelectItem values are stringified decimals.
  const [defaultVatRate, setDefaultVatRate] = useState('none')
  const [defaultVatTreatment, setDefaultVatTreatment] = useState<AccountVatTreatment | 'none'>('none')
  const [sruCode, setSruCode] = useState('')
  const [normalBalance, setNormalBalance] = useState<'debit' | 'credit'>('debit')
  const [isSaving, setIsSaving] = useState(false)
  const [error, setError] = useState('')
  // Set when the create failed because the number belongs to a deactivated
  // account. Creating it can never succeed (the unique constraint counts
  // inactive rows), so the dialog offers reactivation instead of a dead end.
  const [inactiveConflict, setInactiveConflict] = useState(false)

  // Apply prefill values whenever the dialog opens. Resetting on close happens
  // implicitly after a successful create; here we only need to seed inputs so
  // the user doesn't retype what the combobox already captured.
  useEffect(() => {
    if (!open) return
    const num = (initialAccountNumber ?? '').replace(/\D/g, '').slice(0, 4)
    setAccountNumber(num)
    setAccountName(initialAccountName ?? '')
    setDefaultVatRate('none')
    setDefaultVatTreatment('none')
    setError('')
    setInactiveConflict(false)
    if (num.length === 4) {
      setNormalBalance(classifyAccount(num).normal_balance)
    }
  }, [open, initialAccountNumber, initialAccountName])

  const isBASMatch = accountNumber.length === 4 && isStandardBASAccountNumber(accountNumber)
  const derived = accountNumber.length === 4 ? classifyAccount(accountNumber) : null

  async function handleCreate() {
    setError('')
    setInactiveConflict(false)

    if (!/^\d{4}$/.test(accountNumber)) {
      setError(t('error_account_number_format'))
      return
    }

    if (!accountName.trim()) {
      setError(t('error_name_required'))
      return
    }

    setIsSaving(true)
    try {
      const response = await fetch('/api/bookkeeping/accounts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          account_number: accountNumber,
          account_name: accountName.trim(),
          account_type: derived?.account_type || 'expense',
          normal_balance: normalBalance,
          description: description || null,
          default_vat_rate: defaultVatRate === 'none' ? null : parseFloat(defaultVatRate),
          default_vat_treatment: defaultVatTreatment === 'none' ? null : defaultVatTreatment,
          sru_code: sruCode || null,
        }),
      })

      if (!response.ok) {
        // Map the response itself, not `new Error(data.error)`: the route
        // answers thrown errors with the canonical envelope
        // `{ error: { code, message } }`, and the Error constructor would
        // stringify that object to "[object Object]", throwing away the
        // route's own Swedish reason. Passing the parsed body plus the status
        // resolves all three shapes (envelope, bare string, no body).
        const body = await response.json().catch(() => null)
        const code = (body as { error?: { code?: string } } | null)?.error?.code
        setInactiveConflict(code === 'ACCOUNT_EXISTS_INACTIVE')
        setError(getUserErrorMessage(body, { statusCode: response.status }))
        return
      }

      const { data: createdAccount } = await response.json() as { data: BASAccount }

      // Reset form
      setAccountNumber('')
      setAccountName('')
      setDescription('')
      setDefaultVatRate('none')
      setDefaultVatTreatment('none')
      setSruCode('')
      onCreated(createdAccount)
      onOpenChange(false)
    } catch (err) {
      setError(err instanceof Error ? getUserErrorMessage(err) : t('error_generic'))
    } finally {
      setIsSaving(false)
    }
  }

  // Recovery for ACCOUNT_EXISTS_INACTIVE: flip the existing account back on
  // instead of trying to insert a second row. The values typed into this form
  // are intentionally dropped — the account comes back exactly as it was, and
  // renaming it is the kontoplan's job, not a side effect of a failed create.
  async function handleReactivate() {
    setError('')
    setIsSaving(true)
    try {
      const response = await fetch('/api/bookkeeping/accounts/activate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ account_numbers: [accountNumber] }),
      })

      if (!response.ok) {
        const body = await response.json().catch(() => null)
        setError(getUserErrorMessage(body, { statusCode: response.status }))
        return
      }

      setInactiveConflict(false)
      setAccountNumber('')
      setAccountName('')
      setDescription('')
      setDefaultVatRate('none')
      setDefaultVatTreatment('none')
      setSruCode('')
      onCreated({ account_number: accountNumber })
      onOpenChange(false)
    } catch (err) {
      setError(err instanceof Error ? getUserErrorMessage(err) : t('error_generic'))
    } finally {
      setIsSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('title')}</DialogTitle>
          <DialogDescription>
            {t('description')}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          {isBASMatch && (
            <div className="flex items-start gap-2 rounded-lg bg-muted/30 border border-border p-3">
              <AlertTriangle className="h-4 w-4 text-attn mt-0.5 shrink-0" />
              <p className="text-sm text-attn">
                {t('bas_match_warning', { number: accountNumber })}
              </p>
            </div>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>{t('account_number')}</Label>
              <Input
                value={accountNumber}
                onChange={(e) => {
                  const v = e.target.value.replace(/\D/g, '').slice(0, 4)
                  setAccountNumber(v)
                  const nextClass = v.length > 0 ? Number(v[0]) : null
                  if (
                    defaultVatTreatment !== 'none' &&
                    (nextClass === null || !isVatTreatmentAllowedForAccountClass(
                      defaultVatTreatment,
                      nextClass,
                    ))
                  ) {
                    setDefaultVatTreatment('none')
                  }
                  // The conflict is about a specific number; editing it makes
                  // the reactivate offer stale.
                  setInactiveConflict(false)
                  setError('')
                  if (v.length === 4) {
                    setNormalBalance(classifyAccount(v).normal_balance)
                  }
                }}
                placeholder={t('account_number_placeholder')}
                maxLength={4}
                className="font-mono"
              />
            </div>
            <div className="space-y-2">
              <Label>{t('normal_balance')}</Label>
              <Select value={normalBalance} onValueChange={(v) => { if (v) setNormalBalance(v as 'debit' | 'credit') }}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="debit">{t('debit')}</SelectItem>
                  <SelectItem value="credit">{t('credit')}</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          {derived && (
            <p className="text-xs text-muted-foreground">
              {t('detected_type')}{' '}
              <span className="font-medium">
                {derived.account_type === 'asset' ? t('type_asset')
                  : derived.account_type === 'liability' ? t('type_liability')
                  : derived.account_type === 'equity' ? t('type_equity')
                  : derived.account_type === 'untaxed_reserves' ? t('type_untaxed_reserves')
                  : derived.account_type === 'revenue' ? t('type_revenue')
                  : t('type_expense')}
              </span>
            </p>
          )}

          <div className="space-y-2">
            <Label>{t('account_name')}</Label>
            <Input
              value={accountName}
              onChange={(e) => setAccountName(e.target.value)}
              placeholder={t('account_name_placeholder')}
            />
          </div>

          <div className="space-y-2">
            <Label>{t('description_label')} <span className="text-muted-foreground">{t('optional')}</span></Label>
            <Textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={t('description_placeholder')}
              rows={2}
            />
          </div>

          <AccountVatTreatmentSelect
            value={defaultVatTreatment}
            accountClass={derived ? Number(accountNumber.charAt(0)) : null}
            onValueChange={(treatment) => {
              setDefaultVatTreatment(treatment)
              if (treatment !== 'none' && defaultVatRate === 'none') {
                const rate = defaultRateForVatTreatment(treatment, Number(accountNumber.charAt(0)))
                if (rate !== null) setDefaultVatRate(String(rate))
              }
            }}
          />

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>{t('default_vat')} <span className="text-muted-foreground">{t('optional')}</span></Label>
              <Select value={defaultVatRate} onValueChange={setDefaultVatRate}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">{t('vat_no_default')}</SelectItem>
                  <SelectItem value="0">{t('vat_none')}</SelectItem>
                  <SelectItem value="0.25">25 %</SelectItem>
                  <SelectItem value="0.12">12 %</SelectItem>
                  <SelectItem value="0.06">6 %</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>{t('sru_code')} <span className="text-muted-foreground">{t('optional')}</span></Label>
              <Input
                value={sruCode}
                onChange={(e) => setSruCode(e.target.value)}
                placeholder={t('sru_code_placeholder')}
              />
            </div>
          </div>

          {error && !inactiveConflict && (
            <p className="text-sm text-destructive">{error}</p>
          )}

          {inactiveConflict && (
            <div className="space-y-3 rounded-lg border border-border p-3">
              <p className="text-sm text-foreground">{error}</p>
              <Button
                type="button"
                onClick={() => void handleReactivate()}
                loading={isSaving}
              >
                {t('activate_instead')}
              </Button>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {tc('cancel')}
          </Button>
          <Button
            onClick={handleCreate}
            disabled={inactiveConflict || accountNumber.length !== 4 || !accountName.trim()}
            loading={isSaving}
          >
            {t('create')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
