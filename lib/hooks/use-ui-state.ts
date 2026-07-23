'use client'

import useSWR from 'swr'
import { createClient } from '@/lib/supabase/client'
import type { UserUiState } from '@/types'

/**
 * Client-side read of user_preferences.ui_state (nav folds, split-button
 * last-used modes). RLS scopes the select to the caller's own row. Pages
 * use this to seed SplitButton's initial mode; writes go through
 * lib/ui-state/client (POST /api/user/ui-state).
 *
 * Errors (including a not-yet-migrated ui_state column) degrade to an
 * empty state: the UI falls back to its defaults.
 */
export function useUiState() {
  const { data } = useSWR<UserUiState>('user-ui-state', async () => {
    const supabase = createClient()
    const { data: row } = await supabase
      .from('user_preferences')
      .select('ui_state')
      .maybeSingle()
    return (row?.ui_state as UserUiState) ?? {}
  })

  return { uiState: data, loaded: data !== undefined }
}
