import type { ViewMode } from '@/components/transactions/transaction-types'

// The view Transaktioner opens on, remembered per company like the source
// filter beside it (source-filter-storage.ts). 201 of 869 visitors picked
// "Alla" again on every visit while the page always opened on "Att bokföra".
export const VIEW_MODE_STORAGE_PREFIX = 'Accounted:transactions-view:v1:'

// 'review' is never remembered or linked to: its tab only exists while
// migrated rows await confirmation, so opening on it later could land on a
// view that is gone.
export type RememberedViewMode = Exclude<ViewMode, 'review'>

export const DEFAULT_VIEW_MODE: RememberedViewMode = 'inbox'

// Validates a stored or URL-provided value.
export function isRememberedViewMode(value: string | null | undefined): value is RememberedViewMode {
  return value === 'inbox' || value === 'history'
}

export function readStoredViewMode(companyId: string): RememberedViewMode | null {
  try {
    const stored = window.localStorage.getItem(VIEW_MODE_STORAGE_PREFIX + companyId)
    if (isRememberedViewMode(stored)) return stored
  } catch {
    // localStorage may be unavailable. The page opens on its default view.
  }
  return null
}

export function writeStoredViewMode(companyId: string, next: ViewMode): void {
  if (!isRememberedViewMode(next)) return
  try {
    window.localStorage.setItem(VIEW_MODE_STORAGE_PREFIX + companyId, next)
  } catch {
    // localStorage may be unavailable. The in-memory view still works.
  }
}

// Which view the page opens on. A link that names a view (?view=inbox or
// ?view=history) wins for that visit. A ?highlight= link opens as it always
// has, on the to-book view: the page widens to Alla itself when the row lives
// there, and a remembered Alla must not decide where a linked row is shown.
// Otherwise the person's last choice for this company, else the to-book view.
export function resolveInitialViewMode(input: {
  urlView: string | null | undefined
  hasHighlight: boolean
  stored: string | null | undefined
}): RememberedViewMode {
  if (isRememberedViewMode(input.urlView)) return input.urlView
  if (input.hasHighlight) return DEFAULT_VIEW_MODE
  return isRememberedViewMode(input.stored) ? input.stored : DEFAULT_VIEW_MODE
}
