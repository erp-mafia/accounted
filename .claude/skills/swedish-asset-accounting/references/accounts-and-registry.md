# BAS Account Mapping & Anläggningsregister

## BAS Account Structure for Fixed Assets

Pattern: xx0 = asset, xx8 = accumulated impairment (nedskrivning), xx9 = accumulated depreciation.

Kontogrupp 12 is the exception after BAS 2026: 1212/1214/1216/1217 and
1222/1224/1226/1227 are asset accounts that all accumulate on the group's
single xx9 (1219 and 1229 respectively).

### Intangible Assets (Kontogrupp 10)

| Account | Description | Notes |
|---|---|---|
| 1010 | Utvecklingsutgifter | Ej K2 (must expense under K2) |
| 1019 | Ack. avskr. utvecklingsutgifter | |
| 1020 | Koncessioner | |
| 1029 | Ack. avskr. koncessioner | |
| 1030 | Patent | |
| 1039 | Ack. avskr. patent | |
| 1040 | Licenser | |
| 1049 | Ack. avskr. licenser | |
| 1050 | Varumärken | |
| 1059 | Ack. avskr. varumärken | |
| 1060 | Hyresrätter och tomträtter | |
| 1069 | Ack. avskr. hyresrätter | |
| 1070 | Goodwill | |
| 1079 | Ack. avskr. goodwill | |
| 1080 | Pågående projekt/förskott immateriella | |
| 1088 | Ack. nedskrivningar immateriella | |

### Buildings and Land (Kontogrupp 11)

| Account | Description | Notes |
|---|---|---|
| 1110 | Byggnader | 1111 egen mark, 1112 annans mark |
| 1118 | Ack. nedskr. byggnader | |
| 1119 | Ack. avskr. byggnader | |
| 1120 | Förbättringsutgifter annans fastighet | |
| 1129 | Ack. avskr. förbättringsutgifter | |
| 1130 | Mark | Never depreciated |
| 1140 | Tomter och obebyggda markområden | |
| 1150 | Markanläggningar | |
| 1159 | Ack. avskr. markanläggningar | |
| 1180 | Pågående nyanläggningar/förskott | |

### Machinery and Inventory (Kontogrupp 12)

BAS 2026 splits kontogrupp 12 by **production use**, not by asset kind. 121x
is maskiner (för produktion), 122x is inventarier (ej för produktion), and the
same kind of asset lands in either block depending on what it is used for. The
old per-kind accounts (1240 Bilar, 1250 Datorer, 1260 Leasade tillgångar and
their 124x subdivisions) are gone: 1230, 1240/1249, 1250/1259 and 1260/1269 are
now **fria konton** with no prescribed meaning. Do not book new assets there.

| Account | Description | Notes |
|---|---|---|
| 1210 | Maskiner och andra tekniska anläggningar | Head, för produktion |
| 1211 | Maskiner och andra tekniska anläggningar i övrigt | |
| 1212 | Byggnads- och markinventarier (för produktion) | Tax: follows IL 18 kap, not building rates |
| 1214 | Datorer (för produktion) | |
| 1216 | Arbetsfordon | Vehicles used in production |
| 1217 | Finansiellt leasade maskiner | Ej K2. K3 financial leases, IFRS 16 ROU. |
| 1218 | Ack. nedskr. maskiner | |
| 1219 | Ack. avskr. maskiner | Contra for all of 121x |
| 1220 | Inventarier, verktyg och installationer | Head, ej för produktion |
| 1221 | Inventarier, verktyg och installationer i övrigt | |
| 1222 | Byggnads- och markinventarier (ej för produktion) | Tax: follows IL 18 kap, not building rates |
| 1224 | Datorer (ej för produktion) | Office laptops, not production hardware |
| 1226 | Bilar och transportmedel (ej för produktion) | Personbilar, lastbilar, övriga transportmedel |
| 1227 | Finansiellt leasade inventarier | Ej K2. K3 financial leases, IFRS 16 ROU. |
| 1228 | Ack. nedskr. inventarier | |
| 1229 | Ack. avskr. inventarier | Contra for all of 122x |
| 1230 | (Fritt konto för maskiner) | No BAS 2026 meaning. Not "Installationer". |
| 1240 | (Fritt konto för maskiner) | No BAS 2026 meaning. Not "Bilar". |
| 1249 | Ack. avskr. (fritt konto för maskiner) | Contra for 1240 |
| 1250 | (Fritt konto för inventarier) | No BAS 2026 meaning. Not "Datorer". |
| 1259 | Ack. avskr. (fritt konto för inventarier) | Contra for 1250 |
| 1260 | (Fritt konto för inventarier) | No BAS 2026 meaning. Not "Leasade tillgångar". |
| 1269 | Ack. avskr. (fritt konto för inventarier) | Contra for 1260 |
| 1280 | Pågående nyanläggningar/förskott | |
| 1290 | Övriga materiella anläggningstillgångar | |
| 1291 | Konst och liknande tillgångar | Not depreciated |
| 1299 | Ack. avskr. övriga materiella | |

**Picking an account.** Ask what the asset is used for, then what it is:

| Asset | För produktion | Ej för produktion |
|---|---|---|
| Vehicle | 1216 Arbetsfordon / 1219 | 1226 Bilar och transportmedel / 1229 |
| Computer | 1214 / 1219 | 1224 / 1229 |
| Byggnads-/markinventarier | 1212 / 1219 | 1222 / 1229 |
| Financial lease | 1217 / 1219 | 1227 / 1229 |

Depreciation expense follows the block, not the kind: **7831** for 121x, **7832**
for 122x (**7836** for leasade tillgångar). 7833/7834 are not BAS accounts.

Assets booked before BAS 2026 keep their stored accounts: an existing car on
1240/1249 or laptop on 1250/1259 is not restated, it just sits on what is now a
free account.

### Impairment Expense (Kontogrupp 77)

| Account | Description |
|---|---|
| 7710 | Nedskrivningar immateriella |
| 7720 | Nedskrivningar byggnader/mark |
| 7730 | Nedskrivningar maskiner/inventarier |
| 7760 | Återföring nedskrivning immateriella |
| 7770 | Återföring nedskrivning byggnader/mark |
| 7780 | Återföring nedskrivning maskiner/inventarier |

### Överavskrivningar (Kontogrupp 21/88)

| Account | Description |
|---|---|
| 2150 | Ackumulerade överavskrivningar |
| 2151 | ...immateriella tillgångar |
| 2152 | ...byggnader |
| 2153 | ...maskiner och inventarier |
| 8850 | Förändring av överavskrivningar |
| 8851 | ...immateriella |
| 8852 | ...byggnader |
| 8853 | ...maskiner och inventarier |

### Disposal Accounts (Kontogrupp 39/79)

| Account | Type | Description |
|---|---|---|
| 3970 | Intäkt | Vinst vid avyttring (övergripande) |
| 3971 | Intäkt | ...immateriella |
| 3972 | Intäkt | ...byggnader/mark |
| 3973 | Intäkt | ...maskiner/inventarier |
| 7970 | Kostnad | Förlust vid avyttring (övergripande) |
| 7971 | Kostnad | ...immateriella |
| 7972 | Kostnad | ...byggnader/mark |
| 7973 | Kostnad | ...maskiner/inventarier |

---

## Anläggningsregister (Fixed Asset Register)

### Legal Basis

BFL 5 kap. 4 § requires subsidiary accounting (sidoordnad bokföring) for fixed assets when needed for satisfactory control. Detailed requirements in **BFNAR 2013:2 chapter 4**.

### Required Data per Asset (BFNAR 2013:2 punkt 4.5)

1. **Identifieringsuppgifter** (serial number, model, description)
2. **Anskaffningsvärde** (acquisition cost)
3. **Anskaffningstidpunkt** (acquisition date)
4. **Beräknat restvärde** (estimated residual value)
5. **Tillämpad avskrivningsmetod** (if non-linear, or note that asset is not depreciated)
6. **Nyttjandeperiod** (useful life)
7. **Ackumulerade avskrivningar** (accumulated depreciation)
8. **Ackumulerade nedskrivningar** (accumulated impairment)
9. **Korrigeringar** (corrections of prior years' depreciation/impairment)
10. **Omklassificeringar** (reclassifications)

### Additional Requirements

- **AB/EF (punkt 4.6):** Must also track uppskrivningar (revaluations)
- **K3 (punkt 4.8):** Must record information per component
- **Grouping (punkt 4.9):** Similar low-value assets acquired simultaneously may be grouped as one entry
- **Disposals (punkt 4.7):** Must note date and proceeds of disposals/scrappings
- **Theft-attractive items (punkt 4.11):** Items expensed as förbrukningsinventarier but stöldbegärliga should still be tracked

### Note Disclosure (ÅRL 5 kap. 8 §, 25 §)

Larger companies must disclose per asset category:
- Opening and closing acquisition values
- Period depreciation, impairment, revaluation
- Acquisitions and disposals during period

---

## Förbrukningsinventarier

### Legal Basis: IL 18 kap. 4 §

Immediate expensing permitted for:

**1. Inventarier av mindre värde** (below half prisbasbelopp):

| Year | Prisbasbelopp | Threshold (half PBB) |
|---|---|---|
| 2024 | 57,300 kr | **28,650 kr** |
| 2025 | 58,800 kr | **29,400 kr** |
| 2026 | 59,200 kr | **29,600 kr** |

Measured excluding deductible VAT.

**2. Korttidsinventarier** (useful life ≤ 3 years, regardless of value).

### Grouping Rule (IL 18 kap. 4 § st. 2)

Items with **naturligt samband** (functional connection) acquired for use together must have combined cost measured against threshold. Example: conference table + chairs = one unit. Items in a larger procurement for similar purposes (e.g., all office computers replaced) evaluated on total cost.

### BAS Accounts for Förbrukningsinventarier (54xx)

| Account | Description |
|---|---|
| 5410 | Förbrukningsinventarier |
| 5411 | Förbrukningsinventarier med > 1 år livslängd |
| 5412 | Förbrukningsinventarier med ≤ 1 år livslängd |
| 5420 | Programvaror |
| 5430 | Transportinventarier |
| 5440 | Förbrukningsemballage |

### Classification Decision

```
Cost < half PBB (excl. deductible VAT)?
├─ YES → Expense to 54xx
└─ NO
   └─ Useful life ≤ 3 years?
      ├─ YES → Expense to 54xx (korttidsinventarie)
      └─ NO → Capitalize to 12xx, depreciate via 78xx
```

**Exception for non-VAT entities:** Threshold effectively rises by the non-deductible VAT amount since cost includes it.