'use client'

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Receipt } from 'lucide-react'

export default function ReceiptsPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-display text-2xl md:text-3xl font-medium tracking-tight">Kvitton</h1>
        <p className="text-muted-foreground">
          Hantera och granska dina kvitton
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Receipt className="h-5 w-5" />
            Kvitton
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            Kvittoscanning är inte tillgängligt just nu.
          </p>
        </CardContent>
      </Card>
    </div>
  )
}
