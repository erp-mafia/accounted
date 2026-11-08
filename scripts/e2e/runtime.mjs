import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
export const runtimeDir = path.join(root, '.e2e')
export const owner = createHash('sha256').update(root).digest('hex').slice(0, 10)
export const prefix = `accounted-e2e-${owner}`
export const label = `io.accounted.e2e=${owner}`
export const statePath = path.join(runtimeDir, 'runtime.json')
export const endpoints = { appUrl: 'http://127.0.0.1:3101', supabaseUrl: 'http://127.0.0.1:54331' }

/** Persist generated credentials in the private checkout-owned runtime directory. */
export function saveRuntime(state) {
  mkdirSync(runtimeDir, { recursive: true, mode: 0o700 })
  writeFileSync(statePath, JSON.stringify(state, null, 2), { mode: 0o600 })
}

/** Read runtime state and reject foreign ownership or non-isolated endpoints. */
export function readRuntime() {
  const state = JSON.parse(readFileSync(statePath, 'utf8'))
  return validateRuntime(state)
}

/** Require this checkout's fixture and the exact reserved loopback endpoints. */
export function validateRuntime(state) {
  if (state.owner !== owner || state.kind !== 'synthetic-ten-year-fixture') {
    throw new Error('Expected this checkout\'s isolated E2E runtime. Run npm run test:e2e:prepare.')
  }
  for (const key of ['supabaseUrl', 'appUrl']) {
    const url = new URL(state[key])
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1') {
      throw new Error(`E2E ${key} must use loopback HTTP`)
    }
    if (state[key] !== endpoints[key]) throw new Error(`E2E ${key} must use the isolated stack's reserved port`)
  }
  return state
}

/** Construct an explicit test environment containing only generated app credentials. */
export function appEnv(state) {
  return {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR,
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
    XDG_DATA_HOME: process.env.XDG_DATA_HOME,
    LANG: 'C.UTF-8',
    TZ: 'Europe/Stockholm',
    NODE_ENV: 'production',
    NODE_OPTIONS: '--max-old-space-size=4096',
    MALLOC_ARENA_MAX: '2',
    MALLOC_TRIM_THRESHOLD_: '131072',
    NEXT_TELEMETRY_DISABLED: '1',
    NEXT_PUBLIC_SUPABASE_URL: state.supabaseUrl,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: state.anonKey,
    SUPABASE_SERVICE_ROLE_KEY: state.serviceKey,
    NEXT_PUBLIC_APP_URL: state.appUrl,
    NEXT_PUBLIC_SELF_HOSTED: 'true',
    NEXT_PUBLIC_REQUIRE_MFA: 'false',
    PERSONNUMMER_ENCRYPTION_KEY: state.encryptionKey,
    CRON_SECRET: state.cronSecret,
    SIE_IMPORT_JOBS: 'true',
    SIE_IMPORT_CHUNK_AUDIT: 'true',
    AWS_EC2_METADATA_DISABLED: 'true',
  }
}
