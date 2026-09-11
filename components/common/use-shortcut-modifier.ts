'use client'

import { useSyncExternalStore } from 'react'

function isApplePlatform(): boolean {
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } }
  const platform = nav.userAgentData?.platform || nav.platform || ''
  return /mac|iphone|ipad|ipod/i.test(platform)
}

const subscribe = () => () => {}

/**
 * Whether the viewer is on an Apple platform, where shortcuts use ⌘. null on
 * the server and during hydration (the server cannot know the OS), so
 * callers render the ⌘ form until told otherwise and the markup matches on
 * both sides. useSyncExternalStore keeps this out of a setState-in-effect.
 */
export function useIsApplePlatform(): boolean | null {
  return useSyncExternalStore(subscribe, isApplePlatform, () => null)
}

export function commandPaletteShortcutLabel(isApple: boolean | null): string {
  return isApple === false ? 'Ctrl K' : '⌘K'
}

/** The SettingsHotkey chord (⌘, / Ctrl+,), shown as a hint on the settings entry. */
export function settingsShortcutLabel(isApple: boolean | null): string {
  return isApple === false ? 'Ctrl ,' : '⌘,'
}
