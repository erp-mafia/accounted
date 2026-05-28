'use client'

import { useEffect, useState } from 'react'
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
import { Loader2, AlertTriangle } from 'lucide-react'
import { isStandardBASAccount } from '@/lib/bookkeeping/bas-reference'
import type { BASAccount } from '@/types'

interface AddAccountDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreated: (account: BASAccount) => void
  initialAccountNumber?: string
  initialAccountName?: string
}

function deriveAccountType(accountNumber: string): { type: string; balance: string } {
  const cls = parseInt(accountNumber[0])
  switch (cls) {
    case 1: return { type: 'asset', balance: 'debit' }
    case 2: {
      const group = parseInt(accountNumber.substring(0, 2))
      if (group <= 20) return { type: 'equity', balance: 'credit' }
      return { type: 'liability', balance: 'credit' }
    }
    case 3: return { type: 'revenue', balance: 'credit' }
    case 4: case 5: case 6: case 7: return { type: 'expense', balance: 'debit' }
    case 8: {
      const group = parseInt(accountNumber.substring(0, 2))
      if (group >= 83 && group <= 83) return { type: 'revenue', balance: 'credit' }
      if (group >= 84 && group <= 84) return { type: 'expense', balance: 'debit' }
      return { type: 'expense', balance: 'debit' }
    }
    default: return { type: 'expense', balance: 'debit' }
  }
}

export function AddAccountDialog({
  open,
  onOpenChange,
  onCreated,
  initialAccountNumber,
  initialAccountName,
}: AddAccountDialogProps) {
  const [accountNumber, setAccountNumber] = useState('')
  const [accountName, setAccountName] = useState('')
  const [description, setDescription] = useState('')
  const [defaultVatCode, setDefaultVatCode] = useState('')
  const [sruCode, setSruCode] = useState('')
  const [normalBalance, setNormalBalance] = useState<'debit' | 'credit'>('debit')
  const [isSaving, setIsSaving] = useState(false)
  const [error, setError] = useState('')

  // Apply prefill values whenever the dialog opens. Resetting on close happens
  // implicitly after a successful create; here we only need to seed inputs so
  // the user doesn't retype what the combobox already captured.
  useEffect(() => {
    if (!open) return
    const num = (initialAccountNumber ?? '').replace(/\D/g, '').slice(0, 4)
    setAccountNumber(num)
    setAccountName(initialAccountName ?? '')
    setError('')
    if (num.length === 4) {
      setNormalBalance(deriveAccountType(num).balance as 'debit' | 'credit')
    }
  }, [open, initialAccountNumber, initialAccountName])

  const isBASMatch = accountNumber.length === 4 && isStandardBASAccount(accountNumber)
  const derived = accountNumber.length === 4 ? deriveAccountType(accountNumber) : null

  async function handleCreate() {
    setError('')

    if (!/^\d{4}$/.test(accountNumber)) {
      setError('Kontonumret måste vara exakt 4 siffror')
      return
    }

    if (!accountName.trim()) {
      setError('Kontonamn krävs')
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
          account_type: derived?.type || 'expense',
          normal_balance: normalBalance,
          description: description || null,
          default_vat_code: defaultVatCode || null,
          sru_code: sruCode || null,
        }),
      })

      if (!response.ok) {
        const data = await response.json()
        throw new Error(data.error || 'Kunde inte skapa kontot')
      }

      const { data: createdAccount } = await response.json() as { data: BASAccount }

      // Reset form
      setAccountNumber('')
      setAccountName('')
      setDescription('')
      setDefaultVatCode('')
      setSruCode('')
      onCreated(createdAccount)
      onOpenChange(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Något gick fel')
    } finally {
      setIsSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Lägg till eget konto</DialogTitle>
          <DialogDescription>
            Skapa ett eget konto utanför BAS-standarden
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          {isBASMatch && (
            <div className="flex items-start gap-2 rounded-lg bg-warning/10 border border-warning/30 p-3">
              <AlertTriangle className="h-4 w-4 text-warning-foreground mt-0.5 shrink-0" />
              <p className="text-sm text-warning-foreground">
                Kontonummer {accountNumber} finns i BAS-standarden. Använd &quot;BAS-katalog&quot;-fliken för att aktivera standardkonton istället.
              </p>
            </div>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>Kontonummer</Label>
              <Input
                value={accountNumber}
                onChange={(e) => {
                  const v = e.target.value.replace(/\D/g, '').slice(0, 4)
                  setAccountNumber(v)
                  if (v.length === 4) {
                    const d = deriveAccountType(v)
                    setNormalBalance(d.balance as 'debit' | 'credit')
                  }
                }}
                placeholder="T.ex. 1935"
                maxLength={4}
                className="font-mono"
              />
            </div>
            <div className="space-y-2">
              <Label>Normal saldo</Label>
              <Select value={normalBalance} onValueChange={(v) => { if (v) setNormalBalance(v as 'debit' | 'credit') }}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="debit">Debet</SelectItem>
                  <SelectItem value="credit">Kredit</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          {derived && (
            <p className="text-xs text-muted-foreground">
              Auto-detekterad typ:{' '}
              <span className="font-medium">
                {derived.type === 'asset' ? 'Tillgång' : derived.type === 'liability' ? 'Skuld' : derived.type === 'equity' ? 'Eget kapital' : derived.type === 'revenue' ? 'Intäkt' : 'Kostnad'}
              </span>
            </p>
          )}

          <div className="space-y-2">
            <Label>Kontonamn</Label>
            <Input
              value={accountName}
              onChange={(e) => setAccountName(e.target.value)}
              placeholder="T.ex. Sparkonto företag"
            />
          </div>

          <div className="space-y-2">
            <Label>Beskrivning <span className="text-muted-foreground">(valfritt)</span></Label>
            <Textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Kort beskrivning av kontots användning"
              rows={2}
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>Momskod <span className="text-muted-foreground">(valfritt)</span></Label>
              <Input
                value={defaultVatCode}
                onChange={(e) => setDefaultVatCode(e.target.value)}
                placeholder="T.ex. MP1"
              />
            </div>
            <div className="space-y-2">
              <Label>SRU-kod <span className="text-muted-foreground">(valfritt)</span></Label>
              <Input
                value={sruCode}
                onChange={(e) => setSruCode(e.target.value)}
                placeholder="T.ex. 7201"
              />
            </div>
          </div>

          {error && (
            <p className="text-sm text-destructive">{error}</p>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Avbryt
          </Button>
          <Button onClick={handleCreate} disabled={isSaving || accountNumber.length !== 4 || !accountName.trim()}>
            {isSaving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Skapa konto
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
