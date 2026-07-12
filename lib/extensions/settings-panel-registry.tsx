import dynamic from 'next/dynamic'
import type { ComponentType } from 'react'

/**
 * Settings panel registry
 *
 * Maps extension IDs to dynamically imported settings panel components.
 * This allows the core settings page to render extension-provided settings
 * panels without directly importing from extension directories.
 */

const SETTINGS_PANELS: Record<string, ComponentType> = {
  'enable-banking': dynamic(
    () => import('@/extensions/general/enable-banking/components/BankingSettingsPanel')
  ),
  'cloud-backup': dynamic(
    () => import('@/extensions/general/cloud-backup/components/CloudBackupCard')
  ),
  stripe: dynamic(
    () => import('@/extensions/general/stripe/components/StripeSettingsPanel')
  ),
}

/**
 * Get the settings panel component for an extension.
 * Returns null if the extension has no registered settings panel.
 */
export function getSettingsPanel(extensionId: string): ComponentType | null {
  return SETTINGS_PANELS[extensionId] ?? null
}
