import { readFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import dotenv from 'dotenv'

// Isolated app verification; never reads or changes .env.local.
const env = {...process.env,...dotenv.parse(readFileSync('.env.sie-runtime.local'))}
if (env.NEXT_PUBLIC_SUPABASE_URL !== 'https://metjnjrhvujscngnpzdv.supabase.co') throw new Error('Staging only')
env.NEXT_PUBLIC_APP_URL = 'http://localhost:3228'
env.NEXT_PUBLIC_REQUIRE_MFA = 'false'
env.NODE_OPTIONS = '--max-old-space-size=8192'
const mode = process.argv[2]
if (!['build','dev','start'].includes(mode)) throw new Error('Expected build, dev, or start')
const args = ['node_modules/next/dist/bin/next', mode, ...(mode === 'build' ? [] : ['--port','3228'])]
const child = spawn(process.execPath,args,{env,stdio:'inherit',windowsHide:true})
child.on('exit',code => {process.exitCode = code ?? 1})
