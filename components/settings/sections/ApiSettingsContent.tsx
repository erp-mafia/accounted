'use client'

import { ApiKeysPanel } from '@/components/settings/ApiKeysPanel'
import { OAuthClientsPanel } from '@/components/settings/OAuthClientsPanel'

export function ApiSettingsContent() {
  return (
    <div className="space-y-8">
      <ApiKeysPanel />
      <OAuthClientsPanel />
    </div>
  )
}
