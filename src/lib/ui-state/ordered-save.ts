/**
 * Saves of a preference that is stored whole (a list that IS the
 * preference), for a caller that shows each change at once and stores it
 * after.
 *
 * Every save carries the whole value, so two in flight could land in either
 * order and leave the older one stored. The saves made here go out one at a
 * time, in the order they were made, and a value replaced while it waited is
 * never sent: the newer one holds its change too.
 *
 * A refused save is reported once the newest value has been refused: while a
 * newer one waits to be sent there is nothing to put back yet. The report
 * names the last value the server took, so the caller can show that again.
 */

export interface RefusedSave<T> {
  /** The last value the server took through this queue; undefined when it took none. */
  lastSaved: T | undefined
  /** The server's answer, when it answered. */
  response?: Response
  /** What the request threw, when it never got an answer. */
  error?: unknown
}

export type OrderedSave<T> = (value: T, onRefused: (refused: RefusedSave<T>) => void) => Promise<void>

export function createOrderedSave<T>(send: (value: T) => Promise<Response>): OrderedSave<T> {
  let newest = 0
  let lastSaved: T | undefined
  let queue: Promise<void> = Promise.resolve()

  return (value, onRefused) => {
    const turn = ++newest
    const step = async () => {
      // Replaced while it waited: the newer value is sent in its place.
      if (turn !== newest) return
      let refused: Pick<RefusedSave<T>, 'response' | 'error'>
      try {
        const response = await send(value)
        if (response.ok) {
          lastSaved = value
          return
        }
        refused = { response }
      } catch (error) {
        refused = { error }
      }
      // A newer value was made while this one was out: it is sent next.
      if (turn !== newest) return
      onRefused({ lastSaved, ...refused })
    }
    // Also after a step that threw (a caller's onRefused): the next save still goes out.
    queue = queue.then(step, step)
    return queue
  }
}
