# BAS Kontoplan 7xxx: Salary Account Mapping

## 70xx: Löner till kollektivanställda

| Account | Name |
|---|---|
| 7010 | Löner till kollektivanställda |
| 7012 | Vinstandelar till kollektivanställda |
| 7013 | Lön växa-stöd kollektivanställda 10,21% |
| 7017 | Avgångsvederlag till kollektivanställda |
| 7018 | Bruttolöneavdrag, kollektivanställda |
| 7081 | Sjuklöner till kollektivanställda |
| 7082 | Semesterlöner till kollektivanställda |
| 7083 | Föräldraersättning till kollektivanställda |
| 7090 | Förändring av semesterlöneskuld |

## 72xx: Löner till tjänstemän och företagsledare

| Account | Name |
|---|---|
| 7210 | Löner till tjänstemän |
| 7213 | Lön växa-stöd tjänstemän 10,21% |
| 7218 | Bruttolöneavdrag, tjänstemän |
| 7220 | Löner till företagsledare |
| 7222 | Tantiem till företagsledare |
| 7240 | Styrelsearvoden |
| 7281 | Sjuklöner till tjänstemän |
| 7285 | Semesterlöner till tjänstemän |
| 7290 | Förändring av semesterlöneskuld (tjänstemän) |

## 73xx: Kostnadsersättningar och förmåner

| Account | Name |
|---|---|
| 7321 | Skattefria traktamenten, Sverige |
| 7322 | Skattepliktiga traktamenten, Sverige |
| 7323 | Skattefria traktamenten, utlandet |
| 7324 | Skattepliktiga traktamenten, utlandet |
| 7331 | Skattefria bilersättningar |
| 7332 | Skattepliktiga bilersättningar |
| 7381 | Kostnader för fri bostad |
| 7382 | Kostnader för fria eller subventionerade måltider |
| 7385 | Kostnader för fri bil |

## 74xx: Pensionskostnader

| Account | Name |
|---|---|
| 7410 | Pensionsförsäkringspremier |
| 7411 | Premier för kollektiva pensionsförsäkringar (ITP, SAF-LO) |
| 7412 | Premier för individuella pensionsförsäkringar |
| 7460 | Pensionsutbetalningar |

## 75xx: Sociala avgifter

| Account | Name |
|---|---|
| 7510 | Arbetsgivaravgifter 31,42% |
| 7511 | Arbetsgivaravgifter för löner och ersättningar |
| 7512 | Arbetsgivaravgifter för förmånsvärden |
| 7518 | Arbetsgivaravgifter på bruttolöneavdrag |
| 7519 | Arbetsgivaravgifter för semester- och löneskulder |
| 7533 | Särskild löneskatt pensionskostnader (24,26%) |
| 7571 | Arbetsmarknadsförsäkringar (FORA/AFA) |
| 7581 | Grupplivförsäkringspremier (TGL) |

## 76xx: Övriga personalkostnader

| Account | Name |
|---|---|
| 7610 | Utbildning |
| 7621 | Sjuk- och hälsovård, avdragsgill |
| 7631 | Personalrepresentation, avdragsgill |
| 7650 | Sjuklöneförsäkring |
| 7699 | Övriga personalkostnader (friskvårdsbidrag booked here) |

## Critical balance sheet accounts

| Account | Name | Purpose |
|---|---|---|
| 2710 | Personalskatt | Tax withholding liability |
| 2730 | Lagstadgade sociala avgifter och särskild löneskatt | Employer contribution liability (group account) |
| 2731 | Avräkning lagstadgade sociala avgifter | Reported-but-unpaid arbetsgivaravgifter; the account this codebase books and the skattekonto AGI draw clears. Use 2731 or 2730 consistently, never both in one company (issue #1870) |
| 2820/2821 | Löneskulder | Net pay liability |
| 2920 | Upplupna semesterlöner | Vacation pay liability |
| 2940/2941 | Upplupna lagstadgade sociala avgifter | Social charges on vacation liability |
| 1630 | Avräkning skatter och avgifter | Tax account at Skatteverket |

## Standard monthly journal entry flow

1. Gross salary: Debit 7210 / Credit 2710 (tax withheld) + Credit 1930 (net pay)
2. Employer social charges: Debit 7510 / Credit 2731 (this codebase's convention; 2730 is the group-account alternative, never mixed with 2731 in the same company)
3. Vacation accrual: Debit 7290 / Credit 2920
4. Social charges on accrual: Debit 7519 / Credit 2940
5. Pension premiums: Debit 7410 / Credit 2440 or 2740
6. SLP on pensions: Debit 7533 / Credit 2514