'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { useToast } from '@/components/ui/use-toast'
import {
  SettingsRow,
  SettingsRowNote,
  SettingsSelect,
} from '@/components/settings/SettingsRows'
import type { AccountingFramework } from '@/types'

interface AccountingFrameworkFormProps {
  /** Current framework on the company row. */
  current: AccountingFramework
  /** Bubble up after a successful save so parent state can refresh. */
  onSaved?: (next: AccountingFramework) => void
}

/**
 * K2/K3 selector row for AB. Lives in the Grunder group on the bookkeeping
 * settings page. Renders nothing for non-AB entities: the parent gates this
 * component by entity_type.
 *
 * UX rules (regulatory area):
 *   - Default is K2 (matches the column default and BFNAR 2016:10 baseline).
 *   - Switching in either direction fires a confirmation dialog. K2 → K3
 *     names what the system then does (K3-mallen for the årsredovisning,
 *     komponentuppdelning in the asset register) and the one obligation the
 *     choice itself carries: komponentavskrivning is mandatory under K3 where
 *     component useful lives differ materially (punkt 17.4,
 *     .claude/skills/swedish-year-end-closing/references/k2-vs-k3.md:5).
 *     Kassaflödesanalys is NOT a consequence of K3: it follows from being a
 *     större företag (references/reporting-and-filing.md:10), so the copy
 *     says the product includes one, it does not blame the regelverk.
 *     The recommendation per BFN is that the choice is permanent once made,
 *     surfaced as a warning, not a block.
 *     K3 → K2 warns about what the system does NOT do: uppskjuten skatt
 *     (2240/8940) balances and komponentavskrivningar are not unwound
 *     automatically, and the K3 årsredovisning content stops applying.
 *   - The save is its own request (PATCH /api/company/current): separate
 *     from /api/settings because the column lives on companies, not on
 *     company_settings.
 */
export function AccountingFrameworkForm({ current, onSaved }: AccountingFrameworkFormProps) {
  const t = useTranslations('accounting_framework_form')
  const { toast } = useToast()
  const [selected, setSelected] = useState<AccountingFramework>(current)
  const [pending, setPending] = useState<AccountingFramework | null>(null)
  const [saving, setSaving] = useState(false)

  async function persist(next: AccountingFramework) {
    setSaving(true)
    try {
      const res = await fetch('/api/company/current', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accounting_framework: next }),
      })
      const body = await res.json()
      if (!res.ok) {
        toast({
          title: t('save_failed_title'),
          description: body?.error ?? t('try_again'),
          variant: 'destructive',
        })
        setSelected(current)
        return
      }
      toast({
        title: t('saved_title'),
        description:
          next === 'k3'
            ? t('saved_k3')
            : t('saved_k2'),
      })
      onSaved?.(next)
    } catch {
      toast({
        title: t('save_failed_title'),
        description: t('try_again'),
        variant: 'destructive',
      })
      setSelected(current)
    } finally {
      setSaving(false)
      setPending(null)
    }
  }

  function handleChange(next: string) {
    const value = next as AccountingFramework
    if (value === selected) return
    // Both directions are consequential: K2 → K3 adds obligations, K3 → K2
    // leaves K3-only balances behind. Confirm before persisting either way.
    setPending(value)
  }

  return (
    <>
      <SettingsRow
        label={t('label')}
        htmlFor="accounting_framework"
        help={<>{t('help')}</>}
      >
        <SettingsSelect
          id="accounting_framework"
          value={selected}
          onChange={(e) => handleChange(e.target.value)}
          // Saves via its own PATCH; the row sits inside the page's
          // SettingsFormWrapper form, so keep the wrapper's dirty tracking
          // (onInput on the form) from reacting to this select. No `name`
          // either, so the wrapper's FormData never picks it up.
          onInput={(e) => e.stopPropagation()}
          disabled={saving}
        >
          <option value="k2">{t('option_k2')}</option>
          <option value="k3">{t('option_k3')}</option>
        </SettingsSelect>
        {saving && <SettingsRowNote>{t('saving')}</SettingsRowNote>}
      </SettingsRow>

      <Dialog
        open={pending !== null}
        onOpenChange={(open) => {
          if (!open) setPending(null)
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{pending === 'k2' ? t('confirm_title_k2') : t('confirm_title_k3')}</DialogTitle>
            <DialogDescription className="space-y-2 pt-2">
              {pending === 'k2' ? (
                <>
                  <span className="block">{t('to_k2_body_1')}</span>
                  <span className="block">{t('to_k2_body_2')}</span>
                </>
              ) : (
                <>
                  <span className="block">{t('to_k3_body_1')}</span>
                  <span className="block">{t('to_k3_body_2')}</span>
                  <span className="block">{t('to_k3_body_3')}</span>
                </>
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setPending(null)}
              disabled={saving}
            >
              {t('cancel')}
            </Button>
            <Button
              onClick={() => {
                if (!pending) return
                setSelected(pending)
                void persist(pending)
              }}
              loading={saving}
            >
              {saving ? (
                t('saving')
              ) : pending === 'k2' ? (
                t('confirm_cta_k2')
              ) : (
                t('confirm_cta_k3')
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
