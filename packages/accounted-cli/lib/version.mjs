// Kept in step with package.json by __tests__/package.test.ts. A constant
// rather than a runtime read of package.json: the bin must not depend on where
// npm placed the package on disk.
export const VERSION = '0.1.0'

// Telemetry name sent as X-Accounted-Client. The server reads no version
// header, so the version rides in the name (server regex ^[A-Za-z0-9._-]{1,64}$).
export const CLIENT_NAME = `accounted-cli-${VERSION}`
