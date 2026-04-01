'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { AlertTriangle, ExternalLink, Loader2 } from 'lucide-react'
import { SupportLink } from '@/components/ui/support-link'

export function AccountDangerZone() {
  const router = useRouter()
  const [showDialog, setShowDialog] = useState(false)
  const [confirmText, setConfirmText] = useState('')
  const [isDeleting, setIsDeleting] = useState(false)

  async function handleDelete() {
    if (confirmText !== 'RADERA') return
    setIsDeleting(true)

    try {
      const response = await fetch('/api/account/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirm: 'RADERA' }),
      })

      if (!response.ok) {
        const result = await response.json()
        throw new Error(result.error || 'Kunde inte radera kontot')
      }

      router.push('/login')
    } catch {
      setIsDeleting(false)
    }
  }

  return (
    <>
      <section className="space-y-4 border-t border-border/8 pt-8">
        <h2 className="text-sm font-medium uppercase tracking-wider text-destructive/80">
          Radera konto
        </h2>

        <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-4">
          <div className="flex gap-3">
            <AlertTriangle className="h-5 w-5 text-destructive shrink-0 mt-0.5" />
            <div className="space-y-2 text-sm">
              <p className="font-medium text-destructive">Denna åtgärd kan inte ångras</p>
              <p className="text-muted-foreground">
                All din data raderas permanent — bokföring, fakturor, verifikationer, dokument och inställningar.
              </p>
              <p className="text-muted-foreground">
                Enligt bokföringslagen (BFL 7 kap. 2§) ska räkenskapsinformation bevaras i 7 år.
                Du ansvarar själv för att exportera och arkivera din bokföringsdata.
              </p>
              <p className="text-muted-foreground">
                Har du frågor?{' '}
                <SupportLink variant="inline" subject="Fråga om kontoradering" />
              </p>
            </div>
          </div>
        </div>

        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <Button variant="outline" className="w-full sm:w-auto" asChild>
            <Link href="/reports?type=sie">
              <ExternalLink className="mr-2 h-4 w-4" />
              Exportera bokföringsdata (SIE)
            </Link>
          </Button>
          <Button
            variant="destructive"
            className="w-full sm:w-auto"
            onClick={() => setShowDialog(true)}
          >
            Radera mitt konto
          </Button>
        </div>
      </section>

      <Dialog open={showDialog} onOpenChange={(open) => {
        setShowDialog(open)
        if (!open) setConfirmText('')
      }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Radera konto permanent</DialogTitle>
            <DialogDescription>
              All din data raderas permanent. Skriv <strong>RADERA</strong> nedan för att bekräfta.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="delete-confirm">Bekräfta genom att skriva RADERA</Label>
            <Input
              id="delete-confirm"
              value={confirmText}
              onChange={(e) => setConfirmText(e.target.value)}
              placeholder="RADERA"
              autoComplete="off"
            />
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => { setShowDialog(false); setConfirmText('') }}
              disabled={isDeleting}
            >
              Avbryt
            </Button>
            <Button
              variant="destructive"
              onClick={handleDelete}
              disabled={confirmText !== 'RADERA' || isDeleting}
            >
              {isDeleting ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Raderar...
                </>
              ) : (
                'Radera permanent'
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
