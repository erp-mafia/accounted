import { spawn } from 'node:child_process'
import { execFileSync } from 'node:child_process'
import { copyFileSync, cpSync, constants as fsConstants, mkdirSync, rmSync, openSync, closeSync } from 'node:fs'
import path from 'node:path'
import { root, runtimeDir, appEnv, readRuntime } from './runtime.mjs'
import { up, down, assertOwnedDatabase } from './stack.mjs'

/** Run a child process and reject failed startup or a nonzero exit. */
function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, stdio: 'inherit', ...options })
    child.once('error', reject)
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(`${path.basename(command)} exited with ${code}`)))
  })
}

/** Build a production snapshot containing source and generated test credentials. */
async function build(state) {
  const snapshot = path.join(runtimeDir, 'app')
  rmSync(snapshot, { recursive: true, force: true })
  mkdirSync(snapshot, { recursive: true, mode: 0o700 })
  const files = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: root }).toString().split('\0').filter(Boolean)
  for (const file of files) {
    if (file.startsWith('.env') || file.startsWith('deploy/') || file.startsWith('.e2e/')) continue
    const target = path.join(snapshot, file)
    mkdirSync(path.dirname(target), { recursive: true })
    copyFileSync(path.join(root, file), target)
  }
  // Turbopack rejects a node_modules symlink escaping the project root.
  // Reflinks keep this isolated copy cheap on btrfs and fall back on other FSes.
  cpSync(path.join(root, 'node_modules'), path.join(snapshot, 'node_modules'), {
    recursive: true, verbatimSymlinks: true, mode: fsConstants.COPYFILE_FICLONE,
  })
  // The regular self-hosted extension set is compiled, with synthetic test keys
  // only. Optional external integrations receive no provider credentials.
  copyFileSync(path.join(root, 'docker/extensions.self-hosted.json'), path.join(snapshot, 'extensions.config.json'))
  const log = openSync(path.join(runtimeDir, 'build.log'), 'w', 0o600)
  console.log('Building an isolated production app. Details in .e2e/build.log')
  try {
    await run('npm', ['run', 'build'], {
      cwd: snapshot, env: { ...appEnv(state), NODE_OPTIONS: '--max-old-space-size=8192' },
      stdio: ['ignore', log, log],
    })
  }
  finally { closeSync(log) }
}

const command = process.argv[2] ?? 'test'
try {
  if (command === 'down') {
    down()
  } else if (command === 'build') {
    assertOwnedDatabase()
    await build(readRuntime())
  } else if (command === 'serve') {
    const state = readRuntime()
    assertOwnedDatabase()
    const snapshot = path.join(runtimeDir, 'app')
    const child = spawn(process.execPath, [path.join(root, 'node_modules/next/dist/bin/next'), 'start', '--hostname', '127.0.0.1', '--port', new URL(state.appUrl).port], {
      cwd: snapshot, env: appEnv(state), stdio: 'inherit',
    })
    for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal))
    child.once('exit', code => { process.exitCode = code ?? 1 })
  } else {
    if (command === 'reset') down()
    if (!['test', 'prepare', 'reset', 'check'].includes(command)) throw new Error(`Unknown E2E command ${command}`)
    if (command !== 'check') {
      const state = await up()
      await run(process.execPath, ['--conditions=react-server', '--import', 'tsx', 'tests/e2e/seed.ts'], { env: appEnv(state) })
      await build(state)
    } else {
      assertOwnedDatabase()
      await run(process.execPath, ['--conditions=react-server', '--import', 'tsx', 'tests/e2e/seed.ts'], { env: appEnv(readRuntime()) })
    }
    if (command === 'test' || command === 'check') {
      await run(process.execPath, ['node_modules/@playwright/test/cli.js', 'test', ...process.argv.slice(3)])
    }
  }
} catch (error) {
  console.error(error.message)
  process.exitCode = 1
}
