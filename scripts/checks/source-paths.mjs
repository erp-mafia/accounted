import fs from 'node:fs'
import path from 'node:path'

// Transitional layout for the first half of PR #2932: lib is under src,
// while the application and extensions still live at the repository root.
// Fixture roots without src/lib retain their existing layout.
export function sourcePath(root, ...segments) {
  const relative = path.join(...segments)
  const isLib = relative === 'lib' || relative.startsWith(`lib${path.sep}`)
  const prefix = isLib && fs.existsSync(path.join(root, 'src', 'lib')) ? 'src' : '.'
  return path.join(root, prefix, relative)
}

// Preserve guard exemptions and budgets under their existing source names.
export function sourceRelative(root, file) {
  return path.relative(root, file).split(path.sep).join('/').replace(/^src\/lib(?=\/|$)/, 'lib')
}
