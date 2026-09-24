'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Loader2 } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { DestructiveConfirmDialog, useDestructiveConfirm } from '@/components/ui/destructive-confirm-dialog'
import { HelpPopover } from '@/components/ui/help-popover'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { useToast } from '@/components/ui/use-toast'
import { SettingsGroup } from '@/components/settings/SettingsRows'
import { useCompany } from '@/contexts/CompanyContext'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import { roundOre } from '@/lib/money'
import { cn } from '@/lib/utils'
import type { ShiftPremiumItemType, ShiftPremiumRule } from '@/types'

const ITEM_TYPES: ShiftPremiumItemType[] = [
  'ob_weekday_evening',
  'ob_night',
  'ob_weekend',
  'ob_holiday',
  'overtime_50',
  'overtime_100',
]

const WEEKDAYS = [1, 2, 3, 4, 5, 6, 7] as const

interface EmployeeOption {
  id: string
  first_name: string
  last_name: string
}

interface RuleDraft {
  name: string
  item_type: ShiftPremiumItemType
  day_of_week: number[]
  start_time: string
  end_time: string
  premium_percent: string
  priority: string
  applies_to_all_employees: boolean
  applies_to_employee_ids: string[]
  is_active: boolean
}

const EMPTY_DRAFT: RuleDraft = {
  name: '',
  item_type: 'ob_weekday_evening',
  day_of_week: [1, 2, 3, 4, 5],
  start_time: '18:00',
  end_time: '22:00',
  premium_percent: '50',
  priority: '0',
  applies_to_all_employees: true,
  applies_to_employee_ids: [],
  is_active: true,
}

// In-row text action idiom (same as EmployeeBenefitsPanel and the invoice
// detail rows): underlined, quiet, darkening on hover.
const ROW_ACTION_CLASS =
  'text-xs text-muted-foreground underline decoration-border underline-offset-4 transition-colors duration-150 hover:text-foreground hover:decoration-foreground disabled:opacity-50'

function draftFromRule(rule: ShiftPremiumRule): RuleDraft {
  return {
    name: rule.name,
    item_type: rule.item_type,
    day_of_week: [...rule.day_of_week],
    start_time: rule.start_time.slice(0, 5),
    end_time: rule.end_time.slice(0, 5),
    premium_percent: String(rule.premium_percent),
    priority: String(rule.priority),
    applies_to_all_employees: rule.applies_to_all_employees,
    applies_to_employee_ids: [...rule.applies_to_employee_ids],
    is_active: rule.is_active,
  }
}

/**
 * OB / overtime premium rules, as a settings group under Löner. Lives
 * outside the settings form so its own fetch/save cycle never touches the
 * dirty-form save bar. The server 403s viewers; the panel mirrors that
 * client-side so a read-only member sees the list without the actions.
 */
export function ShiftPremiumRulesPanel() {
  const t = useTranslations('settings_salary')
  const { toast } = useToast()
  const { role } = useCompany()
  const canWrite = role !== null && role !== 'viewer'

  const [rules, setRules] = useState<ShiftPremiumRule[]>([])
  const [employees, setEmployees] = useState<EmployeeOption[]>([])
  const [loading, setLoading] = useState(true)
  const [editing, setEditing] = useState<{ id: string | null; draft: RuleDraft } | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [fieldError, setFieldError] = useState<string | null>(null)
  const { dialogProps, confirm } = useDestructiveConfirm()

  // The effect never calls setState synchronously: the fetch is a pure
  // loader and the state lands in a .then callback (React "ignore" pattern),
  // which also drops a response that arrives after unmount.
  const fetchAll = useCallback(async () => {
    const [rulesRes, employeesRes] = await Promise.all([
      fetch('/api/salary/premium-rules?include_inactive=true'),
      fetch('/api/salary/employees'),
    ])
    const rulesData: ShiftPremiumRule[] | null = rulesRes.ok ? ((await rulesRes.json()).data ?? []) : null
    const employeesData: EmployeeOption[] = employeesRes.ok
      ? (((await employeesRes.json()).data ?? []) as EmployeeOption[]).map((e) => ({
          id: e.id,
          first_name: e.first_name,
          last_name: e.last_name,
        }))
      : []
    return { rules: rulesData, employees: employeesData }
  }, [])

  const applyLoaded = useCallback(
    (loaded: { rules: ShiftPremiumRule[] | null; employees: EmployeeOption[] }) => {
      if (loaded.rules) setRules(loaded.rules)
      else toast({ title: t('premium_rules_load_failed'), variant: 'destructive' })
      setEmployees(loaded.employees)
      setLoading(false)
    },
    [t, toast],
  )

  useEffect(() => {
    let cancelled = false
    fetchAll().then((loaded) => {
      if (!cancelled) applyLoaded(loaded)
    })
    return () => {
      cancelled = true
    }
  }, [fetchAll, applyLoaded])

  async function reload() {
    setLoading(true)
    applyLoaded(await fetchAll())
  }

  const employeeName = useMemo(() => {
    const map = new Map<string, string>()
    for (const e of employees) map.set(e.id, `${e.first_name} ${e.last_name}`)
    return map
  }, [employees])

  function openCreate() {
    setFieldError(null)
    setEditing({ id: null, draft: { ...EMPTY_DRAFT, day_of_week: [...EMPTY_DRAFT.day_of_week] } })
  }

  function openEdit(rule: ShiftPremiumRule) {
    setFieldError(null)
    setEditing({ id: rule.id, draft: draftFromRule(rule) })
  }

  function closeDialog() {
    if (submitting) return
    setEditing(null)
    setFieldError(null)
  }

  function patchDraft(patch: Partial<RuleDraft>) {
    setEditing((cur) => (cur ? { ...cur, draft: { ...cur.draft, ...patch } } : cur))
  }

  function validate(draft: RuleDraft): string | null {
    if (!draft.name.trim()) return t('premium_rules_validation_name')
    if (draft.day_of_week.length === 0) return t('premium_rules_validation_days')
    const pct = Number(draft.premium_percent.replace(',', '.'))
    if (!Number.isFinite(pct) || pct < 0 || pct > 500) return t('premium_rules_validation_percent')
    if (!draft.applies_to_all_employees && draft.applies_to_employee_ids.length === 0) {
      return t('premium_rules_validation_employees')
    }
    return null
  }

  async function handleSave() {
    if (!editing) return
    const { id, draft } = editing
    const problem = validate(draft)
    if (problem) {
      setFieldError(problem)
      return
    }
    setSubmitting(true)
    const priority = parseInt(draft.priority, 10)
    const body = {
      name: draft.name.trim(),
      item_type: draft.item_type,
      day_of_week: [...draft.day_of_week].sort((a, b) => a - b),
      start_time: draft.start_time,
      end_time: draft.end_time,
      premium_percent: roundOre(Number(draft.premium_percent.replace(',', '.'))),
      priority: Number.isFinite(priority) ? priority : 0,
      applies_to_all_employees: draft.applies_to_all_employees,
      applies_to_employee_ids: draft.applies_to_all_employees ? [] : draft.applies_to_employee_ids,
      is_active: draft.is_active,
    }
    const res = await fetch(id ? `/api/salary/premium-rules/${id}` : '/api/salary/premium-rules', {
      method: id ? 'PATCH' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (res.ok) {
      toast({ title: t('premium_rules_saved') })
      setSubmitting(false)
      setEditing(null)
      await reload()
    } else {
      const result = await res.json().catch(() => ({}))
      toast({
        title: t('premium_rules_save_failed'),
        description: getErrorMessage(result, { statusCode: res.status }),
        variant: 'destructive',
      })
      setSubmitting(false)
    }
  }

  async function handleDelete(rule: ShiftPremiumRule) {
    await confirm(
      {
        title: t('premium_rules_delete_title'),
        description: t('premium_rules_delete_description', { name: rule.name }),
      },
      async () => {
        const res = await fetch(`/api/salary/premium-rules/${rule.id}`, { method: 'DELETE' })
        if (res.ok) {
          toast({ title: t('premium_rules_deleted') })
          await reload()
        } else {
          toast({ title: t('premium_rules_delete_failed'), variant: 'destructive' })
        }
      },
    )
  }

  function dayLabels(days: number[]): string {
    return [...days]
      .sort((a, b) => a - b)
      .map((d) => t(`premium_rules_wd_${d}`))
      .join(' ')
  }

  const draft = editing?.draft
  const wraps = draft ? draft.end_time <= draft.start_time : false

  return (
    <SettingsGroup label={t('premium_rules_heading')} help={t('premium_rules_help')}>
      <p className="px-1 pb-3 text-xs leading-relaxed text-muted-foreground">{t('premium_rules_note')}</p>

      {loading ? (
        <div className="space-y-3 px-1 py-3">
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-2/3" />
        </div>
      ) : rules.length === 0 ? (
        <p className="border-b border-border px-1 py-3 text-sm text-muted-foreground">
          {t('premium_rules_empty')}
        </p>
      ) : (
        <ul className="text-sm">
          {rules.map((rule) => (
            <li
              key={rule.id}
              className="flex min-h-10 flex-wrap items-center gap-x-3 gap-y-1 border-b border-border px-1 py-2"
            >
              <span className="min-w-0 truncate" data-ph-mask="">
                {rule.name}
              </span>
              {!rule.is_active && <Badge variant="outline">{t('premium_rules_inactive')}</Badge>}
              <span className="text-xs text-muted-foreground">{t(`premium_rules_type_${rule.item_type}`)}</span>
              <span className="text-xs tabular-nums text-muted-foreground">{dayLabels(rule.day_of_week)}</span>
              <span className="text-xs tabular-nums text-muted-foreground">
                {rule.start_time.slice(0, 5)}-{rule.end_time.slice(0, 5)}
              </span>
              <span className="text-xs text-muted-foreground">
                {rule.applies_to_all_employees
                  ? t('premium_rules_scope_all')
                  : t('premium_rules_scope_named', { count: rule.applies_to_employee_ids.length })}
              </span>
              <span className="ml-auto tabular-nums">{rule.premium_percent} %</span>
              {canWrite && (
                <>
                  <button type="button" onClick={() => openEdit(rule)} className={ROW_ACTION_CLASS}>
                    {t('premium_rules_edit')}
                  </button>
                  <button type="button" onClick={() => handleDelete(rule)} className={ROW_ACTION_CLASS}>
                    {t('premium_rules_delete')}
                  </button>
                </>
              )}
            </li>
          ))}
        </ul>
      )}

      {canWrite && (
        <div className="px-1 pt-3">
          <Button type="button" size="sm" variant="outline" onClick={openCreate}>
            {t('premium_rules_add')}
          </Button>
        </div>
      )}

      {/* Create/edit dialog (convention 13: centered modal). Escape and
          backdrop equal Avbryt; both are held while a save is in flight. */}
      <Dialog open={editing !== null} onOpenChange={(open) => { if (!open) closeDialog() }}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{editing?.id ? t('premium_rules_edit') : t('premium_rules_add')}</DialogTitle>
            <DialogDescription>{t('premium_rules_note')}</DialogDescription>
          </DialogHeader>

          {draft && (
            <div className="space-y-4">
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="premium_rule_name">{t('premium_rules_field_name')}</Label>
                  <Input
                    id="premium_rule_name"
                    value={draft.name}
                    onChange={(e) => patchDraft({ name: e.target.value })}
                    maxLength={100}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="premium_rule_type">{t('premium_rules_field_type')}</Label>
                  <Select
                    value={draft.item_type}
                    onValueChange={(v) => patchDraft({ item_type: v as ShiftPremiumItemType })}
                  >
                    <SelectTrigger id="premium_rule_type">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {ITEM_TYPES.map((k) => (
                        <SelectItem key={k} value={k}>
                          {t(`premium_rules_type_${k}`)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {draft.item_type === 'ob_holiday' && (
                    <p className="text-xs text-muted-foreground">{t('premium_rules_type_ob_holiday_hint')}</p>
                  )}
                </div>
              </div>

              <div className="space-y-2">
                <Label>{t('premium_rules_field_days')}</Label>
                <div className="flex flex-wrap gap-2" role="group" aria-label={t('premium_rules_field_days')}>
                  {WEEKDAYS.map((d) => {
                    const on = draft.day_of_week.includes(d)
                    return (
                      <button
                        key={d}
                        type="button"
                        aria-pressed={on}
                        onClick={() =>
                          patchDraft({
                            day_of_week: on
                              ? draft.day_of_week.filter((x) => x !== d)
                              : [...draft.day_of_week, d],
                          })
                        }
                        className={cn(
                          'h-8 rounded-full border px-3 text-xs transition-colors duration-150',
                          on
                            ? 'border-primary bg-primary text-primary-foreground'
                            : 'border-border bg-transparent text-muted-foreground hover:bg-secondary/60',
                        )}
                      >
                        {t(`premium_rules_wd_${d}`)}
                      </button>
                    )
                  })}
                </div>
              </div>

              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="premium_rule_start">{t('premium_rules_field_start')}</Label>
                  <Input
                    id="premium_rule_start"
                    type="time"
                    step={60}
                    value={draft.start_time}
                    onChange={(e) => patchDraft({ start_time: e.target.value.slice(0, 5) })}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="premium_rule_end">{t('premium_rules_field_end')}</Label>
                  <Input
                    id="premium_rule_end"
                    type="time"
                    step={60}
                    value={draft.end_time}
                    onChange={(e) => patchDraft({ end_time: e.target.value.slice(0, 5) })}
                  />
                  {wraps && <p className="text-xs text-muted-foreground">{t('premium_rules_window_wraps')}</p>}
                </div>
              </div>

              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="premium_rule_percent">{t('premium_rules_field_percent')}</Label>
                  <Input
                    id="premium_rule_percent"
                    type="number"
                    inputMode="decimal"
                    min={0}
                    max={500}
                    step="0.01"
                    value={draft.premium_percent}
                    onChange={(e) => patchDraft({ premium_percent: e.target.value })}
                    className="tabular-nums"
                  />
                </div>
                <div className="space-y-2">
                  <div className="flex items-center gap-2">
                    <Label htmlFor="premium_rule_priority">{t('premium_rules_field_priority')}</Label>
                    <HelpPopover>{t('premium_rules_field_priority_help')}</HelpPopover>
                  </div>
                  <Input
                    id="premium_rule_priority"
                    type="number"
                    inputMode="numeric"
                    step={1}
                    value={draft.priority}
                    onChange={(e) => patchDraft({ priority: e.target.value })}
                    className="tabular-nums"
                  />
                </div>
              </div>

              <div className="space-y-2">
                <Label htmlFor="premium_rule_scope">{t('premium_rules_field_scope')}</Label>
                <Select
                  value={draft.applies_to_all_employees ? 'all' : 'named'}
                  onValueChange={(v) => patchDraft({ applies_to_all_employees: v === 'all' })}
                >
                  <SelectTrigger id="premium_rule_scope">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">{t('premium_rules_scope_all')}</SelectItem>
                    <SelectItem value="named">{t('premium_rules_field_employees')}</SelectItem>
                  </SelectContent>
                </Select>
                {!draft.applies_to_all_employees && (
                  employees.length === 0 ? (
                    <p className="text-xs text-muted-foreground">{t('premium_rules_employees_empty')}</p>
                  ) : (
                    <ul className="max-h-48 space-y-2 overflow-y-auto rounded-lg border border-border p-3">
                      {employees.map((e) => {
                        const checked = draft.applies_to_employee_ids.includes(e.id)
                        const inputId = `premium_rule_emp_${e.id}`
                        return (
                          <li key={e.id} className="flex items-center gap-2">
                            <Checkbox
                              id={inputId}
                              checked={checked}
                              onCheckedChange={(next) =>
                                patchDraft({
                                  applies_to_employee_ids:
                                    next === true
                                      ? [...draft.applies_to_employee_ids, e.id]
                                      : draft.applies_to_employee_ids.filter((x) => x !== e.id),
                                })
                              }
                            />
                            <label htmlFor={inputId} className="cursor-pointer text-sm" data-ph-mask="">
                              {employeeName.get(e.id)}
                            </label>
                          </li>
                        )
                      })}
                    </ul>
                  )
                )}
              </div>

              <div className="flex items-center gap-3">
                <Switch
                  id="premium_rule_active"
                  checked={draft.is_active}
                  onCheckedChange={(next) => patchDraft({ is_active: next })}
                />
                <label htmlFor="premium_rule_active" className="cursor-pointer text-sm">
                  {t('premium_rules_field_active')}
                </label>
              </div>

              {fieldError && <p className="attn text-[12.5px]">{fieldError}</p>}
            </div>
          )}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={closeDialog} disabled={submitting}>
              {t('premium_rules_cancel')}
            </Button>
            <Button type="button" onClick={handleSave} disabled={submitting}>
              {submitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {t('premium_rules_save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <DestructiveConfirmDialog {...dialogProps} />
    </SettingsGroup>
  )
}
