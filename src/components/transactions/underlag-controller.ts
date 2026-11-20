import type { UnderlagWrite } from './review-underlag'

/** A write the attach route answered with a refusal, or that never reached it (status 0). */
export type UnderlagRefusal = Extract<UnderlagWrite, { ok: false }>

/** What this dialog did to the row's underlag: pinned a document, or took it off (documentId null). */
export interface UnderlagSession {
  transactionId: string
  documentId: string | null
  fileName: string | null
}

export interface UnderlagControllerState {
  /** Undefined until this dialog pinned or took off a document. */
  session: UnderlagSession | undefined
  /** A pin or a take-off is queued or on its way. */
  busy: boolean
}

export interface UnderlagControllerDeps {
  /**
   * The row, and its underlag as the dialog last read it (the underlag
   * route, else the row's pin as the list loaded it). Read at the moment a
   * write runs, never when it was asked for.
   */
  read: () => { transactionId: string | null; documentId: string | null }
  pin: (transactionId: string, documentId: string) => Promise<UnderlagWrite>
  unpin: (transactionId: string) => Promise<UnderlagWrite>
  onState?: (state: UnderlagControllerState) => void
  onPinned?: (transactionId: string, documentId: string, fileName: string | null) => void
  onUnpinned?: (transactionId: string, documentId: string) => void
  onPinFailed?: (refusal: UnderlagRefusal) => void
  onUnpinFailed?: (refusal: UnderlagRefusal) => void
}

export interface UnderlagController {
  /** The row's own underlag: what this dialog pinned or took off, else what was read. */
  documentId: () => string | null
  /** The row holds this document, or a pin for it is queued or on its way. */
  tracks: (documentId: string) => boolean
  /** The person removed this document in the dialog and has not attached it again. */
  isLetGo: (documentId: string) => boolean
  /**
   * Offer a document attached in the dialog to the row. Pinned when the row
   * has no underlag once its turn comes; true when it became the row's.
   */
  claim: (documentId: string, fileName: string | null) => Promise<boolean>
  /**
   * The person removed a document in the dialog. Off the row once a pin on
   * its way has landed; true when the row no longer holds it, false when it
   * still does (the take-off was refused) or it was attached again meanwhile.
   */
  withdraw: (documentId: string) => Promise<boolean>
  /** Take the row's underlag off, whatever it is: the document taken off, or null. */
  release: () => Promise<string | null>
  /** The row's underlag once nothing is queued or on its way. */
  settled: () => Promise<string | null>
  state: () => UnderlagControllerState
  /**
   * Hand in the latest read and callbacks (the hook does after every
   * render): writes asked for under an older render, such as an upload that
   * finished after the dialog re-rendered, still decide on the latest.
   */
  configure: (next: Partial<UnderlagControllerDeps>) => void
}

/**
 * The transaction's own underlag in a booking dialog (crm#1101), without
 * React so that its orderings are unit-tested. useTransactionUnderlag wraps
 * it for the Bokför review and the manual booking dialog.
 *
 * A row pins one document (transactions.document_id). The first document
 * attached in a dialog is pinned the moment it lands, so closing the dialog
 * keeps it; the dialog holds any further one for the booking to link. Every
 * write waits for the one before it, and decides on the row as it then is:
 *
 *  - a second document attached while a pin is on its way is held, never
 *    pinned over the first (which the attach route logs as a rättelse);
 *  - a document removed while its pin is on its way comes off the row the
 *    moment that pin lands, and one removed before its turn is never pinned:
 *    a document the person took away cannot reach the verifikat through the
 *    row;
 *  - the booking reads the row once nothing is on its way (settled), and
 *    leaves out what the person let go (isLetGo).
 */
export function createUnderlagController(initial: UnderlagControllerDeps): UnderlagController {
  let deps = initial
  let session: UnderlagSession | undefined
  let pending = 0
  let tail: Promise<unknown> = Promise.resolve()
  // Claims not run yet or on their way, per document.
  const claims = new Map<string, number>()
  // Removed in the dialog, and not attached again since.
  const letGo = new Set<string>()

  const state = (): UnderlagControllerState => ({ session, busy: pending > 0 })

  function documentId(): string | null {
    const read = deps.read()
    if (session && session.transactionId === read.transactionId) return session.documentId
    return read.documentId
  }

  function tracks(id: string): boolean {
    return (claims.get(id) ?? 0) > 0 || documentId() === id
  }

  function enqueue<T>(task: () => Promise<T>): Promise<T> {
    pending += 1
    deps.onState?.(state())
    const run = tail.then(async () => {
      try {
        return await task()
      } finally {
        pending -= 1
        deps.onState?.(state())
      }
    })
    tail = run.catch(() => undefined)
    return run
  }

  async function unpin(current: string): Promise<boolean> {
    const { transactionId } = deps.read()
    if (!transactionId) return false
    const write = await deps.unpin(transactionId)
    if (!write.ok) {
      deps.onUnpinFailed?.(write)
      return false
    }
    session = { transactionId, documentId: null, fileName: null }
    deps.onUnpinned?.(transactionId, current)
    return true
  }

  return {
    documentId,
    tracks,
    isLetGo: (id) => letGo.has(id),
    state,
    configure: (next) => {
      deps = { ...deps, ...next }
    },

    claim(id, fileName) {
      letGo.delete(id)
      claims.set(id, (claims.get(id) ?? 0) + 1)
      return enqueue(async () => {
        try {
          if (letGo.has(id)) return false
          const { transactionId } = deps.read()
          if (!transactionId || documentId()) return false
          const write = await deps.pin(transactionId, id)
          if (!write.ok) {
            // Still attached in the dialog: the booking links it.
            deps.onPinFailed?.(write)
            return false
          }
          // The row holds it now, also when the person let it go meanwhile:
          // the withdraw queued behind this takes it off again.
          session = { transactionId, documentId: id, fileName }
          deps.onPinned?.(transactionId, id, fileName)
          return true
        } finally {
          const left = (claims.get(id) ?? 1) - 1
          if (left > 0) claims.set(id, left)
          else claims.delete(id)
        }
      })
    },

    withdraw(id) {
      letGo.add(id)
      // Held only by the dialog: nothing to take off the row.
      if (!tracks(id)) return Promise.resolve(true)
      return enqueue(async () => {
        if (!letGo.has(id)) return false
        if (documentId() !== id) return true
        const off = await unpin(id)
        // Refused: still the row's underlag, so still attached.
        if (!off) letGo.delete(id)
        return off
      })
    },

    release() {
      return enqueue(async () => {
        const current = documentId()
        if (!current) return null
        if (!(await unpin(current))) return null
        letGo.add(current)
        return current
      })
    },

    async settled() {
      // Writes asked for while waiting are waited for too.
      let seen: Promise<unknown>
      do {
        seen = tail
        await seen
      } while (seen !== tail)
      return documentId()
    },
  }
}
