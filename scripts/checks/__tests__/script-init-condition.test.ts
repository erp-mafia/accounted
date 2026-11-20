/**
 * Proof that the script-init-condition guard flags every written-down tsx
 * invocation of a script that loads lib/init without the react-server
 * condition (package.json, a doc, a usage comment, a shebang, a spawn or fork
 * argument list), and a script that registers the server's loader itself;
 * that it lets through the condition in each of its spellings and lines that
 * only mention a script; and that the real tree is clean. Before 2026-10-16
 * all nine init scripts were documented or spawned under plain tsx, where
 * lib/init cannot load and every event reached no handler. The fixture trees
 * live in an OS temp directory created and deleted here.
 */
import { afterAll, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { findScriptInitConditionFindings } from '../script-init-condition.mjs'

const tempDirs: string[] = []
afterAll(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true })
})

function tree(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'script-init-condition-'))
  tempDirs.push(root)
  for (const [file, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true })
    fs.writeFileSync(path.join(root, file), text)
  }
  return root
}

const HELPER = `import { registerInitLoader } from '../../src/lib/initialized'
export function registerScriptInitLoader(): void {
  registerInitLoader(() => import('../../src/lib/init').then((m) => m.ensureInitialized()))
}
`
const INIT_SCRIPT = `import { registerScriptInitLoader } from './lib/register-init-loader'
registerScriptInitLoader()
`

const rules = (root: string) =>
  findScriptInitConditionFindings(root).findings.map(({ rule, file, line }) => `${rule} ${file}:${line}`)

describe('script-init-condition: finds the init scripts', () => {
  it('lists the scripts that call registerScriptInitLoader(), not the helper, a test or a mere mention', () => {
    const root = tree({
      'scripts/lib/register-init-loader.ts': HELPER,
      'scripts/repair.ts': INIT_SCRIPT,
      'scripts/sie/worker.ts': `import { registerScriptInitLoader } from '../lib/register-init-loader'\nregisterScriptInitLoader()\n`,
      'scripts/mentions.ts': '// registerScriptInitLoader() is called by the repair scripts\nexport {}\n',
      'scripts/lib/__tests__/helper.test.ts': INIT_SCRIPT,
    })
    expect(findScriptInitConditionFindings(root).initScripts).toEqual(['scripts/repair.ts', 'scripts/sie/worker.ts'])
    expect(rules(root)).toEqual([])
  })
})

describe('script-init-condition: missing condition', () => {
  it('flags each written-down tsx invocation of an init script without the condition', () => {
    const root = tree({
      'scripts/lib/register-init-loader.ts': HELPER,
      'scripts/repair.ts': `#!/usr/bin/env npx tsx
/**
 * Usage:
 *   npx tsx scripts/repair.ts --company-id <uuid>
 */
${INIT_SCRIPT}`,
      'scripts/sie/worker.ts': `import { registerScriptInitLoader } from '../lib/register-init-loader'\nregisterScriptInitLoader()\n`,
      'scripts/sie/parent.ts': `import { fork } from 'node:child_process'
const child = fork('scripts/sie/worker.ts', [], { execArgv: ['--import', 'tsx'] })
`,
      'scripts/sie/report.mjs': `spawn(process.execPath, ['--import', 'tsx', 'scripts/repair.ts'])\n`,
      'docs/operations/runbook.md': `# Runbook

\`\`\`sh
node --import tsx scripts/repair.ts
node --import tsx \\
  scripts/sie/worker.ts
\`\`\`
`,
      'package.json': JSON.stringify({ scripts: { repair: 'tsx scripts/repair.ts', lint: 'eslint' } }),
    })
    expect(rules(root)).toEqual([
      'missing-condition docs/operations/runbook.md:4',
      'missing-condition docs/operations/runbook.md:5',
      'missing-condition package.json:0',
      'shebang scripts/repair.ts:1',
      'missing-condition scripts/repair.ts:4',
      'missing-condition scripts/sie/parent.ts:2',
      'missing-condition scripts/sie/report.mjs:1',
    ])
  })

  it('accepts the condition in every spelling, and lines that mention a script without running it', () => {
    const root = tree({
      'scripts/lib/register-init-loader.ts': HELPER,
      'scripts/repair.ts': `#!/usr/bin/env -S npx tsx --conditions react-server
/**
 * Usage:
 *   npx tsx --conditions react-server scripts/repair.ts --company-id <uuid>
 *   npx tsx --conditions=react-server scripts/repair.ts
 *   node --import tsx -C react-server scripts/repair.ts
 */
${INIT_SCRIPT}`,
      'scripts/sie/worker.ts': `import { registerScriptInitLoader } from '../lib/register-init-loader'\nregisterScriptInitLoader()\n`,
      'scripts/sie/parent.ts': `import { fork } from 'node:child_process'
const child = fork('scripts/sie/worker.ts', [], { execArgv: ['--import','tsx','--conditions','react-server'] })
const other = fork('scripts/sie/worker.ts', [])
`,
      'docs/operations/runbook.md': `# Runbook

\`scripts/repair.ts\` repairs one period; see scripts/sie/worker.ts for the worker.

\`\`\`sh
NODE_OPTIONS=--conditions=react-server npx tsx scripts/repair.ts
node --import tsx --conditions react-server \\
  scripts/sie/worker.ts
\`\`\`
`,
      'package.json': JSON.stringify({ scripts: { repair: 'tsx --conditions react-server scripts/repair.ts' } }),
    })
    expect(rules(root)).toEqual([])
  })
})

describe('script-init-condition: direct register', () => {
  it('flags a script that registers the server loader itself, whose failed load would be logged and retried', () => {
    const root = tree({
      'scripts/lib/register-init-loader.ts': HELPER,
      'scripts/own-loader.ts': `import { registerInitLoader } from '../src/lib/initialized'
registerInitLoader(() => import('../src/lib/init').then((m) => m.ensureInitialized()))
`,
    })
    expect(rules(root)).toEqual(['direct-register scripts/own-loader.ts:2'])
  })
})

describe('script-init-condition on the real tree', () => {
  const ROOT = path.resolve(__dirname, '../../..')

  it('finds the init scripts and no invocation without the condition', () => {
    const { initScripts, findings } = findScriptInitConditionFindings(ROOT)
    expect(initScripts).toEqual(
      expect.arrayContaining([
        'scripts/repair-result-appropriation.ts',
        'scripts/undo-year-end-closing.ts',
      ]),
    )
    expect(findings).toEqual([])
  })
})
