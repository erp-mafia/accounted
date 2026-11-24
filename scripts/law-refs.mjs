#!/usr/bin/env node
/**
 * What in the repository cites a provision of Swedish law.
 *
 *   npm run law:refs -- "SFL 26 kap 2 §"        every citation of the provision, and of its stycken and punkter
 *   npm run law:refs -- "ML 17 kap"              every citation inside the chapter, by provision
 *   npm run law:refs -- ML                       the provisions of a law we cite, by count
 *   npm run law:refs -- "BFNAR 2013:2"           an allmänt råd, a case (HFD 2023 ref. 45), a prop. or SOU
 *   npm run law:refs -- sfs:2023:200#K17P24     the same by key
 *   npm run law:refs                             the laws we cite, by count
 *   npm run law:refs -- --unresolved [path]      locations that name no law, so the search misses them
 *
 * Every spelling of a provision ("ML 17 kap. 24 §", "17 kap. 24 § mervärdesskattelagen",
 * "ML 17:24") is read into one key by scripts/lib/lagrum.mjs. Reads tracked
 * text: skills, docs, src, migrations, packages.
 */

import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { lawRefUrl, lawTitle, parseLawQuery, refMatches } from './lib/lagrum.mjs'
import { findLawRefs, findUnresolvedLawRefs } from './lib/law-refs-corpus.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)

const countBy = (items, keyOf) => {
  const counts = new Map()
  for (const item of items) counts.set(keyOf(item), (counts.get(keyOf(item)) ?? 0) + 1)
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
}
const filesOf = (refs) => new Set(refs.map((r) => r.file)).size

if (args[0] === '--unresolved') {
  const prefix = args[1] ?? ''
  const found = findUnresolvedLawRefs(ROOT).filter((u) => u.file.startsWith(prefix))
  for (const u of found) console.log(`${u.file}:${u.line}  ${u.match}`)
  console.log(`\n${found.length} location(s) that name no law, in ${filesOf(found)} file(s).`)
  process.exit(0)
}

const refs = findLawRefs(ROOT)

if (args.length === 0) {
  const sfs = refs.filter((r) => r.kind === 'sfs')
  console.log(`${refs.length} citations in ${filesOf(refs)} files.\n`)
  for (const [law, n] of countBy(sfs, (r) => r.sfs)) {
    console.log(`${String(n).padStart(6)}  sfs:${law}  ${lawTitle(law)}`)
  }
  for (const [kind, n] of countBy(refs.filter((r) => r.kind !== 'sfs'), (r) => r.kind)) {
    console.log(`${String(n).padStart(6)}  ${kind}`)
  }
  process.exit(0)
}

const query = parseLawQuery(args.join(' '))
if (!query) {
  console.error(`Not a law reference, key or law we know: ${args.join(' ')}`)
  process.exit(1)
}

const hits = refs.filter((r) => refMatches(r, query))
const url = lawRefUrl(query.key)
console.log(`${query.key}${query.kind === 'sfs' ? `  ${lawTitle(query.sfs)}` : ''}${url ? `\n${url}` : ''}`)
console.log(`${hits.length} citation(s) in ${filesOf(hits)} file(s).\n`)

if (query.kind === 'sfs' && !query.section) {
  // A law or a chapter: what is cited inside it, by provision.
  for (const [key, n] of countBy(hits, (r) => r.key)) console.log(`${String(n).padStart(6)}  ${key}`)
} else {
  for (const hit of hits) console.log(`${hit.file}:${hit.line}  ${hit.raw}`)
}
