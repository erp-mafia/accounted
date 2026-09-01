// Build the public results page from the committed template + current results.
//
//   npx tsx bench/scripts/build-site.ts        (writes bench/site/index.html)
//
// The page source lives in bench/site/page.template.html with three
// placeholders, __LEADERBOARD_JSON__, __LOGOS_JSON__ and __VALIDITY_JSON__, so
// the published artifact is always reproducible from the repo: results and
// page never drift, and a lost scratchpad cannot lose the page.

import fs from 'node:fs'
import path from 'node:path'
import { BENCH_ROOT } from '../src/util'

const siteDir = path.join(BENCH_ROOT, 'site')
const template = fs.readFileSync(path.join(siteDir, 'page.template.html'), 'utf8')
const logos = fs.readFileSync(path.join(siteDir, 'logos.json'), 'utf8')
const leaderboard = fs.readFileSync(
  path.join(BENCH_ROOT, 'results', 'leaderboard.json'),
  'utf8',
)

const readJson = (p: string) => JSON.parse(fs.readFileSync(p, 'utf8'))

// The validity section is data, not prose: auditor verdicts, the bias test and
// the record of what the audit changed all render from files the scripts wrote.
const validity = {
  audit: readJson(path.join(BENCH_ROOT, 'results', 'gold-audit.json')),
  bias: readJson(path.join(BENCH_ROOT, 'results', 'gold-bias.json')),
  resolutions: readJson(path.join(siteDir, 'audit-resolutions.json')),
}

for (const token of ['__LEADERBOARD_JSON__', '__LOGOS_JSON__', '__VALIDITY_JSON__']) {
  if (!template.includes(token)) throw new Error(`template is missing ${token}`)
}

const html = template
  .replace('__LEADERBOARD_JSON__', JSON.stringify(JSON.parse(leaderboard)))
  .replace('__LOGOS_JSON__', JSON.stringify(JSON.parse(logos)))
  .replace('__VALIDITY_JSON__', JSON.stringify(validity))

const out = path.join(siteDir, 'index.html')
fs.writeFileSync(out, html)
console.log(`Wrote ${out} (${(html.length / 1024).toFixed(0)} KB)`)
