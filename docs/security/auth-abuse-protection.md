# Auth Bot Protection Runbook

Accounted's password login, email registration, password recovery, and
anonymous sandbox signup support Cloudflare Turnstile through Supabase Auth.
The browser integration is dependency-free and loads Cloudflare's official
`api.js` directly. Supabase Auth validates each token with the Turnstile
secret configured in the project.

The Turnstile site key is public. The matching secret must exist only in
Cloudflare and Supabase Auth. Do not add the secret to this repository,
Vercel application variables, Docker images, browser code, logs, or analytics.

## Rollout states

The browser exposes the current client state on every protected form through
`data-turnstile-rollout-state`:

- `disabled`: `NEXT_PUBLIC_TURNSTILE_SITE_KEY` is absent. The widget is not
  loaded and existing Auth calls continue without a CAPTCHA token.
- `client-enabled`: the public site key is present. Protected submit buttons
  remain disabled until the widget returns a token, and the token is passed to
  Supabase Auth. This state does not prove that provider-side enforcement is
  active.

When client-enabled, `data-turnstile-widget-state` reports `loading`, `ready`,
`verified`, or `error` without exposing the token. Never record or inspect the
token value itself.

This split keeps login available during rollout. It also means merging this
code alone does not activate bot protection.

The hosted rollout in this runbook is scoped to Accounted's main Supabase
project. A separate tenant backend needs its own reviewed widget, hostname
allowlist, keys, test identities, and activation record. Do not copy the main
project's secret into another project.

## Hosted activation order

Use separate Turnstile widgets and key pairs for staging and production.

1. In Cloudflare, create a managed Turnstile widget and allow only the exact
   hostnames served by that environment. Include each approved white-label
   hostname explicitly. Do not allow arbitrary hostnames.
2. Set `NEXT_PUBLIC_TURNSTILE_SITE_KEY` for the matching Vercel environment and
   redeploy. The CSP is widened to `https://challenges.cloudflare.com` only in
   hosted builds that have this variable.
3. Verify all four protected forms reach `client-enabled` and `verified` on
   staging with a controlled test account. Confirm Auth requests include a
   CAPTCHA token, but do not copy or log it. Confirm the canonical callback
   URL and every approved white-label callback URL still complete Auth.
4. In the matching Supabase project, open Authentication, Bot and Abuse
   Protection. Select Cloudflare Turnstile, enter the matching secret, and
   enable CAPTCHA protection.
5. Verify on staging that requests without a token, with an invalid token,
   with an expired token, and with an already-used token are rejected. Verify
   normal login, registration, recovery, and sandbox entry still work.
6. Repeat the same ordered rollout for production. Do not use real customer
   addresses for verification and do not run password or mail-volume tests
   against production.

Rollback uses the reverse safety order: disable Supabase CAPTCHA enforcement
first, then remove the public site key and redeploy. Removing the site key
while provider enforcement remains active would block every protected flow.

## Self-hosted activation

The Docker image accepts the same optional
`NEXT_PUBLIC_TURNSTILE_SITE_KEY`. Its entrypoint substitutes the public value
into the built client. The generic image always permits the Cloudflare
Turnstile script and frame origins in CSP so the optional runtime key can work.

Configure the matching Turnstile secret and provider in the installation's
GoTrue or Supabase Auth service. Keep the same activation and rollback order as
hosted. Leaving the public key unset preserves the existing self-hosted flows.

## Controlled testing

Cloudflare publishes dummy site keys and secrets for automated tests. Use the
official always-pass or always-fail pair only in a non-production environment.
A production secret rejects dummy tokens.

Turnstile tokens expire after five minutes and are single-use. Every Auth
attempt resets the widget, including failed attempts, so a retry obtains a new
token.

## Remaining operational controls

These settings are not controlled by repository code and remain deployment
tasks:

- Record the current Supabase Auth rate-limit values from Authentication,
  Rate Limits before activation. Exercise sustained limits only on staging and
  record the expected `429` threshold.
- Enable leaked-password protection in Supabase Auth when the project plan
  supports it. A read-only Security Advisor check on 2026-08-25 reported
  `Leaked Password Protection Disabled` for the main project.
- Monitor Supabase Auth logs and Turnstile Analytics for challenge failures,
  Auth `429` responses, recovery or signup volume, and anonymous-user growth.
  Alerting must not include email addresses, passwords, CAPTCHA tokens, or
  other credentials.
- Anonymous-user retention and deletion require a separate approved retention
  policy. This integration does not delete Auth users.

## References

- [Supabase CAPTCHA protection](https://supabase.com/docs/guides/auth/auth-captcha)
- [Supabase Auth rate limits](https://supabase.com/docs/guides/auth/rate-limits)
- [Cloudflare explicit rendering](https://developers.cloudflare.com/turnstile/get-started/client-side-rendering/)
- [Cloudflare CSP requirements](https://developers.cloudflare.com/turnstile/reference/content-security-policy/)
- [Cloudflare test keys](https://developers.cloudflare.com/turnstile/troubleshooting/testing/)
