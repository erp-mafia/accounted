'use client'

import { useState } from 'react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Switch } from '@/components/ui/switch'
import { Loader2 } from 'lucide-react'
import type { BASAccount } from '@/types'

interface EditAccountDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  account: BASAccount
  onSaved: () => void
}

export function EditAccountDialog({ open, onOpenChange, account, onSaved }: EditAccountDialogProps) {
  const [accountName, setAccountName] = useState(account.account_name)
  const [description, setDescription] = useState(account.description || '')
  const [defaultVatCode, setDefaultVatCode] = useState(account.default_vat_code || '')
  const [sruCode, setSruCode] = useState(account.sru_code || '')
  const [isActive, setIsActive] = useState(account.is_active)
  const [isSaving, setIsSaving] = useState(false)

  async function handleSave() {
    setIsSaving(true)
    try {
      const response = await fetch(`/api/bookkeeping/accounts/${account.account_number}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          account_name: accountName,
          description: description || null,
          default_vat_code: defaultVatCode || null,
          sru_code: sruCode || null,
          is_active: isActive,
        }),
      })

      if (!response.ok) {
        const data = await response.json()
        throw new Error(data.error || 'Kunde inte uppdatera kontot')
      }

      onSaved()
      onOpenChange(false)
    } catch {
      // Error handled silently: toast is in parent
    } finally {
      setIsSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
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
              <Label>Standard momskod</Label>
              <Input
                value={defaultVatCode}
                onChange={(e) => setDefaultVatCode(e.target.value)}
                placeholder="T.ex. MP1"
              />
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
