'use client'

import { useState } from 'react'
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
import { Loader2 } from 'lucide-react'

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
 * UX rules (regulatory area: kept in Swedish):
 *   - Default is K2 (matches the column default and BFNAR 2016:10 baseline).
 *   - Switching K2 → K3 fires a confirmation dialog. The recommendation per
 *     BFN is that the choice is permanent for the company once made; we
 *     surface that as a warning, not a block, so the user can still revert.
 *   - The save is its own request (PATCH /api/company/current): separate
 *     from /api/settings because the column lives on companies, not on
 *     company_settings.
 */
export function AccountingFrameworkForm({ current, onSaved }: AccountingFrameworkFormProps) {
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
          title: 'Kunde inte spara',
          description: body?.error ?? 'Försök igen.',
          variant: 'destructive',
        })
        setSelected(current)
        return
      }
      toast({
        title: 'Sparat',
        description:
          next === 'k3'
            ? 'Bolaget redovisar nu enligt K3 (BFNAR 2012:1).'
            : 'Bolaget redovisar nu enligt K2 (BFNAR 2016:10).',
      })
      onSaved?.(next)
    } catch {
      toast({
        title: 'Kunde inte spara',
        description: 'Försök igen.',
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
    // K2 → K3 is the consequential direction: confirm before persisting.
    if (selected === 'k2' && value === 'k3') {
      setPending(value)
      return
    }
    setSelected(value)
    void persist(value)
  }

  return (
    <>
      <SettingsRow
        label="Regelverk"
        htmlFor="accounting_framework"
        help={
          <>
            K2 är standard för mindre bolag och innebär förenklade regler. K3 krävs när
            bolaget når två av tre tröskelvärden (nettoomsättning &gt; 80 MSEK, tillgångar
            &gt; 40 MSEK, eller fler än 50 anställda). K3 ställer högre krav: kassaflödesanalys,
            komponentavskrivning på materiella anläggningstillgångar och redovisning av
            uppskjuten skatt på obeskattade reserver (79,4 % eget kapital / 20,6 % skuld).
          </>
        }
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
          <option value="k2">K2 (BFNAR 2016:10): mindre företag</option>
          <option value="k3">K3 (BFNAR 2012:1): större företag</option>
        </SettingsSelect>
        {saving && <SettingsRowNote>Sparar…</SettingsRowNote>}
      </SettingsRow>

      <Dialog
        open={pending !== null}
        onOpenChange={(open) => {
          if (!open) setPending(null)
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Byta till K3?</DialogTitle>
            <DialogDescription className="space-y-2 pt-2">
              <span className="block">
                K3 medför löpande att kassaflödesanalys upprättas, komponentavskrivning
                används och uppskjuten skatt redovisas separat (konto 2240 / 8940).
              </span>
              <span className="block">
                Bytet är permanent enligt rekommendation. Fortsätt?
              </span>
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setPending(null)}
              disabled={saving}
            >
              Avbryt
            </Button>
            <Button
              onClick={() => {
                if (!pending) return
                setSelected(pending)
                void persist(pending)
              }}
              disabled={saving}
            >
              {saving ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Sparar…
                </>
              ) : (
                'Byt till K3'
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
