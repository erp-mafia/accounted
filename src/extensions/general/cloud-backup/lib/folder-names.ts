/**
 * Folder naming shared by the sync engine and the storage providers.
 *
 * Lives in its own module so a provider can read it without importing
 * `sync.ts`, which imports the provider registry back (import cycle).
 */

/**
 * Top-level folder created in the user's Google Drive. Wire-format identifier:
 * it names a folder that already exists in every connected user's Drive, so
 * renaming it would strand their existing backups (see the gnubok naming rule
 * in CLAUDE.md).
 *
 * Dropbox has no equivalent: the app is app-folder scoped, so Dropbox's own
 * `Apps/<app name>/` folder already plays this role and company folders sit
 * directly inside it.
 */
export const ROOT_FOLDER_NAME = 'gnubok'
