'use client'

import { useCompany } from '@/contexts/CompanyContext'

/**
 * Returns whether the current user can perform write actions in the
 * active company. Viewers (role === 'viewer') get `canWrite = false`;
 * owner / admin / member all get `canWrite = true`. Users with no active
 * company (null role) also get `canWrite = false`.
 *
 * Used by every write-action button (create / edit / delete / send /
 * approve / etc.) across the dashboard to render the button in a
 * disabled state with a lock icon and tooltip.
 *
 * This is the UI layer of the viewer role enforcement. The API layer
 * (`requireWritePermission()`) and RLS layer (`current_user_can_write()`)
 * remain the security-critical backstops: this hook only controls what
 * the user sees and can click.
 */
export function useCanWrite(): { canWrite: boolean } {
  const { role } = useCompany()
  return { canWrite: role !== null && role !== 'viewer' }
}
