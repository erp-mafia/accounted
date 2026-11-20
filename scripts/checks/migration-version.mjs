#!/usr/bin/env node
/**
 * Guard: two migrations with one version.
 *
 * `supabase db push` keys schema_migrations on the digits before the first
 * underscore, so two files sharing them abort the push after the merge: the
 * code is live and every migration behind them waits. Each branch is clean on
 * its own and the replay in pg-real runs both files, so only the tree after
 * the merge shows it. Two parallel changes picked 20261101120100 on the same
 * day; this check reads the merged tree the merge request pipeline builds.
 */

import fs from 'node:fs'
import path from 'node:path'

export const MIGRATION_VERSION_HINT =
  '  Rename the newer file to a version of its own, above the newest in supabase/migrations.'

export function findDuplicateMigrationVersions(root) {
  const dir = path.join(root, 'supabase', 'migrations')
  if (!fs.existsSync(dir)) return []
  const byVersion = new Map()
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
    const version = file.split('_')[0]
    byVersion.set(version, [...(byVersion.get(version) ?? []), file])
  }
  return [...byVersion].filter(([, files]) => files.length > 1).map(([version, files]) => ({ version, files }))
}
