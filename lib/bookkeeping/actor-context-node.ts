import { AsyncLocalStorage } from 'node:async_hooks'
import { bindActorStore, type CommitActor } from './actor-context'

/**
 * Server-only half of the commit actor context (see ./actor-context for why
 * the split exists). Importing this module binds the AsyncLocalStorage into
 * the isomorphic registry so getActor() works wherever engine.ts runs on the
 * server. Only ever import this from server-side code (pending-operation
 * commit paths, API routes): never from anything reachable by a client
 * component bundle.
 */
const actorStorage = new AsyncLocalStorage<CommitActor>()

bindActorStore(actorStorage)

/** Run fn with the given actor visible to getActor() across awaits. */
export function runWithActor<T>(actor: CommitActor, fn: () => Promise<T>): Promise<T> {
  return actorStorage.run(actor, fn)
}
