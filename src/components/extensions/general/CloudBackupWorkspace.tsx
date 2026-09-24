'use client'

import type { WorkspaceComponentProps } from '@/lib/extensions/workspace-registry'
import { Button } from '@/components/ui/button'
import { Cloud, Settings } from 'lucide-react'
import Link from 'next/link'
import { useTranslations } from 'next-intl'

export default function CloudBackupWorkspace(_props: WorkspaceComponentProps) {
  const t = useTranslations('cloud_backup_workspace')
  return (
    <div className="flex flex-col items-center justify-center py-16 text-center">
      <Cloud className="h-12 w-12 text-muted-foreground/40 mb-4" />
      <h3 className="text-lg text-foreground">{t('title')}</h3>
      <p className="text-sm text-muted-foreground mt-1 max-w-md">
        {t('description')}
      </p>
      <Button asChild variant="outline" className="mt-4">
        <Link href="/import#cloud-backup">
          <Settings className="mr-2 h-4 w-4" />
          {t('go_to_backup')}
        </Link>
      </Button>
    </div>
  )
}
