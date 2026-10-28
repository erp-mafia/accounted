/**
 * npm run local:down: stop what `npm run local:up` started in this checkout
 * and delete it: the dev server's process group, this checkout's Supabase
 * project with its volumes, the env file local:up wrote and .local/ except
 * the screenshots local:check saved. Nothing another checkout or session
 * started is touched: the Supabase project is addressed by this checkout's
 * own project id.
 *
 * Usage:
 *   npm run local:down
 */
import { projectIdFor } from './lib'
import { readState, removeOwnEnvFile, removeStackFiles, stopDevServer, stopSupabase } from './stack'

async function main(): Promise<void> {
  const repoRoot = process.cwd()
  const state = readState(repoRoot)
  if (state) await stopDevServer(state.devPid)
  stopSupabase(state?.projectId ?? projectIdFor(repoRoot))
  removeOwnEnvFile(repoRoot)
  removeStackFiles(repoRoot)
  console.log('Local stack stopped and removed. Screenshots, if any, stay in .local/screenshots/.')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
