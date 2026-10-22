# Personal data breach runbook

What to do when personal data may have been exposed, lost, altered or made
unavailable. It backs two published promises: /dpa point 9 (customers hear
from us within 24 hours of discovery) and GDPR art. 33 (IMY within 72 hours
for data we are controller for).

## 1. Discovery (hour 0)

Anything counts: an alert, a Vercel or Supabase runtime error that exposes
data, a customer or researcher report to support@accounted.se or
`.github/SECURITY.md`, a sub-processor's notice, a lost laptop.

- Write down the discovery time. Both deadlines run from it.
- Tell the other founder at once. One person owns the incident until it is closed.

## 2. Contain (first hours)

Stop the leak before the investigation: revoke keys or tokens, disable the
route or flag, rotate secrets in Vercel, pause a cron. Never delete evidence
(logs, rows, files) while containing; take copies first.

## 3. Assess (before hour 12)

Answer, as far as known:

- What happened, and when did it start?
- Whose data: which companies (tenants), which kinds of registered persons
  (users, the customers' employees, customers, suppliers), roughly how many?
- Which data: special categories (payroll absence, union fees), personnummer,
  bank data, documents?
- Our role for each set: processor (customer bookkeeping, /dpa) or
  controller (accounts, billing, support, analytics, /privacy).
- Likely consequences for the people affected.

## 4. Notify

| Who | When | How |
|---|---|---|
| Each affected customer (we are processor) | Within 24 h of discovery, even if incomplete | E-mail to the company's owners and admins; content per /dpa point 9 |
| IMY (we are controller) | Within 72 h, unless the breach is unlikely to result in a risk | IMY e-service "Anmäl personuppgiftsincident" |
| Affected persons (we are controller) | Without undue delay if the risk is high (art. 34) | E-mail |
| Sub-processor involved | When it helps containment | Their security contact |

A customer, not us, decides on reporting to IMY for its bookkeeping data; we
give it what it needs (art. 33.2 and /dpa point 9). Send more information as
it arrives; do not wait for a complete picture.

## 5. Record and follow up

- Log every breach, also the ones nobody was notified about, with facts,
  effects, actions and the reasoning on notification (art. 33.5). The log
  holds customer data, so it lives in the private crm repo, never here
  (this repository is public).
- Fix the cause, add a test or guard that would have caught it, and note the
  decision in DECISIONS.md if the fix changes a rule.
