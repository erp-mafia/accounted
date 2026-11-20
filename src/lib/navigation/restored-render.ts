/**
 * Tells a fresh server render apart from one the client router restored from
 * its cache.
 *
 * The router shows a dynamic page again from memory on back/forward (however
 * old) and on a link click within staleTimes.dynamic (next.config.ts). For a
 * live view such as Att göra that is a frozen snapshot: approvals made on
 * another page, or by an agent over MCP, are missing until a hard reload.
 *
 * Each server render carries a unique id. The first mount to show an id owns
 * it; a later mount of the same id can only be a cache restore. Mount
 * identity (not a counter) keeps StrictMode's effect re-run on the same
 * instance from counting as a restore. No clocks are compared, so a skewed
 * client clock cannot trigger or suppress the check.
 */

export interface RenderTracker {
  /** True when another mount already showed this render: it came from the router cache. */
  isRestored(renderId: string, mount: object): boolean
}

export function createRenderTracker(): RenderTracker {
  const owners = new Map<string, object>()
  return {
    isRestored(renderId, mount) {
      const owner = owners.get(renderId)
      if (owner === undefined) {
        owners.set(renderId, mount)
        return false
      }
      return owner !== mount
    },
  }
}

/** One per tab: module scope lives exactly as long as the router cache does. */
export const renderTracker = createRenderTracker()
