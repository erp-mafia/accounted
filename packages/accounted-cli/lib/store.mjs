import crypto from 'node:crypto'
import nodeFs from 'node:fs'
import path from 'node:path'
import { AuthError, UnavailableError } from './errors.mjs'

const FILE_NAME = 'credentials.json'
const LOCK_NAME = 'credentials.lock'
const FORMAT_VERSION = 1

/**
 * @typedef {{
 *   access_token: string,
 *   refresh_token: string,
 *   token_endpoint: string,
 *   issuer: string,
 *   scope: string,
 *   created_at: string,
 *   updated_at: string,
 * }} Credentials
 */

/**
 * The credentials file: one sign-in per server origin, readable only by the
 * user (directory 0700, file 0600). Every write goes to a temporary file
 * first and is renamed into place, so a crash never leaves half a file.
 *
 * @param {{
 *   dir: string,
 *   fs?: typeof nodeFs,
 *   pid?: number,
 *   isAlive?: (pid: number) => boolean,
 *   sleep?: (ms: number) => Promise<void>,
 *   now?: () => number,
 * }} options
 */
export function createStore({
  dir,
  fs = nodeFs,
  pid = process.pid,
  isAlive = processIsAlive,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now = Date.now,
}) {
  const file = path.join(dir, FILE_NAME)
  const lockFile = path.join(dir, LOCK_NAME)

  /** @returns {{ version: number, servers: Record<string, Credentials> }} */
  function readAll() {
    let text
    try {
      text = fs.readFileSync(file, 'utf8')
    } catch (err) {
      if (/** @type {NodeJS.ErrnoException} */ (err).code === 'ENOENT') {
        return { version: FORMAT_VERSION, servers: {} }
      }
      throw new AuthError(`Cannot read ${file}: ${errorCode(err)}`)
    }
    let data
    try {
      data = JSON.parse(text)
    } catch {
      throw new AuthError(`${file} is damaged. Delete it and run \`accounted login\`.`)
    }
    if (!data || typeof data !== 'object' || typeof data.servers !== 'object' || !data.servers) {
      throw new AuthError(`${file} is damaged. Delete it and run \`accounted login\`.`)
    }
    if (data.version > FORMAT_VERSION) {
      throw new AuthError(`${file} was written by a newer version of accounted. Update the CLI.`)
    }
    return data
  }

  function ensureDir() {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  }

  /** @param {{ version: number, servers: Record<string, Credentials> }} data */
  async function writeAll(data) {
    ensureDir()
    const tmp = path.join(dir, `${FILE_NAME}.${pid}.${crypto.randomBytes(4).toString('hex')}.tmp`)
    fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 })
    // Windows refuses a rename while a virus scanner or indexer holds the
    // target open; that clears within moments.
    for (let attempt = 1; ; attempt++) {
      try {
        fs.renameSync(tmp, file)
        return
      } catch (err) {
        const code = /** @type {NodeJS.ErrnoException} */ (err).code
        if (attempt >= 8 || !['EPERM', 'EBUSY', 'EACCES'].includes(code ?? '')) {
          try {
            fs.unlinkSync(tmp)
          } catch {
            // Best effort: a leftover .tmp file is harmless.
          }
          throw err
        }
        await sleep(50 * attempt)
      }
    }
  }

  /**
   * The pid in the lock file; -1 for "held, owner unknown yet"; null for a
   * lock that can be broken.
   *
   * @param {number} waitingSinceMs @returns {number | null}
   */
  function lockHolder(waitingSinceMs) {
    try {
      const parsed = JSON.parse(fs.readFileSync(lockFile, 'utf8'))
      return Number.isInteger(parsed.pid) ? parsed.pid : null
    } catch (err) {
      if (/** @type {NodeJS.ErrnoException} */ (err).code === 'ENOENT') return null
      // Created but not written yet: treat it as held for a few seconds so a
      // fresh lock is never broken mid-creation.
      return now() - waitingSinceMs < 5_000 ? -1 : null
    }
  }

  return {
    dir,
    file,

    /** @param {string} origin @returns {Promise<Credentials | null>} */
    async read(origin) {
      return readAll().servers[origin] ?? null
    },

    /** @param {string} origin @param {Credentials} credentials */
    async write(origin, credentials) {
      const data = readAll()
      data.version = FORMAT_VERSION
      data.servers[origin] = credentials
      await writeAll(data)
    },

    /** @param {string} origin @returns {Promise<Credentials | null>} the removed entry */
    async remove(origin) {
      const data = readAll()
      const removed = data.servers[origin] ?? null
      if (!removed) return null
      delete data.servers[origin]
      if (Object.keys(data.servers).length === 0) {
        fs.unlinkSync(file)
      } else {
        await writeAll(data)
      }
      return removed
    },

    /**
     * Fail before a sign-in starts if credentials cannot be saved here (an
     * agent's sandbox often blocks writes outside the project). Otherwise the
     * server would mint a key that nothing can keep.
     */
    async ensureWritable() {
      const probe = path.join(dir, `.probe-${pid}`)
      try {
        ensureDir()
        fs.writeFileSync(probe, '', { mode: 0o600 })
        fs.unlinkSync(probe)
      } catch (err) {
        throw new AuthError(
          `Cannot save the sign-in in ${dir} (${errorCode(err)}). Run \`accounted login\` in your own terminal, outside an agent's sandbox.`
        )
      }
    },

    /**
     * Exclusive lock around a token refresh. Refresh tokens rotate on every
     * use, so two processes refreshing at once would leave one of them with a
     * spent token. A lock is broken only when its owner process is gone.
     *
     * Throws the filesystem error when the directory is not writable, so the
     * caller can tell "cannot save here" apart from "someone else is busy".
     *
     * @returns {Promise<() => void>} release
     */
    async lock(timeoutMs = 20_000) {
      ensureDir()
      const startedAt = now()
      for (;;) {
        try {
          const fd = fs.openSync(lockFile, 'wx', 0o600)
          fs.writeSync(fd, JSON.stringify({ pid, at: new Date(now()).toISOString() }))
          fs.closeSync(fd)
          return () => {
            try {
              fs.unlinkSync(lockFile)
            } catch {
              // Already gone: nothing to release.
            }
          }
        } catch (err) {
          if (/** @type {NodeJS.ErrnoException} */ (err).code !== 'EEXIST') throw err
        }
        const holder = lockHolder(startedAt)
        if (holder === null || (holder > 0 && !isAlive(holder))) {
          try {
            fs.unlinkSync(lockFile)
          } catch {
            // Someone else removed it first; just retry.
          }
          continue
        }
        if (now() - startedAt >= timeoutMs) {
          throw new UnavailableError(
            'Another accounted process is renewing the sign-in. Try again in a moment.'
          )
        }
        await sleep(100)
      }
    },
  }
}

/** @param {number} pid */
function processIsAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    // EPERM: the process exists but belongs to another user.
    return /** @type {NodeJS.ErrnoException} */ (err).code === 'EPERM'
  }
}

/** @param {unknown} err */
function errorCode(err) {
  const e = /** @type {NodeJS.ErrnoException} */ (err)
  return e?.code ?? e?.message ?? String(err)
}
