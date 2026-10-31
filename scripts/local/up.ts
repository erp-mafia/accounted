/**
 * npm run local:up: run the app from this checkout against a throwaway local
 * Supabase, with a user and a company to log in as, so a change can be shown
 * working in a real browser (npm run local:check) without anyone setting
 * anything up by hand.
 *
 *   1. (up.sh) Refuses to run where .env, .env.local or .env.development
 *      exists: the dev server would load their keys (.env.local is
 *      production). Then gives the checkout a node_modules matching
 *      package-lock.json.
 *   2. Starts this checkout's own Supabase project (own project id and ports,
 *      prod's Postgres major), then replays supabase/bootstrap.sql and every
 *      migration with psql file by file, as CI's pg-real job does. The CLI's
 *      own migration step is off: it is far slower.
 *   3. Writes .env.development.local with the local URL and keys and nothing
 *      else, and starts the dev server with a scrubbed process environment.
 *   4. Seeds one user, their personal team (ensure_user_team, as the user)
 *      and one aktiebolag on it through createCompanyCore, the sequence the
 *      wizard, the MCP tool and POST /api/v1/companies share.
 *   5. Starts `npm run dev` on a free port and waits for /api/health.
 *
 * Login, URL, ports and pid go to .local/state.json, the dev server's output
 * to .local/next-dev.log. npm run local:down stops and deletes all of it.
 * Production and .env.local are never read.
 *
 * Usage (from the repository root of any checkout; up.sh first gives it a
 * node_modules of its own that matches package-lock.json):
 *   npm run local:up
 *   npm run local:up -- --sim    also builds the simulated company (tests/sim)
 *                                and logs in to it: three years of books
 */
import { spawn, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { createClient } from '@supabase/supabase-js'
import { createCompanyCore } from '../../src/lib/company/create-company'
import { CompanySetupSchema, planCompanySetup } from '../../src/lib/company/onboarding-input'
import {
  ENV_FILE,
  ENV_MARKER,
  SEED_COMPANY_NAME,
  SEED_EMAIL,
  SEED_ORG_NUMBER,
  devServerEnv,
  dockerPublishedPorts,
  findFreePorts,
  isLoopbackUrl,
  parseEnvLines,
  projectIdFor,
  renderDevEnv,
  renderSupabaseConfig,
} from './lib'
import {
  isHealthy,
  readState,
  removeOwnEnvFile,
  removeStackFiles,
  stackPaths,
  stopDevServer,
  stopSupabase,
  writeState,
} from './stack'

const repoRoot = process.cwd()
const paths = stackPaths(repoRoot)
async function timed<T>(label: string, step: () => Promise<T> | T): Promise<T> {
  const started = Date.now()
  const result = await step()
  console.log(`  ${label}: ${((Date.now() - started) / 1000).toFixed(1)}s`)
  return result
}

function fail(message: string): never {
  console.error(`local:up: ${message}`)
  process.exit(1)
}

function run(command: string, args: string[], label: string): string {
  const result = spawnSync(command, args, { cwd: repoRoot, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  if (result.status !== 0) {
    fail(`${label} failed (exit ${result.status}):\n${(result.stderr || result.stdout || String(result.error)).slice(-4000)}`)
  }
  return result.stdout
}

function refuseForeignEnvFile(): void {
  if (fs.existsSync(paths.envFile) && !fs.readFileSync(paths.envFile, 'utf8').startsWith(ENV_MARKER)) {
    fail(`${ENV_FILE} exists and local:up did not write it. Move it away first.`)
  }
}

function canBind(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer()
    server.once('error', (err: NodeJS.ErrnoException) => resolve(err.code === 'EAFNOSUPPORT' || err.code === 'EADDRNOTAVAIL'))
    server.listen({ port, host, exclusive: true }, () => server.close(() => resolve(true)))
  })
}

function replayMigrations(projectId: string): number {
  const container = `supabase_db_${projectId}`
  const migrationsDir = path.join(repoRoot, 'supabase', 'migrations')
  const files = [
    path.join(repoRoot, 'supabase', 'bootstrap.sql'),
    ...fs
      .readdirSync(migrationsDir)
      .filter((f) => f.endsWith('.sql'))
      .sort()
      .map((f) => path.join(migrationsDir, f)),
  ]
  for (const file of files) {
    const result = spawnSync(
      'docker',
      ['exec', '-i', container, 'psql', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-q', '-f', '-'],
      { input: fs.readFileSync(file), stdio: ['pipe', 'ignore', 'pipe'], maxBuffer: 64 * 1024 * 1024 },
    )
    if (result.status !== 0) {
      fail(
        `applying ${path.relative(repoRoot, file)} failed:\n${String(result.stderr).slice(-3000)}\n` +
          'The stack is left running for inspection; npm run local:down removes it.',
      )
    }
  }
  run('docker', ['exec', container, 'psql', '-U', 'postgres', '-d', 'postgres', '-c', "NOTIFY pgrst, 'reload schema';"], 'reloading PostgREST')
  return files.length - 1
}

async function seed(
  supabaseUrl: string,
  anonKey: string,
  serviceRoleKey: string,
  password: string,
): Promise<{ userId: string; companyId: string }> {
  const clientOptions = { auth: { persistSession: false, autoRefreshToken: false } }
  const admin = createClient(supabaseUrl, serviceRoleKey, clientOptions)
  const { data: created, error: userError } = await admin.auth.admin.createUser({
    email: SEED_EMAIL,
    password,
    email_confirm: true,
  })
  if (userError || !created.user) fail(`creating the seed user failed: ${userError?.message}`)
  const userId = created.user.id

  // The personal team the onboarding wizard attaches a new company to.
  // ensure_user_team creates it for auth.uid(), so it runs in a session of the
  // seeded user, as the wizard runs it.
  const asUser = createClient(supabaseUrl, anonKey, clientOptions)
  const { error: signInError } = await asUser.auth.signInWithPassword({ email: SEED_EMAIL, password })
  if (signInError) fail(`signing in as the seed user failed: ${signInError.message}`)
  const { data: teamId, error: teamError } = await asUser.rpc('ensure_user_team')
  if (teamError || typeof teamId !== 'string') fail(`ensure_user_team failed: ${teamError?.message}`)

  const setup = CompanySetupSchema.parse({
    name: SEED_COMPANY_NAME,
    entity_type: 'aktiebolag',
    org_number: SEED_ORG_NUMBER,
    vat_registered: true,
    moms_period: 'quarterly',
    f_skatt: true,
  })
  const plan = planCompanySetup(setup)
  if (!plan.ok) fail(`company setup refused: ${plan.error}`)
  const result = await createCompanyCore(admin, plan.input, () =>
    admin.rpc('create_company_for_user', {
      p_user_id: userId,
      p_name: setup.name,
      p_entity_type: setup.entity_type,
      p_team_id: teamId,
    }),
  )
  if (result.error !== undefined) fail(`creating the seed company failed: ${result.error}`)
  return { userId, companyId: result.companyId }
}

/** Builds in its own process: the build's network guard must not reach this script's health checks. */
function buildSimulatedCompany(
  supabaseUrl: string,
  serviceRoleKey: string,
  userId: string,
  personnummerKey: string,
): string {
  const stateFile = path.join(paths.dir, 'sim-state.json')
  const result = spawnSync(
    process.execPath,
    ['--import', 'tsx', '--conditions', 'react-server', 'scripts/sim/build.ts', '--state', stateFile],
    {
      cwd: repoRoot,
      stdio: 'inherit',
      env: {
        ...process.env,
        SIM_SUPABASE_URL: supabaseUrl,
        SIM_SERVICE_ROLE_KEY: serviceRoleKey,
        SIM_USER_ID: userId,
        SIM_PERSONNUMMER_KEY: personnummerKey,
      },
    },
  )
  if (result.status !== 0) fail(`building the simulated company failed; see ${path.join(paths.dir, 'sim', 'build.log')}`)
  return (JSON.parse(fs.readFileSync(stateFile, 'utf8')) as { companyId: string }).companyId
}

async function startDevServer(port: number, appUrl: string): Promise<number> {
  const log = fs.openSync(paths.devLog, 'a')
  const env = devServerEnv(process.env)
  // npm runs predev (extension registry, service worker) on the same node as this script.
  env.PATH = `${path.dirname(process.execPath)}${path.delimiter}${env.PATH ?? ''}`
  const child = spawn('npm', ['run', 'dev', '--', '--port', String(port), '--hostname', 'localhost'], {
    cwd: repoRoot,
    env,
    detached: true,
    stdio: ['ignore', log, log],
  })
  child.unref()
  const pid = child.pid
  if (!pid) fail('npm run dev did not start')
  let exited = false
  child.once('exit', () => {
    exited = true
  })
  const deadline = Date.now() + 300_000
  while (Date.now() < deadline) {
    if (await isHealthy(appUrl)) return pid
    if (exited) break
    await new Promise((r) => setTimeout(r, 1_000))
  }
  await stopDevServer(pid)
  const tail = fs.readFileSync(paths.devLog, 'utf8').split('\n').slice(-40).join('\n')
  return fail(`the dev server never answered ${appUrl}/api/health:\n${tail}`)
}

async function main(): Promise<void> {
  if (!fs.existsSync(path.join(repoRoot, 'supabase', 'migrations'))) fail('run from the repository root')
  const withSimulatedCompany = process.argv.includes('--sim')
  refuseForeignEnvFile()
  const projectId = projectIdFor(repoRoot)

  const existing = readState(repoRoot)
  if (existing && (await isHealthy(existing.appUrl))) {
    console.log(`Already up: ${existing.appUrl} (login ${existing.email} / ${existing.password}).`)
    return
  }
  if (existing || fs.existsSync(path.join(paths.dir, 'supabase'))) {
    console.log('A stopped or half-started stack is here; removing it first.')
    if (existing) await stopDevServer(existing.devPid)
    stopSupabase(projectId)
    removeOwnEnvFile(repoRoot)
    removeStackFiles(repoRoot)
  }

  console.log(`Starting local stack ${projectId}`)

  const published = dockerPublishedPorts(run('docker', ['ps', '--format', '{{.Ports}}'], 'docker ps'))
  const ports = await findFreePorts(
    async (port) => !published.has(port) && (await canBind(port, '0.0.0.0')) && (await canBind(port, '::')),
  )
  const appUrl = `http://localhost:${ports.app}`

  fs.mkdirSync(path.join(paths.dir, 'supabase'), { recursive: true })
  fs.writeFileSync(path.join(paths.dir, 'supabase', 'config.toml'), renderSupabaseConfig(projectId, ports, appUrl))
  await timed('supabase start', () => run('supabase', ['start', '--workdir', paths.dir], 'supabase start'))

  const status = parseEnvLines(run('supabase', ['status', '--workdir', paths.dir, '-o', 'env'], 'supabase status'))
  const supabaseUrl = status.API_URL
  const { ANON_KEY: anonKey, SERVICE_ROLE_KEY: serviceRoleKey } = status
  if (!supabaseUrl || !anonKey || !serviceRoleKey) fail('supabase status printed no API_URL, ANON_KEY or SERVICE_ROLE_KEY')
  if (!isLoopbackUrl(supabaseUrl)) fail(`refusing a non-local Supabase URL: ${supabaseUrl}`)

  const migrations = await timed('migrations', () => replayMigrations(projectId))
  const personnummerKey = randomBytes(32).toString('hex')

  fs.writeFileSync(
    paths.envFile,
    renderDevEnv({
      appUrl,
      supabaseUrl,
      anonKey,
      serviceRoleKey,
      personnummerKey,
      cronSecret: randomBytes(16).toString('hex'),
    }),
    { mode: 0o600 },
  )

  const password = randomBytes(18).toString('base64url')
  const seeded = await timed('seed', () => seed(supabaseUrl, anonKey, serviceRoleKey, password))
  const companyId = withSimulatedCompany
    ? await timed('simulated company', () =>
        buildSimulatedCompany(supabaseUrl, serviceRoleKey, seeded.userId, personnummerKey),
      )
    : seeded.companyId
  const devPid = await timed('dev server', () => startDevServer(ports.app, appUrl))

  writeState(repoRoot, {
    projectId,
    appUrl,
    supabaseUrl,
    email: SEED_EMAIL,
    password,
    companyId,
    ports,
    devPid,
    startedAt: new Date().toISOString(),
  })

  console.log(`
Local stack up (${migrations} migrations).
  App:    ${appUrl}
  Login:  ${SEED_EMAIL} / ${password}
  State:  ${path.relative(repoRoot, paths.state)}, dev server log: ${path.relative(repoRoot, paths.devLog)}
Check pages: npm run local:check -- / /bookkeeping
Stop:        npm run local:down`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
