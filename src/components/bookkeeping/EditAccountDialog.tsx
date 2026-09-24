'use client'

import { useEffect, useState } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import { Textarea } from '@/components/ui/textarea'
import { Switch } from '@/components/ui/switch'
import { useToast } from '@/components/ui/use-toast'
import { getErrorMessage, type ErrorLocale } from '@/lib/errors/get-error-message'
import { Plus, X } from 'lucide-react'
import DimensionCombobox from '@/components/dimensions/DimensionCombobox'
import {
  type AccountDimensionRuleDto,
  type DimensionDto,
  type DimensionRuleType,
} from '@/components/dimensions/types'
import type { BASAccount } from '@/types'
import { useCompanySettings, useDimensions } from '@/lib/reference-data/hooks'
import { fetchDimensions } from '@/lib/reference-data/fetchers'
import { invalidateReferenceData } from '@/lib/reference-data/invalidate'
import { AccountVatTreatmentSelect } from './AccountVatTreatmentSelect'
import { AccountVatBoxSelect } from '@/components/bookkeeping/AccountVatBoxSelect'
import { isVatBoxAccount, type AccountVatBox } from '@/lib/vat/account-vat-box'
import {
  defaultRateForVatTreatment,
  type AccountVatTreatment,
} from '@/lib/vat/account-vat-treatment'

interface EditAccountDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  account: BASAccount
  onSaved: () => void
}

// Rule types in display order. Labels mirror the rule semantics enforced by
// the engine at commit time.
const RULE_TYPES: DimensionRuleType[] = ['required', 'default', 'fixed']

export function EditAccountDialog({ open, onOpenChange, account, onSaved }: EditAccountDialogProps) {
  const t = useTranslations('edit_account_dialog')
  const tc = useTranslations('common')
  const errorLocale = useLocale() as ErrorLocale
  const { toast } = useToast()
  const ruleTypeLabels: Record<DimensionRuleType, string> = {
    required: t('rule_type_required'),
    default: t('rule_type_default'),
    fixed: t('rule_type_fixed'),
  }
  const ruleTypeHelp: Record<DimensionRuleType, string> = {
    required: t('rule_type_required_help'),
    default: t('rule_type_default_help'),
    fixed: t('rule_type_fixed_help'),
  }
  const [accountName, setAccountName] = useState(account.account_name)
  const [description, setDescription] = useState(account.description || '')
  // "Standard moms": the moms-sats a booking line defaults to when this konto is
  // picked (currently the leverantörsfaktura-rad). 'none' = no default. Stored
  // as a decimal fraction; SelectItem values are the stringified decimals.
  const [defaultVatRate, setDefaultVatRate] = useState(
    account.default_vat_rate != null ? String(account.default_vat_rate) : 'none',
  )
  const [defaultVatTreatment, setDefaultVatTreatment] = useState<AccountVatTreatment | 'none'>(
    account.default_vat_treatment ?? 'none',
  )
  // Momsruta override for 26xx VAT accounts: 'bas' (null) = BAS mapping by number.
  const [vatBox, setVatBox] = useState<AccountVatBox | 'bas'>(account.vat_box ?? 'bas')
  const [sruCode, setSruCode] = useState(account.sru_code || '')
  const [isActive, setIsActive] = useState(account.is_active)
  const [isSaving, setIsSaving] = useState(false)

  // Dimension rules ("Dimensionsregler") — visible only when the company has
  // dimensions enabled (same /api/settings gate as JournalEntryForm). Rule
  // mutations apply immediately via their own fetches + toasts; they are
  // deliberately independent of the account PUT below.
  // Settings and the dimension registry come from the session cache
  // (lib/reference-data), so the section and its pickers are ready on open.
  const { settings: companySettings } = useCompanySettings()
  const dimensionsEnabled = companySettings?.dimensions_enabled === true
  const { dimensions: dims } = useDimensions()
  const [rules, setRules] = useState<AccountDimensionRuleDto[]>([])
  const [rulesLoading, setRulesLoading] = useState(false)
  const [addRuleOpen, setAddRuleOpen] = useState(false)
  const [newRuleDimensionId, setNewRuleDimensionId] = useState('')
  const [newRuleType, setNewRuleType] = useState<DimensionRuleType>('required')
  const [newRuleValueCode, setNewRuleValueCode] = useState<string | null>(null)
  const [isAddingRule, setIsAddingRule] = useState(false)

  useEffect(() => {
    if (!dimensionsEnabled) return
    let cancelled = false
    setRulesLoading(true)
    fetch(`/api/dimensions/rules?account_number=${account.account_number}`)
      .then(async (r) => ({ ok: r.ok, json: await r.json().catch(() => null) }))
      .catch(() => ({ ok: false, json: null }))
      .then((rulesRes) => {
      if (cancelled) return
      if (rulesRes.ok) {
        setRules((rulesRes.json?.data?.rules ?? []) as AccountDimensionRuleDto[])
      }
      setRulesLoading(false)
    })
    return () => {
      cancelled = true
    }
  }, [dimensionsEnabled, account.account_number])

  const activeDims = dims.filter((d) => d.is_active)
  const newRuleDim = activeDims.find((d) => d.id === newRuleDimensionId) ?? null
  const newRuleNeedsValue = newRuleType === 'default' || newRuleType === 'fixed'

  function resetAddRuleForm() {
    setAddRuleOpen(false)
    setNewRuleDimensionId('')
    setNewRuleType('required')
    setNewRuleValueCode(null)
  }

  async function handleAddRule() {
    if (!newRuleDim) return
    setIsAddingRule(true)
    try {
      // Resolve the picked code to a value id. The combobox can create values
      // inline, so a code missing from the mount-time registry snapshot means
      // we refetch once before giving up.
      let valueId: string | null = null
      if (newRuleNeedsValue) {
        const code = newRuleValueCode
        if (!code) return
        const findValueId = (list: DimensionDto[]) =>
          list
            .find((d) => d.id === newRuleDim.id)
            ?.values.find((v) => v.code === code)?.id ?? null
        valueId = findValueId(dims)
        if (!valueId) {
          const refreshed = await fetchDimensions().catch(() => null)
          if (refreshed) {
            // Hand the fresh registry to the shared cache as well.
            void invalidateReferenceData('ref:dimensions')
            valueId = findValueId(refreshed)
          }
        }
        if (!valueId) {
          toast({
            title: t('add_rule_failed'),
            description: t('value_not_found', { code }),
            variant: 'destructive',
          })
          return
        }
      }

      const body: Record<string, unknown> = {
        account_number: account.account_number,
        dimension_id: newRuleDim.id,
        rule_type: newRuleType,
      }
      if (valueId) body.value_id = valueId
      const res = await fetch('/api/dimensions/rules', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const json = await res.json().catch(() => null)
      if (!res.ok) {
        toast({
          title: t('add_rule_failed'),
          description: getErrorMessage(json, { locale: errorLocale }),
          variant: 'destructive',
        })
        return
      }
      const created = json?.data?.rule as AccountDimensionRuleDto | undefined
      if (created) setRules((prev) => [...prev, created])
      toast({ title: t('rule_added') })
      resetAddRuleForm()
    } finally {
      setIsAddingRule(false)
    }
  }

  async function handleToggleRule(rule: AccountDimensionRuleDto, checked: boolean) {
    const ruleId = rule.account_dimension_rule_id
    // Optimistic — the switch flips immediately and reverts on failure.
    setRules((prev) =>
      prev.map((r) =>
        r.account_dimension_rule_id === ruleId ? { ...r, is_active: checked } : r,
      ),
    )
    const res = await fetch(`/api/dimensions/rules/${ruleId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ is_active: checked }),
    }).catch(() => null)
    const json = await res?.json().catch(() => null)
    if (!res?.ok) {
      setRules((prev) =>
        prev.map((r) =>
          r.account_dimension_rule_id === ruleId ? { ...r, is_active: rule.is_active } : r,
        ),
      )
      toast({
        title: t('update_rule_failed'),
        description: getErrorMessage(json, { locale: errorLocale }),
        variant: 'destructive',
      })
      return
    }
    const updated = json?.data?.rule as AccountDimensionRuleDto | undefined
    if (updated) {
      setRules((prev) =>
        prev.map((r) => (r.account_dimension_rule_id === ruleId ? updated : r)),
      )
    }
  }

  async function handleDeleteRule(rule: AccountDimensionRuleDto) {
    const ruleId = rule.account_dimension_rule_id
    const res = await fetch(`/api/dimensions/rules/${ruleId}`, {
      method: 'DELETE',
    }).catch(() => null)
    if (!res?.ok) {
      const json = await res?.json().catch(() => null)
      toast({
        title: t('delete_rule_failed'),
        description: getErrorMessage(json, { locale: errorLocale }),
        variant: 'destructive',
      })
      return
    }
    setRules((prev) => prev.filter((r) => r.account_dimension_rule_id !== ruleId))
    toast({ title: t('rule_deleted') })
  }

  async function handleSave() {
    setIsSaving(true)
    try {
      const response = await fetch(`/api/bookkeeping/accounts/${account.account_number}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          account_name: accountName,
          description: description || null,
          default_vat_rate: defaultVatRate === 'none' ? null : parseFloat(defaultVatRate),
          default_vat_treatment: defaultVatTreatment === 'none' ? null : defaultVatTreatment,
          ...(isVatBoxAccount(account.account_number)
            ? { vat_box: vatBox === 'bas' ? null : vatBox }
            : {}),
          sru_code: sruCode || null,
          is_active: isActive,
        }),
      })

      if (!response.ok) {
        const data = await response.json().catch(() => null)
        // Keep the dialog open so the user can correct and retry; map the
        // server error to Swedish like the dimension-rule handlers above.
        toast({
          title: t('update_failed'),
          description: getErrorMessage(data, { locale: errorLocale }),
          variant: 'destructive',
        })
        return
      }

      onSaved()
      onOpenChange(false)
    } catch {
      toast({
        title: t('update_failed'),
        variant: 'destructive',
      })
    } finally {
      setIsSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[95dvh] sm:max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {t.rich('title', {
              account: account.account_number,
              mask: (chunks) => <span data-ph-mask="">{chunks}</span>,
            })}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="space-y-2">
            <Label>{t('account_name_label')}</Label>
            <Input
              value={accountName}
              onChange={(e) => setAccountName(e.target.value)}
            />
          </div>

          <div className="space-y-2">
            <Label>{t('description_label')}</Label>
            <Textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={t('description_placeholder')}
              rows={2}
            />
          </div>

          <AccountVatTreatmentSelect
            value={defaultVatTreatment}
            accountClass={account.account_class}
            onValueChange={(treatment) => {
              setDefaultVatTreatment(treatment)
              if (treatment !== 'none' && defaultVatRate === 'none') {
                const rate = defaultRateForVatTreatment(treatment, account.account_class)
                if (rate !== null) setDefaultVatRate(String(rate))
              }
            }}
          />

          {isVatBoxAccount(account.account_number) && (
            <AccountVatBoxSelect
              value={vatBox}
              onValueChange={setVatBox}
              accountNumber={account.account_number}
              accountName={accountName}
            />
          )}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>{t('default_vat_label')}</Label>
              <Select value={defaultVatRate} onValueChange={setDefaultVatRate}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">{t('default_vat_none')}</SelectItem>
                  <SelectItem value="0">{t('default_vat_zero')}</SelectItem>
                  <SelectItem value="0.25">25 %</SelectItem>
                  <SelectItem value="0.12">12 %</SelectItem>
                  <SelectItem value="0.06">6 %</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>{t('sru_code_label')}</Label>
              <Input
                value={sruCode}
                onChange={(e) => setSruCode(e.target.value)}
                placeholder={t('sru_code_placeholder')}
              />
            </div>
          </div>

          {dimensionsEnabled && (
            <div className="space-y-3">
              <p className="text-sm font-medium">{t('dimension_rules_title')}</p>

              {rulesLoading ? (
                <Skeleton className="h-10 w-full" />
              ) : (
                <>
                  {rules.length === 0 && !addRuleOpen && (
                    <div className="flex items-center justify-between gap-3">
                      <p className="text-xs text-muted-foreground">
                        {t('no_rules')}
                      </p>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setAddRuleOpen(true)}
                      >
                        <Plus className="mr-1 h-3.5 w-3.5" />
                        {t('add_rule')}
                      </Button>
                    </div>
                  )}

                  {rules.map((rule) => (
                    <div
                      key={rule.account_dimension_rule_id}
                      className="flex items-center gap-3 rounded-lg border p-3"
                    >
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium truncate">
                          {rule.dimension_name}
                        </p>
                        <p className="text-xs text-muted-foreground truncate">
                          {ruleTypeLabels[rule.rule_type]}
                          {rule.value_code && (
                            <>
                              {' · '}
                              <span className="font-mono">{rule.value_code}</span>
                              {rule.value_name && rule.value_name !== rule.value_code
                                ? ` ${rule.value_name}`
                                : ''}
                            </>
                          )}
                        </p>
                      </div>
                      <Switch
                        checked={rule.is_active}
                        onCheckedChange={(checked) => handleToggleRule(rule, checked)}
                        aria-label={t('rule_active_aria', { dimension: rule.dimension_name })}
                      />
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={t('rule_delete_aria', { dimension: rule.dimension_name })}
                        onClick={() => handleDeleteRule(rule)}
                      >
                        <X className="h-4 w-4" />
                      </Button>
                    </div>
                  ))}

                  {addRuleOpen ? (
                    <div className="space-y-3 rounded-lg border border-dashed p-3">
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                        <div className="space-y-1">
                          <Label className="text-xs text-muted-foreground">
                            {t('dimension_label')}
                          </Label>
                          <Select
                            value={newRuleDimensionId || undefined}
                            onValueChange={(id) => {
                              setNewRuleDimensionId(id)
                              setNewRuleValueCode(null)
                            }}
                          >
                            <SelectTrigger>
                              <SelectValue placeholder={t('dimension_placeholder')} />
                            </SelectTrigger>
                            <SelectContent>
                              {activeDims.map((dim) => (
                                <SelectItem key={dim.id} value={dim.id}>
                                  {dim.name}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                        <div className="space-y-1">
                          <Label className="text-xs text-muted-foreground">{t('type_label')}</Label>
                          <Select
                            value={newRuleType}
                            onValueChange={(v) => {
                              setNewRuleType(v as DimensionRuleType)
                              if (v === 'required') setNewRuleValueCode(null)
                            }}
                          >
                            <SelectTrigger>
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              {RULE_TYPES.map((type) => (
                                <SelectItem key={type} value={type}>
                                  {ruleTypeLabels[type]}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                      </div>
                      <p className="text-xs text-muted-foreground">
                        {ruleTypeHelp[newRuleType]}
                      </p>
                      {newRuleNeedsValue && newRuleDim && (
                        <div className="space-y-1">
                          <Label className="text-xs text-muted-foreground">{t('value_label')}</Label>
                          <DimensionCombobox
                            sieDimNo={String(newRuleDim.sie_dim_no)}
                            value={newRuleValueCode}
                            onChange={setNewRuleValueCode}
                          />
                        </div>
                      )}
                      <div className="flex justify-end gap-2">
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={isAddingRule}
                          onClick={resetAddRuleForm}
                        >
                          {tc('cancel')}
                        </Button>
                        <Button
                          size="sm"
                          disabled={
                            !newRuleDim ||
                            (newRuleNeedsValue && !newRuleValueCode)
                          }
                          loading={isAddingRule}
                          onClick={handleAddRule}
                        >
                          {t('add')}
                        </Button>
                      </div>
                    </div>
                  ) : (
                    rules.length > 0 && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setAddRuleOpen(true)}
                      >
                        <Plus className="mr-1 h-3.5 w-3.5" />
                        {t('add_rule')}
                      </Button>
                    )
                  )}
                </>
              )}
            </div>
          )}

          <div className="flex items-center justify-between rounded-lg border p-3">
            <div>
              <p className="text-sm font-medium">{t('active_label')}</p>
              <p className="text-xs text-muted-foreground">
                {t('active_hint')}
              </p>
            </div>
            <Switch checked={isActive} onCheckedChange={setIsActive} />
          </div>

          {account.is_system_account && (
            <p className="text-xs text-muted-foreground bg-muted rounded-sm p-2">
              {t('system_account')}
            </p>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {tc('cancel')}
          </Button>
          <Button onClick={handleSave} disabled={!accountName.trim()} loading={isSaving}>
            {tc('save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
