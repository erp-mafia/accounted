# Handoff: BankID instant login (BLOCKED)

## Where this lives
- **Branch:** `worktree-bankid-instant-login`
- **PR:** #2329 — https://github.com/erp-mafia/accounted/pull/2329 (open, do NOT merge)
- **Worktree:** `C:\Users\emilm\projects\erp-base\.claude\worktrees\bankid-instant-login`
- **Commits:** `dec107ab0` (feature) + `6816a4e6b` (merge of origin/main). Pushed to origin.
- **Base:** branched from `origin/main` at `cbe558088`, merged up to `41a5728ca`.

## What was built and why
Today only one signup failed to complete: a BankID user whose confirmation mail a Microsoft 365 tenant quarantined. Since the Sept-2026 pre-hijack audit, a BankID signup created an *unconfirmed* account and refused login until the mailed link was clicked, so it inherited e-mail deliverability as a hard dependency. Goal of this branch: **BankID signs the user in immediately** (BankID proves the person; the mail only proves the mailbox), keep the address "pending" until the mailed link is clicked, and keep the audit's anti-hijack invariants.

Implemented:
- `extensions/general/tic/lib/bankid-session-grant.ts` — mints a session for a pending account via a **password grant** on a rotated random server-side password.
- `extensions/general/tic/index.ts` — signup and pending-login branches return `{ type: 'session', session }` instead of refusing/mailing-only.
- `extensions/general/tic/lib/bankid-pending-routes.ts` — `POST /bankid/pending/resend` + `/change-email` for the banner.
- `components/auth/EmailVerificationBanner.tsx` + wired into `app/(dashboard)/layout.tsx` and `app/(onboarding)/layout.tsx`; strings under `email_verification` in `messages/sv.json` + `en.json`.
- `app/(auth)/auth/callback/route.ts` — reconcile pending identity on the PKCE `code` exchange too; on revoke, call new RPC `revoke_user_sessions`.
- `supabase/migrations/20260905160000_revoke_user_sessions.sql` — SECURITY DEFINER, service_role only, deletes `auth.sessions` except a kept id. **Already applied to staging** (`metjnjrhvujscngnpzdv`) and pg-real-tested there. NOT applied to prod.
- `lib/auth/mfa.ts` — `bankid_pending` skips TOTP.
- `app/api/team/accept/route.ts` — refuses pending accounts.
- `lib/notifications/member-email.ts` (`unverifiedAddressUserIds`) + digest + grace — no company mail to unproven addresses.
- Rollback flag `BANKID_SIGNUP_REQUIRE_EMAIL_CONFIRMATION=true` restores the old mail-gated flow.

Unit tests + lint + typecheck + guards all pass. `npm test` is green except pre-existing Windows-CRLF-only failures unrelated to this branch.

## Why it is BLOCKED (3/3 skeptics refuted — fix these before merge)
1. **Core mechanism is wrong.** GoTrue's password update (`mintPendingSession`) clears **all** one-time tokens for the user (voids the verification mail just sent) and logs out **all** other sessions. The comment/DECISIONS claim "touches no token slot" is false. A second BankID login before clicking silently kills the outstanding mail; a pending user can hold only one session. Redesign the session mint: e.g. `admin.generateLink` + server-side `verifyOtp` (no password rotation, no forced logout), and generate the mail's confirmation link *separately/after* so it stays live. Verify against real GoTrue.
2. **Everything minted while pending survives the adoption revoke.** Only 3 surfaces check `bankid_pending`. A signed-in pending account can set a password, create API/MCP keys, enroll TOTP — none are torn down when the address owner adopts the account (revoke deletes only sessions + the bankid_identities row). Enrolled TOTP can even lock the real owner out of recovery. Fix: gate those surfaces on `bankid_pending`, and make the revoke path (`reconcilePendingBankIdIdentity`) delete keys + factors + reset the password too.
3. **Invite gate only covers the API route.** The same acceptance runs ungated in `lib/company/pending-invites.ts` (`acceptPendingInviteByToken` / `acceptPendingTeamInviteByToken`), called by `app/(onboarding)/select-company/page.tsx` and `onboarding/page.tsx`. A pending attacker joins the victim's company on the next page load. Fix: gate on `bankid_pending` inside the shared functions, with a test.
4. **The verification mail is a `magiclink` bearer token.** A stranger at a mistyped address can click it and take the account; a password reset from that inbox revokes the honest holder and orphans their data. Rethink what the confirmation link is allowed to do for a pending account.
5. **Two conditional bugs.** (a) callback `code` branch reconciles every OAuth exchange as `'oauth'`; a PKCE recovery link hits the *promote* path unless the mail hook rewrites it — use `next === '/reset-password' ? 'recovery' : 'oauth'`. (b) the password grant uses an anon-key client; GoTrue captcha enforcement on `grant_type=password` may 500 every signup on prod — verify on staging or use a service-role grant.

Full skeptic detail is in the PR thread context; the failing scenarios above are the inputs to the fix.

## How the next agent continues
1. In this repo, work in the worktree above (or `git worktree add` a fresh one from `origin/worktree-bankid-instant-login`). `npm ci` first (Windows: never bun/pnpm; worktrees don't inherit `.env*`, copy them in).
2. This branch's `.env.local` points at PRODUCTION. Staging DDL/pg-real go through project `metjnjrhvujscngnpzdv`. Migration `20260905160000` is already on staging — do not re-apply; if you change its SQL, bump to a fresh version.
3. Decide the direction first — the design flaw (findings 1 + 4) may be reason to drop instant-login and instead fix e-mail deliverability (DMARC enforcement, a resend/change-address page, admin visibility). That is a founder call that was left open.
4. If continuing instant-login: fix findings 1-5, re-run `npm run lint`, `npm run check:types`, `npm test`, `npm run check:guards`, and the pg-real test, then a fresh adversarial review, then a live BankID signup to a Microsoft-hosted address on staging (TIC is hosted-only, never exercised in unit tests).
5. Prod migration history currently matches the repo (no orphans) — keep it that way.

## Not part of the branch (already done on prod today)
- Test account `levandefisken@gmail.com` was tombstoned so the address is free for re-signup.
- The one stuck signup, `daniel.assarsson@slipp.se`, was promoted by hand (confirmed + `bankid_linked`).
