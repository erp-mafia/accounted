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
import { classifyAccount } from '@/lib/bookkeeping/account-classifier'
import type { BASAccount } from '@/types'

interface AddAccountDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreated: (account: BASAccount) => void
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
  const [accountNumber, setAccountNumber] = useState('')
  const [accountName, setAccountName] = useState('')
  const [description, setDescription] = useState('')
  // "Standard moms": the moms-sats a booking line defaults to when this konto is
  // picked. 'none' = no default. SelectItem values are stringified decimals.
  const [defaultVatRate, setDefaultVatRate] = useState('none')
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
      setNormalBalance(classifyAccount(num).normal_balance)
    }
  }, [open, initialAccountNumber, initialAccountName])

  const isBASMatch = accountNumber.length === 4 && isStandardBASAccount(accountNumber)
  const derived = accountNumber.length === 4 ? classifyAccount(accountNumber) : null

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
          account_type: derived?.account_type || 'expense',
          normal_balance: normalBalance,
          description: description || null,
          default_vat_rate: defaultVatRate === 'none' ? null : parseFloat(defaultVatRate),
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
      setDefaultVatRate('none')
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
                    setNormalBalance(classifyAccount(v).normal_balance)
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
                {derived.account_type === 'asset' ? 'Tillgång'
                  : derived.account_type === 'liability' ? 'Skuld'
                  : derived.account_type === 'equity' ? 'Eget kapital'
                  : derived.account_type === 'untaxed_reserves' ? 'Obeskattade reserver'
                  : derived.account_type === 'revenue' ? 'Intäkt'
                  : 'Kostnad'}
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
              <Label>Standard moms <span className="text-muted-foreground">(valfritt)</span></Label>
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
