'use client'

import type { WorkspaceComponentProps } from '@/lib/extensions/workspace-registry'
import { Button } from '@/components/ui/button'
import { BuildingLibraryIcon, Cog6ToothIcon } from '@/components/icons'
import Link from 'next/link'

export default function EnableBankingWorkspace({ userId }: WorkspaceComponentProps) {
  return (
    <div className="flex flex-col items-center justify-center py-16 text-center">
      <BuildingLibraryIcon className="h-12 w-12 text-muted-foreground/40 mb-4" />
      <h3 className="text-lg text-foreground">Bankintegration (PSD2)</h3>
      <p className="text-sm text-muted-foreground mt-1 max-w-md">
        Koppla ditt bankkonto under Inställningar för att synka transaktioner automatiskt.
      </p>
      <Button asChild variant="outline" className="mt-4">
        <Link href="/settings/banking">
          <Cog6ToothIcon className="mr-2 h-4 w-4" />
          Gå till bankinställningar
        </Link>
      </Button>
    </div>
  )
}
