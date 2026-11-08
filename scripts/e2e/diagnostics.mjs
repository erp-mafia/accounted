import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { owner, prefix, runtimeDir } from './runtime.mjs'

const secrets = []
if (existsSync(runtimeDir)) {
  for (const name of readdirSync(runtimeDir).filter(file => file.endsWith('.env'))) {
    for (const line of readFileSync(path.join(runtimeDir, name), 'utf8').split('\n')) {
      const separator = line.indexOf('=')
      const key = line.slice(0, separator)
      const value = line.slice(separator + 1)
      if (separator < 0 || !/PASSWORD|SECRET|KEY|DB_URI|DATABASE_URL/.test(key) || !value) continue
      secrets.push(value)
      if (value.startsWith('postgres://')) secrets.push(decodeURIComponent(new URL(value).password))
    }
  }
}

for (const service of ['db', 'auth', 'rest', 'storage', 'realtime', 'gateway']) {
  const name = `${prefix}-${service}`
  const inspected = spawnSync('podman', ['inspect', name], { encoding: 'utf8' })
  if (inspected.status !== 0) continue
  if (JSON.parse(inspected.stdout)[0].Config.Labels?.['io.accounted.e2e'] !== owner) {
    throw new Error(`Refusing diagnostics for unowned resource ${name}`)
  }
  const result = spawnSync('podman', ['logs', '--tail', '60', name], { encoding: 'utf8', maxBuffer: 1024 * 1024 })
  let output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`
  for (const secret of secrets.filter(Boolean).sort((left, right) => right.length - left.length)) {
    output = output.replaceAll(secret, '[redacted]')
  }
  console.log(`Isolated ${service} diagnostics\n${output}`)
}
