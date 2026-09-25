'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { ChevronDown } from 'lucide-react'
import { ApiKeysPanel } from '@/components/settings/ApiKeysPanel'
import { McpConnectionsPanel } from '@/components/settings/McpConnectionsPanel'
import { OAuthClientsPanel } from '@/components/settings/OAuthClientsPanel'
import { SettingsGroup, SettingsReveal, SettingsSectionHeader } from '@/components/settings/SettingsRows'
import { useApiKeys } from '@/components/settings/useApiKeys'
import { cn } from '@/lib/utils'

/**
 * Settings → API & MCP. What is connected comes first (or, with nothing
 * connected, how to connect Claude); the developer tools (API keys, OAuth
 * redirect registrations) sit at the bottom, because most people never need
 * them.
 */
export function ApiSettingsContent() {
  const tNav = useTranslations('settings_nav')
  const tIntro = useTranslations('settings_intro')
  const t = useTranslations('settings_api_keys')
  const { keys, isLoading, refetch, revoke } = useApiKeys()
  const [showOAuthClients, setShowOAuthClients] = useState(false)

  return (
    <div>
      <SettingsSectionHeader title={tNav('api')} intro={tIntro('api')} />
      <McpConnectionsPanel keys={keys} isLoading={isLoading} onRevoke={revoke} />

      <SettingsGroup label={t('developer_title')}>
        <ApiKeysPanel keyCount={keys.length} onCreated={refetch} />
        <button
          type="button"
          aria-expanded={showOAuthClients}
          onClick={() => setShowOAuthClients(!showOAuthClients)}
          className="flex w-full items-center gap-2 border-b border-border px-1 py-3 text-left text-xs text-muted-foreground transition-colors duration-150 hover:text-foreground"
        >
          <ChevronDown
            className={cn('h-3.5 w-3.5 transition-transform duration-150', !showOAuthClients && '-rotate-90')}
          />
          {t('oauth_clients_toggle')}
        </button>
        <SettingsReveal open={showOAuthClients} indent={false}>
          <OAuthClientsPanel className="pt-4 first:pt-4" />
        </SettingsReveal>
      </SettingsGroup>
    </div>
  )
}
