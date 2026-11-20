import { AsyncLocalStorage } from 'node:async_hooks'
import { globalSingleton } from '@/lib/global-singleton'
import { bindActorStore, type CommitActor } from './actor-context'

/**
 * Server-only half of the commit actor context (see ./actor-context for why
 * the split exists). Importing this module binds the AsyncLocalStorage into
 * the isomorphic registry so getActor() works wherever engine.ts runs on the
 * server. Only ever import this from server-side code (pending-operation
 * commit paths, API routes): never from anything reachable by a client
 * component bundle.
 */
// One scope per process, not per module copy (lib/global-singleton.ts): a
// route opens it through its copy of this module, and extension code, which
// lib/init loads from instrumentation.ts, commits through another.
const actorStorage = globalSingleton('commitActorStorage', () => new AsyncLocalStorage<CommitActor>())

bindActorStore(actorStorage)

/** Run fn with the given actor visible to getActor() across awaits. */
export function runWithActor<T>(actor: CommitActor, fn: () => Promise<T>): Promise<T> {
  return actorStorage.run(actor, fn)
}
