#!/usr/bin/env node
import { main } from '../lib/cli.mjs'

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code
  },
  (err) => {
    process.stderr.write(`accounted: unexpected error: ${err?.stack ?? err}\n`)
    process.exitCode = 4
  }
)
