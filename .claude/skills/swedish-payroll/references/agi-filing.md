# Arbetsgivardeklaration (AGI) Filing

## Overview

Since January 2019, every Swedish employer must file a monthly AGI reporting gross pay, withheld tax, benefits, and employer contributions per individual employee (individuppgift) to Skatteverket.

The declaration has two parts: a huvuduppgift (aggregate employer-level totals) and one individuppgift per compensated person.

From January 2025, AGI also includes frånvarouppgifter (parental leave absence data forwarded to Försäkringskassan).

## Filing deadlines

Standard deadline: 12th of the month following the pay period. If the 12th falls on a weekend or holiday, the deadline shifts to the next business day.

Exceptions:
- January and August: deadline shifts to the 17th for companies with turnover ≤40 MSEK
- Companies with turnover >40 MSEK: file by the 26th (payment still due by the 12th/17th)

## Key field codes per employee (individuppgift)

| Field code | Content |
|---|---|
| FK215 | Employee's personnummer/samordningsnummer |
| FK570 | Specifikationsnummer (unique per employee per period, must stay consistent for corrections) |
| Ruta 011 | Kontant bruttolön (gross cash salary) |
| Ruta 001 | Avdragen skatt (withheld preliminary tax) |
| Ruta 012 | Övriga skattepliktiga förmåner (all benefits except bil and drivmedel, e.g. kost, bostad) |
| Ruta 013 | Skattepliktig bilförmån (excluding drivmedel) |
| Ruta 018 | Drivmedel vid bilförmån |
| Ruta 019 | Avdrag för utgifter i arbetet (part of gross pay that covers work expenses) |
| Ruta 020 | Övriga kostnadsersättningar (other than bilersättning and traktamente) |
| Rutor 041/043 | Bostadsförmån småhus / ej småhus (checkboxes; the value goes in 012) |
| Ruta 131 | Kontant ersättning för arbete som inte är underlag för socialavgifter (e.g. employee covered by another country's social insurance, under 1,000 SEK per person per year) |
| FK821-FK827 | Absence reporting fields (from 2025) |

## XML schema and electronic submission

Skatteverket publishes a Teknisk beskrivning (currently v1.1.18.2) defining the XML file structure, validation rules, and field codes.

FK499 TotalSjuklonekostnad (HU) is retired. It fed högkostnadsskyddet för sjuklönekostnader, abolished 2024-07-01, and Skatteverket rejects the whole file when the field appears in any redovisningsperiod after 202406. Never emit it: sjuklön is not reported through AGI at all (per-employee sick days go to Försäkringskassan).

Three submission paths:
1. Manual entry in Skatteverket's e-tjänst
2. XML file upload via the same portal
3. API integration through Skatteverket's Utvecklarportal using OAuth2/REST with signed agreements and API keys

A testtjänst (sandbox) is available for XML validation without e-legitimation.

## Corrections

Corrections require resubmitting a complete AGI for the same period with the same specifikationsnummer. If you use a different specifikationsnummer, Skatteverket treats it as an additional record rather than a replacement. This is the most common developer mistake.

## Penalties for late filing

| Situation | Förseningsavgift |
|---|---|
| Late filing | 625 SEK |
| Declaration to be filed after a föreläggande | 1,250 SEK |

Amounts per SFL 48:6.

Persistent non-filing triggers skönsbeskattning (estimated assessment) and potential F-skatt revocation. Penalties are not tax-deductible (book to account 6992).