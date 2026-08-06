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
    // Both directions are consequential: K2 → K3 adds obligations, K3 → K2
    // leaves K3-only balances behind. Confirm before persisting either way.
    setPending(value)
  }

  return (
    <>
      <SettingsRow
        label="Regelverk"
        htmlFor="accounting_framework"
        help={
          <>
            K2 är standard för mindre bolag och innebär förenklade regler. Större företag
            ska tillämpa K3 och upprätta kassaflödesanalys: dit räknas bland annat bolag
            som överskrider mer än ett av tre tröskelvärden (nettoomsättning &gt; 80 MSEK,
            tillgångar &gt; 40 MSEK, fler än 50 anställda) under vart och ett av de två
            senaste räkenskapsåren, och bolag med noterade värdepapper. För räkenskapsår
            som börjar efter 2025-12-31 är K2 dessutom stängt för bolag med utländsk
            filial, kryptotillgångar eller aktierelaterade ersättningar, och för bolag där
            byggnader ger minst 75 % av nettoomsättningen. Med K3
            valt bygger Accounted årsredovisningen enligt K3-mallen: kassaflödesanalys,
            förändring av eget kapital som egen räkning och utökade noter.
            Anläggningsregistret tar emot komponentuppdelning först med K3, som kräver
            komponentavskrivning när komponenterna har väsentligt olika nyttjandeperioder.
            Obeskattade reserver redovisas brutto i juridisk person enligt K3 punkt 29.37.
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
            <DialogTitle>{pending === 'k2' ? 'Byta till K2?' : 'Byta till K3?'}</DialogTitle>
            <DialogDescription className="space-y-2 pt-2">
              {pending === 'k2' ? (
                <>
                  <span className="block">
                    Bokförda saldon för uppskjuten skatt (konto 2240 / 8940) och gjorda
                    komponentavskrivningar återförs inte automatiskt: de måste hanteras
                    manuellt.
                  </span>
                  <span className="block">
                    Årsredovisningens K3-innehåll (kassaflödesanalys, K3-noter och
                    uppskjuten skatt) gäller inte längre. Fortsätt?
                  </span>
                </>
              ) : (
                <>
                  <span className="block">
                    Årsredovisningen byggs då enligt K3-mallen: kassaflödesanalys,
                    förändring av eget kapital som egen räkning och utökade noter.
                    Kassaflödesanalys är i sig ett krav för större företag, inte en följd
                    av regelverksvalet.
                  </span>
                  <span className="block">
                    Komponentavskrivning blir obligatorisk för tillgångar vars komponenter
                    har väsentligt olika nyttjandeperioder (K3 punkt 17.4).
                    Anläggningsregistret tar emot komponentuppdelning först när K3 är valt.
                  </span>
                  <span className="block">
                    Bytet är permanent enligt rekommendation. Fortsätt?
                  </span>
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
              ) : pending === 'k2' ? (
                'Byt till K2'
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
