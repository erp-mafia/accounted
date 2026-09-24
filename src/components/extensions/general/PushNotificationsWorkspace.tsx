'use client'

import type { WorkspaceComponentProps } from '@/lib/extensions/workspace-registry'
import EmptyExtensionState from '@/components/extensions/shared/EmptyExtensionState'
import { Bell } from 'lucide-react'
import { useTranslations } from 'next-intl'

export default function PushNotificationsWorkspace({ userId }: WorkspaceComponentProps) {
  const t = useTranslations('push_notifications_workspace')
  return (
    <EmptyExtensionState
      title={t('title')}
      description={t('description')}
      icon={<Bell className="h-12 w-12 text-muted-foreground/40 mb-4" />}
    />
  )
}
