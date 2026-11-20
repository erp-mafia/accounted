#!/usr/bin/env node
/**
 * Guard: a tracked file that .gitignore ignores.
 *
 * An ignore rule keeps a path out of new commits, but not out of the tree: a
 * file committed before the rule was written, or added with `git add -f`,
 * stays tracked, and a branch cut before the rule brings its copy along when
 * it merges. The rule then says one thing and the tree another. This check
 * lists every tracked file a .gitignore in the tree ignores; the pull request
 * pipeline runs it on the merged tree, so the file is caught before it lands.
 *
 * Only the .gitignore files of the tree are read (not a clone's
 * .git/info/exclude or a personal global ignore file), so the answer is the
 * same on every machine.
 */

import { spawnSync } from 'node:child_process'

export const TRACKED_IGNORED_HINT =
  '  Take each file out of the commit (git rm --cached <file>), or change the rule in .gitignore if the file belongs here.'

/**
 * @param {string} root the repository root
 * @returns {string[]} tracked paths that a .gitignore ignores, sorted; empty
 *   when `root` is not a git checkout (a source archive has nothing tracked).
 */
export function findTrackedIgnoredFiles(root) {
  const result = spawnSync('git', ['ls-files', '--cached', '--ignored', '--exclude-per-directory=.gitignore', '-z'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
  if (result.error || result.status !== 0) return []
  return result.stdout.split('\0').filter(Boolean).sort()
}
