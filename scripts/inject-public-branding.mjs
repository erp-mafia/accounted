#!/usr/bin/env node
/**
 * Stamps public/sw.js from public/sw.template.js with the runtime brand name.
 *
 * The service worker is served as a static file (Next.js does not bundle
 * public/), so NEXT_PUBLIC_* inlining doesn't reach it. We generate sw.js
 * from a template at build time (Vercel/local) so the deployed file shows
 * the configured brand name.
 *
 * Docker uses a different strategy: the builder stage exports
 * NEXT_PUBLIC_BRANDING_APP_NAME=__NEXT_PUBLIC_BRANDING_APP_NAME__ so the
 * placeholder survives the build, and docker-entrypoint.sh substitutes the
 * runtime value via sed at container start.
 *
 * public/sw.js is gitignored: the source of truth is the template.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const TEMPLATE_PATH = join(process.cwd(), 'public', 'sw.template.js')
const OUTPUT_PATH = join(process.cwd(), 'public', 'sw.js')
const PLACEHOLDER = '__NEXT_PUBLIC_BRANDING_APP_NAME__'
const value = process.env.NEXT_PUBLIC_BRANDING_APP_NAME || 'Gnubok'

if (!existsSync(TEMPLATE_PATH)) {
  console.log(`[inject-public-branding] ${TEMPLATE_PATH} not found, skipping`)
  process.exit(0)
}

const template = readFileSync(TEMPLATE_PATH, 'utf8')
const output = template.split(PLACEHOLDER).join(value)
writeFileSync(OUTPUT_PATH, output)
console.log(`[inject-public-branding] generated public/sw.js with brand "${value}"`)
