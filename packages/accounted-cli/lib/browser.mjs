import { spawn as nodeSpawn } from 'node:child_process'

/**
 * Try to open the sign-in page. The URL is passed as one argument and never
 * through a shell: `start` is a cmd builtin that would cut the URL at the
 * first `&`, so Windows goes through rundll32. A failure is silent; the URL
 * is always printed too.
 *
 * @param {string} url
 * @param {{ platform: string, spawn?: typeof nodeSpawn }} options
 */
export function openBrowser(url, { platform, spawn = nodeSpawn }) {
  /** @type {[string, string[]]} */
  const [command, args] =
    platform === 'darwin'
      ? ['open', [url]]
      : platform === 'win32'
        ? ['rundll32', ['url.dll,FileProtocolHandler', url]]
        : ['xdg-open', [url]]
  try {
    const child = spawn(command, args, { stdio: 'ignore', detached: true, shell: false })
    child.on('error', () => {})
    child.unref()
    return true
  } catch {
    return false
  }
}
