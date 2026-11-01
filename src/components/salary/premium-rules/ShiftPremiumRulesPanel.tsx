'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { SettingsGroup } from '@/components/settings/SettingsRows'
import { AttnLine } from '@/components/ui/attn-line'
import { DestructiveConfirmDialog, useDestructiveConfirm } from '@/components/ui/destructive-confirm-dialog'
import { useToast } from '@/components/ui/use-toast'
import { useCompany } from '@/contexts/CompanyContext'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import { useEmployees } from '@/lib/reference-data/hooks'
import {
  draftFromRule,
  emptyPremiumRuleDraft,
  premiumRuleRequestBody,
  type PremiumRuleDraft,
} from '@/lib/salary/premium-rule-draft'
import type { ShiftPremiumRule } from '@/types'
import { ShiftPremiumRuleDialog, type PremiumRuleEmployeeOption } from './ShiftPremiumRuleDialog'
import { ShiftPremiumRulesList } from './ShiftPremiumRulesList'
import { todayIsoStockholm } from '@/lib/dates/iso'

/** The rules, switched-off ones included; null when the read failed. */
async function loadRules(): Promise<ShiftPremiumRule[] | null> {
  const res = await fetch('/api/salary/premium-rules?include_inactive=true')
  return res.ok ? ((await res.json()).data ?? []) : null
}

/**
 * OB and overtime rules as a group of the Löner settings section (Fönster,
 * convention 15). Outside the settings form, so its own load and save never
 * touch the dirty-form save bar; how the rules work lives behind the group's
 * "?". The server refuses writes from viewers; the panel mirrors that and
 * shows them the list without its actions.
 */
export function ShiftPremiumRulesPanel() {
  const t = useTranslations('premium_rules')
  const locale = useLocale() === 'en' ? 'en' : 'sv'
  const { toast } = useToast()
  const { role } = useCompany()
  const canWrite = role !== null && role !== 'viewer'
  const { dialogProps, confirm } = useDestructiveConfirm()

  const [today] = useState(todayIsoStockholm)
  const [rules, setRules] = useState<ShiftPremiumRule[]>([])
  const { employees: roster } = useEmployees()
  const employees = useMemo<PremiumRuleEmployeeOption[]>(
    () => roster.map((e) => ({ id: e.id, name: `${e.first_name} ${e.last_name}` })),
    [roster],
  )
  const [loading, setLoading] = useState(true)
  const [loadFailed, setLoadFailed] = useState(false)
  const [editing, setEditing] = useState<{ id: string | null; draft: PremiumRuleDraft } | null>(null)
  const [saving, setSaving] = useState(false)
  const [serverError, setServerError] = useState<string | null>(null)

  const applyLoaded = useCallback((loaded: ShiftPremiumRule[] | null) => {
    if (loaded) setRules(loaded)
    setLoadFailed(loaded === null)
    setLoading(false)
  }, [])

  // The state lands in the .then callback, never synchronously in the
  // effect, and a response after unmount is dropped.
  useEffect(() => {
    let cancelled = false
    loadRules().then((loaded) => {
      if (!cancelled) applyLoaded(loaded)
    })
    return () => {
      cancelled = true
    }
  }, [applyLoaded])

  async function reload() {
    applyLoaded(await loadRules())
  }

  async function failureText(res: Response): Promise<string> {
    const body = await res.json().catch(() => ({}))
    return getErrorMessage(body, { statusCode: res.status, locale })
  }

  async function handleSave() {
    if (!editing) return
    setSaving(true)
    setServerError(null)
    const res = await fetch(editing.id ? `/api/salary/premium-rules/${editing.id}` : '/api/salary/premium-rules', {
      method: editing.id ? 'PATCH' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(premiumRuleRequestBody(editing.draft)),
    })
    if (res.ok) {
      setEditing(null)
      await reload()
    } else {
      setServerError(await failureText(res))
    }
    setSaving(false)
  }

  async function handleToggleActive(rule: ShiftPremiumRule) {
    const res = await fetch(`/api/salary/premium-rules/${rule.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ is_active: !rule.is_active }),
    })
    if (!res.ok) toast({ title: await failureText(res), variant: 'destructive' })
    await reload()
  }

  async function handleDelete(rule: ShiftPremiumRule) {
    await confirm(
      {
        title: t('delete_title'),
        description: t('delete_description', { name: rule.name }),
        confirmLabel: t('delete'),
      },
      async () => {
        const res = await fetch(`/api/salary/premium-rules/${rule.id}`, { method: 'DELETE' })
        if (!res.ok) {
          toast({ title: await failureText(res), variant: 'destructive' })
        } else {
          const body = (await res.json().catch(() => ({}))) as { data?: { deactivated?: boolean } }
          if (body.data?.deactivated) toast({ title: t('deactivated_instead') })
        }
        await reload()
      },
    )
  }

  return (
    <SettingsGroup label={t('heading')} help={t('help')}>
      {loadFailed ? (
        <div className="py-3">
          <AttnLine action={{ label: t('retry'), onClick: () => void reload() }}>{t('load_failed')}</AttnLine>
        </div>
      ) : null}
      <ShiftPremiumRulesList
        rules={rules}
        loading={loading}
        canWrite={canWrite && !loadFailed}
        today={today}
        onNew={() => {
          setServerError(null)
          setEditing({ id: null, draft: emptyPremiumRuleDraft(today) })
        }}
        onEdit={(rule) => {
          setServerError(null)
          setEditing({ id: rule.id, draft: draftFromRule(rule) })
        }}
        onToggleActive={(rule) => void handleToggleActive(rule)}
        onDelete={(rule) => void handleDelete(rule)}
      />
      <ShiftPremiumRuleDialog
        open={editing !== null}
        editing={Boolean(editing?.id)}
        draft={editing?.draft ?? emptyPremiumRuleDraft(today)}
        onDraftChange={(draft) => setEditing((current) => (current ? { ...current, draft } : current))}
        employees={employees}
        today={today}
        saving={saving}
        serverError={serverError}
        onSave={() => void handleSave()}
        onClose={() => {
          setEditing(null)
          setServerError(null)
        }}
      />
      <DestructiveConfirmDialog {...dialogProps} />
    </SettingsGroup>
  )
}
