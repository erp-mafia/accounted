'use client'

import { ApiKeysPanel } from '@/components/settings/ApiKeysPanel'
import { OAuthClientsPanel } from '@/components/settings/OAuthClientsPanel'

export default function ApiSettingsPage() {
  return (
    <div className="space-y-8">
      <ApiKeysPanel />
      <OAuthClientsPanel />
    </div>
  )
}
