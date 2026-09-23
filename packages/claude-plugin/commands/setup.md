---
description: Connect Accounted (create the account if needed) and set up the company from this conversation. Run once after installing the plugin.
---

The user just installed the Accounted plugin, or asked to get set up. Take them from "not connected" to "books are running" without sending them to the website first. Everything below happens in this conversation except the steps that legally need a human with BankID in a browser: creating the account, approving a bank consent, authorising Skatteverket.

## Step 1: connect

Call `accounted_get_agent_briefing`.

- If it succeeds, the user is connected and has a company: say so, summarise the company in one line (name, form, method, VAT period), and stop here. Point at `/accounted:start` for orientation.
- If it fails with an authentication error, the connector is not connected yet. Tell the user: run `/mcp`, pick **accounted**, and authenticate. The browser opens Accounted's sign-in. **No account yet? Create it right there** ("Skapa konto"): BankID is fastest (about a minute, no e-mail confirmation); e-mail + password also works and asks for a 2FA app before consent. On the consent screen, read-only scopes are pre-ticked; leave **Företag: skriv** ticked so the company can be created from here. Then continue with Step 2.
- If it fails with `NO_COMPANY_YET`, the account exists but has no company yet: continue with Step 2.

## Step 2: set up the company

Call `accounted_load_skill("onboarding")` and follow it. In short: ask for the **organisationsnummer** first and call `accounted_lookup_company`; the public registry answers most of the form (name, address, F-skatt, VAT status, legal form, fiscal year), so present those as facts to confirm and ask only what `still_to_ask` lists (typically only the moms period; the accounting method defaults by company form and is confirmed in the preview). Then call `accounted_create_company` **without** `confirm` to get a preview, read the preview back in plain Swedish, and only after an explicit "ja" call it again with `confirm: true`.

Rules the tool enforces, so do not argue with them: a VAT-registered company needs both an organisationsnummer and a moms period; F-skatt must be stated, never assumed; an enskild firma always runs on the calendar year.

## Step 3: connections

Call `accounted_connect_bank` and `accounted_connect_skatteverket`. Each returns a status and a link. The user opens the link in a browser where they are logged in to Accounted, approves with BankID, and comes back. Neither is mandatory to start: bank statements can also be imported as files, and declarations can always be downloaded and filed manually.

## Step 4: hand over

Call `accounted_get_agent_briefing` again to confirm the company is live, then point at the flows: `/accounted:bookkeep` once transactions arrive, `/accounted:check` for a health check, `/accounted:start` any time for orientation.

## Rules

- Never create a company "to try things out" for a real organisation: bookkeeping duty starts the moment it exists. Use the sandbox in the web app for demos.
- Never guess company facts. Every value in the preview came from the user or from the organisationsnummer lookup.
- Every write in Accounted stages for the user's approval; nothing is booked on its own.
