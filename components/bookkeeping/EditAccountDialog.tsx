'use client'

import { useEffect, useState } from 'react'
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
import { getErrorMessage } from '@/lib/errors/get-error-message'
import { Loader2, Plus, X } from 'lucide-react'
import DimensionCombobox from '@/components/dimensions/DimensionCombobox'
import {
  fetchDimensions,
  type AccountDimensionRuleDto,
  type DimensionDto,
  type DimensionRuleType,
} from '@/components/dimensions/types'
import type { BASAccount } from '@/types'

interface EditAccountDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  account: BASAccount
  onSaved: () => void
}

// Hardcoded Swedish per the file's convention (chart-of-accounts editing is a
// bookkeeping surface). Labels mirror the rule semantics enforced by the
// engine at commit time.
const RULE_TYPE_LABELS: Record<DimensionRuleType, string> = {
  required: 'Krävs',
  default: 'Förval',
  fixed: 'Låst',
}

const RULE_TYPE_HELP: Record<DimensionRuleType, string> = {
  required: 'Krävs — verifikat på kontot kan inte bokföras utan värde',
  default: 'Förval — värdet föreslås men kan ändras',
  fixed: 'Låst — värdet sätts alltid automatiskt',
}

export function EditAccountDialog({ open, onOpenChange, account, onSaved }: EditAccountDialogProps) {
  const { toast } = useToast()
  const [accountName, setAccountName] = useState(account.account_name)
  const [description, setDescription] = useState(account.description || '')
  // "Standard moms": the moms-sats a booking line defaults to when this konto is
  // picked (currently the leverantörsfaktura-rad). 'none' = no default. Stored
  // as a decimal fraction; SelectItem values are the stringified decimals.
  const [defaultVatRate, setDefaultVatRate] = useState(
    account.default_vat_rate != null ? String(account.default_vat_rate) : 'none',
  )
  const [sruCode, setSruCode] = useState(account.sru_code || '')
  const [isActive, setIsActive] = useState(account.is_active)
  const [isSaving, setIsSaving] = useState(false)

  // Dimension rules ("Dimensionsregler") — visible only when the company has
  // dimensions enabled (same /api/settings gate as JournalEntryForm). Rule
  // mutations apply immediately via their own fetches + toasts; they are
  // deliberately independent of the account PUT below.
  const [dimensionsEnabled, setDimensionsEnabled] = useState(false)
  const [dims, setDims] = useState<DimensionDto[]>([])
  const [rules, setRules] = useState<AccountDimensionRuleDto[]>([])
  const [rulesLoading, setRulesLoading] = useState(false)
  const [addRuleOpen, setAddRuleOpen] = useState(false)
  const [newRuleDimensionId, setNewRuleDimensionId] = useState('')
  const [newRuleType, setNewRuleType] = useState<DimensionRuleType>('required')
  const [newRuleValueCode, setNewRuleValueCode] = useState<string | null>(null)
  const [isAddingRule, setIsAddingRule] = useState(false)

  useEffect(() => {
    let cancelled = false
    fetch('/api/settings')
      .then((r) => r.json())
      .then(({ data }) => {
        if (!cancelled && data?.dimensions_enabled === true) setDimensionsEnabled(true)
      })
      .catch(() => {
        /* keep the section hidden */
      })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (!dimensionsEnabled) return
    let cancelled = false
    setRulesLoading(true)
    Promise.all([
      fetchDimensions().catch(() => [] as DimensionDto[]),
      fetch(`/api/dimensions/rules?account_number=${account.account_number}`)
        .then(async (r) => ({ ok: r.ok, json: await r.json().catch(() => null) }))
        .catch(() => ({ ok: false, json: null })),
    ]).then(([fetchedDims, rulesRes]) => {
      if (cancelled) return
      setDims(fetchedDims)
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
            setDims(refreshed)
            valueId = findValueId(refreshed)
          }
        }
        if (!valueId) {
          toast({
            title: 'Kunde inte lägga till regeln',
            description: `Värdet ${code} hittades inte i registret.`,
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
          title: 'Kunde inte lägga till regeln',
          description: getErrorMessage(json, { locale: 'sv' }),
          variant: 'destructive',
        })
        return
      }
      const created = json?.data?.rule as AccountDimensionRuleDto | undefined
      if (created) setRules((prev) => [...prev, created])
      toast({ title: 'Regel tillagd' })
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
        title: 'Kunde inte uppdatera regeln',
        description: getErrorMessage(json, { locale: 'sv' }),
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
        title: 'Kunde inte ta bort regeln',
        description: getErrorMessage(json, { locale: 'sv' }),
        variant: 'destructive',
      })
      return
    }
    setRules((prev) => prev.filter((r) => r.account_dimension_rule_id !== ruleId))
    toast({ title: 'Regel borttagen' })
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
          sru_code: sruCode || null,
          is_active: isActive,
        }),
      })

      if (!response.ok) {
        const data = await response.json().catch(() => null)
        // Keep the dialog open so the user can correct and retry; map the
        // server error to Swedish like the dimension-rule handlers above.
        toast({
          title: 'Kunde inte uppdatera kontot',
          description: getErrorMessage(data, { locale: 'sv' }),
          variant: 'destructive',
        })
        return
      }

      onSaved()
      onOpenChange(false)
    } catch {
      toast({
        title: 'Kunde inte uppdatera kontot',
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
            Redigera konto {account.account_number}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="space-y-2">
            <Label>Kontonamn</Label>
            <Input
              value={accountName}
              onChange={(e) => setAccountName(e.target.value)}
            />
          </div>

          <div className="space-y-2">
            <Label>Beskrivning</Label>
            <Textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Kort beskrivning av kontots användning"
              rows={2}
            />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>Standard moms</Label>
              <Select value={defaultVatRate} onValueChange={setDefaultVatRate}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">Ingen standard</SelectItem>
                  <SelectItem value="0">Ingen moms</SelectItem>
                  <SelectItem value="0.25">25 %</SelectItem>
                  <SelectItem value="0.12">12 %</SelectItem>
                  <SelectItem value="0.06">6 %</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>SRU-kod</Label>
              <Input
                value={sruCode}
                onChange={(e) => setSruCode(e.target.value)}
                placeholder="T.ex. 7201"
              />
            </div>
          </div>

          {dimensionsEnabled && (
            <div className="space-y-3">
              <p className="text-sm font-medium">Dimensionsregler</p>

              {rulesLoading ? (
                <Skeleton className="h-10 w-full" />
              ) : (
                <>
                  {rules.length === 0 && !addRuleOpen && (
                    <div className="flex items-center justify-between gap-3">
                      <p className="text-xs text-muted-foreground">
                        Inga dimensionsregler för det här kontot.
                      </p>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setAddRuleOpen(true)}
                      >
                        <Plus className="mr-1 h-3.5 w-3.5" />
                        Lägg till regel
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
                          {RULE_TYPE_LABELS[rule.rule_type]}
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
                        aria-label={`Regel för ${rule.dimension_name} aktiv`}
                      />
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={`Ta bort regel för ${rule.dimension_name}`}
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
                            Dimension
                          </Label>
                          <Select
                            value={newRuleDimensionId || undefined}
                            onValueChange={(id) => {
                              setNewRuleDimensionId(id)
                              setNewRuleValueCode(null)
                            }}
                          >
                            <SelectTrigger>
                              <SelectValue placeholder="Välj dimension" />
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
                          <Label className="text-xs text-muted-foreground">Typ</Label>
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
                              {(Object.keys(RULE_TYPE_LABELS) as DimensionRuleType[]).map(
                                (type) => (
                                  <SelectItem key={type} value={type}>
                                    {RULE_TYPE_LABELS[type]}
                                  </SelectItem>
                                ),
                              )}
                            </SelectContent>
                          </Select>
                        </div>
                      </div>
                      <p className="text-xs text-muted-foreground">
                        {RULE_TYPE_HELP[newRuleType]}
                      </p>
                      {newRuleNeedsValue && newRuleDim && (
                        <div className="space-y-1">
                          <Label className="text-xs text-muted-foreground">Värde</Label>
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
                          Avbryt
                        </Button>
                        <Button
                          size="sm"
                          disabled={
                            isAddingRule ||
                            !newRuleDim ||
                            (newRuleNeedsValue && !newRuleValueCode)
                          }
                          onClick={handleAddRule}
                        >
                          {isAddingRule && (
                            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                          )}
                          Lägg till
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
                        Lägg till regel
                      </Button>
                    )
                  )}
                </>
              )}
            </div>
          )}

          <div className="flex items-center justify-between rounded-lg border p-3">
            <div>
              <p className="text-sm font-medium">Aktivt konto</p>
              <p className="text-xs text-muted-foreground">
                Inaktiva konton visas inte i bokföringsformulär
              </p>
            </div>
            <Switch checked={isActive} onCheckedChange={setIsActive} />
          </div>

          {account.is_system_account && (
            <p className="text-xs text-muted-foreground bg-muted rounded p-2">
              Detta är ett systemkonto och kan inte tas bort.
            </p>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Avbryt
          </Button>
          <Button onClick={handleSave} disabled={isSaving || !accountName.trim()}>
            {isSaving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Spara
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
