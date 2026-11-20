import type { TICCompanyDocument } from './tic-types'

/**
 * Whether a Lens document describes a firm that no longer trades. Lens's
 * current state, `activityStatus`, wins; `isCeased` is only the fallback
 * when that state is missing or unknown. The two disagree when a sole
 * trader restarts under a registration struck off years ago: Lens keeps
 * the old isCeased=true next to activityStatus 'isActive' and live F-skatt
 * and moms. (Support case 2026-09-24: a firm struck off in 2009 hid the
 * owner's new one, registered for moms in September 2026.)
 */
export function isLensDocumentCeased(doc: Pick<TICCompanyDocument, 'isCeased' | 'activityStatus'>): boolean {
  if (doc.activityStatus === 'isActive') return false
  if (doc.activityStatus === 'isNoLongerActive') return true
  return doc.isCeased ?? false
}
