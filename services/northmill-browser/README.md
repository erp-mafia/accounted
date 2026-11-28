# Northmill statement browser

An optional worker for self-hosted Accounted installations. It opens a temporary
Chromium context, shows the bank's live BankID QR image, offers company/account
read navigation, and downloads a statement CSV. Accounted's normal bank-file wizard
then previews the file before the person confirms import.

The worker never posts journal entries or initiates payments. It needs outbound
HTTPS to Northmill and its page assets. BankID approval remains a manual step.
Without worker configuration, the bank-file import page keeps its existing flow.

## Install the worker

This directory is a separate Node package. Its locked Playwright dependency is
installed only on the worker host; it adds no dependency to the Next.js app.
Use Node 22.15 or newer and install Chromium's OS libraries for your platform.

```sh
npm ci --prefix services/northmill-browser
npm run install:browser --prefix services/northmill-browser
```

The optional `accounted-northmill-browser.service` is a systemd **user** unit.
Adapt its checkout and Node paths, install it under `~/.config/systemd/user/`,
and create `~/.config/accounted/northmill-browser.env` with mode 0600:

```text
NORTHMILL_BROWSER_TOKEN=<random secret of at least 32 characters>
```

Generate a token locally, for example with `openssl rand -hex 32`. Never commit it.
Enable the unit after reloading the user manager:

```sh
systemctl --user daemon-reload
systemctl --user enable --now accounted-northmill-browser.service
```

The unit creates a private runtime directory and listens on its `worker.sock`
Unix socket with mode 0600. It exposes no network port. For a manually launched
worker, set `NORTHMILL_BROWSER_SOCKET` explicitly; otherwise it binds loopback only.
The authenticated `/health` endpoint checks the worker process.

## Configure Accounted

Set these server-side variables and restart Accounted:

```text
NORTHMILL_BROWSER_SOCKET=/path/as/seen/by/accounted/worker.sock
NORTHMILL_BROWSER_TOKEN=<same secret as the worker>
```

The app and worker must run as compatible Unix users. For a containerized app,
mount the worker's **runtime directory**, rather than the individual socket file,
so worker restarts can replace the socket. Set the app variable to that directory's
container path plus `/worker.sock`. Configure the worker separately on each app
instance. No database migrations are needed.

To disable the feature, remove the two app variables and stop/disable the worker.
The existing manual CSV upload continues to work.

## Use

Open Import > bank file and choose Fetch from Northmill. Scan the bank QR with
BankID, select the matching company and business account, then choose
`Visa alla & exportera`. Fetch the CSV and continue to the existing preview.
The bank's currently selected period is used, normally the latest 90 days.
Verify the actual dates and cash account in the preview. The adapter does not
currently automate the bank calendar picker.

The company number used to filter the bank's company selector comes from the
active Accounted company. The downloaded CSV must name the same organization.

## Isolation and limits

Every app route requires an authenticated company member with write permission;
mutations also check the canonical app Origin. The browser never receives the
worker token. Every worker call requires that token and the exact company/user
session owner, so a session ID alone grants no access.

The worker keeps at most four sessions and one session per company/user. Sessions
expire after ten minutes, including ready downloads. Bank QR validity may be
shorter. Cancellation, expiry and completed downloads close the temporary browser;
ready CSV bytes stay in memory until cancellation or expiry. Nothing is restored
across worker restarts. Temporary browser profiles are not reused. No persistent
cookie store, HAR, trace, video or screenshot archive is created by the worker.

Navigation exposes specific company-selection controls, known account/transaction
URLs and read navigation labels. There are no arbitrary URL, script, keyboard or
coordinate endpoints. Downloads must have Northmill CSV headers and stay below
10 MiB. Unknown layouts fail closed. Logs use fixed stages and error names without
page text, bank URLs or credentials. Keep the worker token and socket private.

## Tests and compatibility

```sh
npm test --prefix services/northmill-browser
npx vitest run src/app/api/import/northmill src/lib/bank-browser
```

The Chromium fixture verifies QR capture, matching-company selection, blocked
payment navigation, `Visa alla & exportera` without an anchor href, CSV download
and foreign-company refusal. HTTP/session tests cover authentication, owner
isolation, TTL, capacity and cancellation while a browser is still opening.
App tests cover authentication, viewer refusal, Origin, input validation and
private Unix socket forwarding.

Verified on 2026-11-28 in a separate self-hosted installation: desktop/mobile QR,
account-holder BankID approval, business-account navigation and a real CSV export
accepted by Accounted's existing parser. The account holder also confirmed the
resulting import flow works. No real bank fixtures, credentials or financial data
are included in this package.

Northmill's CloudFront refused the default HeadlessChrome user agent on API
preflight. A normal Chromium user agent using the installed browser version
loaded the portal. Browser locale en-US matches the verified `Deny All Cookies`
control; the banking UI remains Swedish. Bank UI changes may require adapting
`northmill.mjs` and revalidating with the account holder.
