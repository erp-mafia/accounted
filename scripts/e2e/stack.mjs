import { randomBytes, createHmac, createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { existsSync, writeFileSync, rmSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { root, runtimeDir, owner, prefix, label, endpoints, saveRuntime, readRuntime } from './runtime.mjs'

const images = {
  db: 'docker.io/supabase/postgres:17.6.1.136',
  auth: 'docker.io/supabase/gotrue:v2.197.0',
  rest: 'docker.io/postgrest/postgrest:v14.18',
  storage: 'docker.io/supabase/storage-api:v1.81.0',
  realtime: 'docker.io/supabase/realtime:v2.143.3',
  gateway: 'docker.io/library/caddy:2',
}
const services = ['gateway', 'realtime', 'storage', 'rest', 'auth', 'db']

/** Hash bootstrap and migration contents to reject incompatible cached schemas. */
function schemaFingerprint() {
  const hash = createHash('sha256')
  for (const file of ['tests/pg/bootstrap.sql', 'supabase/bootstrap.sql',
    ...readdirSync(path.join(root, 'supabase/migrations')).filter(name => name.endsWith('.sql')).sort().map(name => `supabase/migrations/${name}`)]) {
    hash.update(file).update(readFileSync(path.join(root, file)))
  }
  return hash.digest('hex')
}

/** Run Podman with bounded output and report failures without leaking service logs. */
function command(args, input) {
  const result = spawnSync('podman', args, { input, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
  if (result.status !== 0) {
    // Service logs can contain generated credentials. Keep them private.
    const logPath = path.join(runtimeDir, 'stack-error.log')
    writeFileSync(logPath, `${result.stdout ?? ''}\n${result.stderr ?? ''}\n${result.error ?? ''}`, { mode: 0o600 })
    throw new Error(`Podman operation failed. Private details in ${logPath}`)
  }
  return result.stdout.trim()
}

/** Check the resource ownership label before operating on a container or network. */
function owned(name, kind = 'container') {
  const result = spawnSync('podman', [kind, 'inspect', name], { encoding: 'utf8' })
  if (result.status !== 0) return false
  const info = JSON.parse(result.stdout)[0]
  const labels = kind === 'container' ? info.Config.Labels : info.labels
  if (labels?.['io.accounted.e2e'] !== owner) throw new Error(`Refusing to modify unowned resource ${name}`)
  return true
}

/** Require the isolated database to belong to this checkout before seeding or serving. */
export function assertOwnedDatabase() {
  if (!owned(`${prefix}-db`)) throw new Error('The isolated E2E database is not running')
  if (!owned(`${prefix}-gateway`)) throw new Error('The isolated E2E gateway is not running')
}

/** Apply SQL through the owned database container using the required bootstrap role. */
function sql(input, role = 'postgres') {
  return command(['exec', '-i', `${prefix}-db`, 'psql', '-U', role, '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-q'], input)
}

/** Poll an isolated service until healthy, enforcing a bounded startup deadline. */
async function ready(url, headers = {}) {
  const deadline = Date.now() + 120_000
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { headers, signal: AbortSignal.timeout(2000) })
      if (response.ok) return
    } catch { /* A fresh service may not yet accept connections. */ }
    await new Promise(resolve => setTimeout(resolve, 500))
  }
  throw new Error(`Isolated service did not become ready at ${new URL(url).pathname}`)
}

/** Sign a local Supabase role token using the generated fixture secret. */
function jwt(role, secret) {
  const encoded = value => Buffer.from(JSON.stringify(value)).toString('base64url')
  const payload = `${encoded({ alg: 'HS256', typ: 'JWT' })}.${encoded({ role, iss: 'supabase', iat: 0, exp: 4102444800 })}`
  return `${payload}.${createHmac('sha256', secret).update(payload).digest('base64url')}`
}

/** Start one labeled service with its generated private environment file. */
function start(service, env, args = []) {
  const envPath = path.join(runtimeDir, `${service}.env`)
  writeFileSync(envPath, Object.entries(env).map(([key, value]) => `${key}=${value}`).join('\n'), { mode: 0o600 })
  command(['run', '-d', '--name', `${prefix}-${service}`, '--label', label,
    '--network', prefix, '--env-file', envPath, ...args, images[service]])
}

/** Reuse a compatible owned stack or provision real services and replay the schema. */
export async function up() {
  if (existsSync(path.join(runtimeDir, 'runtime.json'))) {
    const state = readRuntime()
    assertOwnedDatabase()
    if (!state.schemaReady) throw new Error('Incomplete E2E setup. Run npm run test:e2e:reset.')
    if (state.schemaHash !== schemaFingerprint()) throw new Error('E2E schema changed. Run npm run test:e2e:reset.')
    await ready(`${state.supabaseUrl}/auth/v1/health`)
    await ready(`${state.supabaseUrl}/storage/v1/status`)
    await ready(`${state.supabaseUrl}/realtime/v1/health`)
    return state
  }
  const secret = randomBytes(48).toString('hex')
  const password = randomBytes(24).toString('hex')
  const state = {
    kind: 'synthetic-ten-year-fixture', owner, schemaReady: false, schemaHash: schemaFingerprint(),
    ...endpoints,
    anonKey: jwt('anon', secret), serviceKey: jwt('service_role', secret),
    encryptionKey: randomBytes(32).toString('hex'), cronSecret: randomBytes(32).toString('hex'),
  }
  saveRuntime(state)
  command(['network', 'create', '--label', label, prefix])
  start('db', { POSTGRES_PASSWORD: password }, ['--shm-size=256m'])
  const deadline = Date.now() + 120_000
  while (spawnSync('podman', ['exec', `${prefix}-db`, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres'], { stdio: 'ignore' }).status !== 0) {
    if (Date.now() > deadline) throw new Error('E2E Postgres startup timed out')
    await new Promise(resolve => setTimeout(resolve, 500))
  }
  sql(`ALTER ROLE supabase_auth_admin PASSWORD '${password}';
    ALTER ROLE supabase_storage_admin PASSWORD '${password}';
    ALTER ROLE authenticator PASSWORD '${password}';
    ALTER ROLE supabase_admin PASSWORD '${password}';
    CREATE SCHEMA IF NOT EXISTS _realtime AUTHORIZATION supabase_admin;`, 'supabase_admin')
  start('auth', {
    GOTRUE_API_HOST: '0.0.0.0', GOTRUE_API_PORT: '9999', API_EXTERNAL_URL: `${state.supabaseUrl}/auth/v1`,
    GOTRUE_DB_DRIVER: 'postgres', GOTRUE_DB_DATABASE_URL: `postgres://supabase_auth_admin:${password}@${prefix}-db:5432/postgres`,
    GOTRUE_SITE_URL: state.appUrl, GOTRUE_JWT_SECRET: secret, GOTRUE_JWT_ADMIN_ROLES: 'service_role',
    GOTRUE_JWT_ISSUER: `${state.supabaseUrl}/auth/v1`,
    // CI has hit Auth's default ten-second deadline during initial provisioning.
    // Browser request budgets are enforced independently after fixture setup.
    GOTRUE_API_MAX_REQUEST_DURATION: '60s',
    GOTRUE_JWT_AUD: 'authenticated', GOTRUE_JWT_DEFAULT_GROUP_NAME: 'authenticated', GOTRUE_JWT_EXP: '7200',
    GOTRUE_EXTERNAL_EMAIL_ENABLED: 'true', GOTRUE_MAILER_AUTOCONFIRM: 'true',
    GOTRUE_RATE_LIMIT_EMAIL_SENT: '1000', GOTRUE_RATE_LIMIT_TOKEN_REFRESH: '1000',
  })
  start('rest', {
    PGRST_DB_URI: `postgres://authenticator:${password}@${prefix}-db:5432/postgres`,
    PGRST_DB_SCHEMAS: 'public', PGRST_DB_ANON_ROLE: 'anon', PGRST_JWT_SECRET: secret,
    PGRST_SERVER_HOST: '0.0.0.0', PGRST_DB_MAX_ROWS: '1000', PGRST_DB_POOL: '10',
  })
  start('storage', {
    ANON_KEY: state.anonKey, SERVICE_KEY: state.serviceKey, AUTH_JWT_SECRET: secret,
    POSTGREST_URL: `http://${prefix}-rest:3000`,
    DATABASE_URL: `postgres://supabase_storage_admin:${password}@${prefix}-db:5432/postgres`,
    STORAGE_PUBLIC_URL: `${state.supabaseUrl}/storage/v1`, REQUEST_ALLOW_X_FORWARDED_PATH: 'true',
    STORAGE_BACKEND: 'file', FILE_STORAGE_BACKEND_PATH: '/var/lib/storage', FILE_SIZE_LIMIT: '52428800',
    GLOBAL_S3_BUCKET: 'e2e', TENANT_ID: 'e2e', REGION: 'local', ENABLE_IMAGE_TRANSFORMATION: 'false',
  })
  const gateway = path.join(runtimeDir, 'Caddyfile')
  writeFileSync(gateway, `{
    admin off
    auto_https off
  }
  :8080 {
    header {
      >Access-Control-Allow-Origin "${state.appUrl}"
      >Access-Control-Allow-Methods "GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS"
      >Access-Control-Allow-Headers "authorization, apikey, content-type, accept-profile, content-profile, prefer, range, x-upsert, x-retry-count, x-client-info, x-supabase-api-version, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version"
      >Access-Control-Expose-Headers "Content-Range, Range"
      >Vary "Origin"
    }
    @preflight method OPTIONS
    handle @preflight {
      respond "" 204
    }
    handle_path /auth/v1/* {
      reverse_proxy ${prefix}-auth:9999
    }
    handle_path /rest/v1/* {
      @service header apikey ${state.serviceKey}
      request_header @service Authorization "Bearer ${state.serviceKey}"
      reverse_proxy ${prefix}-rest:3000
    }
    handle_path /storage/v1/* {
      reverse_proxy ${prefix}-storage:5000
    }
    handle /realtime/v1/health {
      rewrite * /api/tenants/realtime-dev/health
      reverse_proxy realtime-dev.supabase-realtime:4000 {
        header_up Host realtime-dev.supabase-realtime
        header_up Authorization "Bearer ${state.anonKey}"
      }
    }
    handle_path /realtime/v1/* {
      rewrite * /socket{path}
      reverse_proxy realtime-dev.supabase-realtime:4000 {
        header_up Host realtime-dev.supabase-realtime
      }
    }
  }`, { mode: 0o600 })
  start('gateway', {}, ['-p', '127.0.0.1:54331:8080', '-v', `${gateway}:/etc/caddy/Caddyfile:ro,z`])
  await ready(`${state.supabaseUrl}/auth/v1/health`)
  await ready(`${state.supabaseUrl}/storage/v1/status`)
  sql(readFileSync(path.join(root, 'tests/pg/bootstrap.sql'), 'utf8'), 'supabase_admin')
  sql(readFileSync(path.join(root, 'supabase/bootstrap.sql'), 'utf8'))
  const migrations = readdirSync(path.join(root, 'supabase/migrations')).filter(name => name.endsWith('.sql')).sort()
  console.log(`Applying ${migrations.length} migrations to the owned synthetic database`)
  const replay = migrations.map(name => `\\echo E2E migration ${name}\n`
    + readFileSync(path.join(root, 'supabase/migrations', name), 'utf8') + '\n').join('\n')
  sql(replay)
  start('realtime', {
    PORT: '4000', DB_HOST: `${prefix}-db`, DB_PORT: '5432', DB_USER: 'supabase_admin', DB_PASSWORD: password,
    DB_NAME: 'postgres', DB_AFTER_CONNECT_QUERY: 'SET search_path TO _realtime', DB_ENC_KEY: randomBytes(8).toString('hex'),
    API_JWT_SECRET: secret, METRICS_JWT_SECRET: secret, SECRET_KEY_BASE: randomBytes(64).toString('hex'),
    ERL_AFLAGS: '-proto_dist inet_tcp', ERL_FLAGS: '+S 2:2', DNS_NODES: "''", RLIMIT_NOFILE: '10000', APP_NAME: 'realtime',
    SEED_SELF_HOST: 'true', RUN_JANITOR: 'true', DISABLE_HEALTHCHECK_LOGGING: 'true',
  }, ['--network-alias', 'realtime-dev.supabase-realtime'])
  await ready(`${state.supabaseUrl}/realtime/v1/health`)
  sql("NOTIFY pgrst, 'reload schema';")
  await ready(`${state.supabaseUrl}/rest/v1/fiscal_periods?select=id&limit=1`, {
    apikey: state.serviceKey, Authorization: `Bearer ${state.serviceKey}`,
  })
  state.schemaReady = true
  saveRuntime(state)
  return state
}

/** Remove owned test resources and generated credentials while retaining test reports. */
export function down() {
  for (const service of services) {
    const name = `${prefix}-${service}`
    if (owned(name)) command(['rm', '-f', '-v', name])
  }
  if (owned(prefix, 'network')) command(['network', 'rm', prefix])
  rmSync(path.join(runtimeDir, 'runtime.json'), { force: true })
  rmSync(path.join(runtimeDir, 'fixture.json'), { force: true })
  rmSync(path.join(runtimeDir, 'auth.json'), { force: true })
  for (const name of services) rmSync(path.join(runtimeDir, `${name}.env`), { force: true })
  rmSync(path.join(runtimeDir, 'Caddyfile'), { force: true })
}
