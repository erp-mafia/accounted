---
audience: developer
---

# Implementation Patterns for Project Accounting


<!-- toc -->
**Contents**

- [1. Data model](#1-data-model)
- [2. Project lifecycle state machine](#2-project-lifecycle-state-machine)
- [3. WIP calculation logic](#3-wip-calculation-logic)
- [4. Overhead allocation engine](#4-overhead-allocation-engine)
- [5. Profitability reporting](#5-profitability-reporting)
- [6. Time tracking integration](#6-time-tracking-integration)
- [7. Payroll distribution](#7-payroll-distribution)
- [8. Asset register integration](#8-asset-register-integration)
- [9. Period-end procedures](#9-period-end-procedures)
- [10. Validation and error detection](#10-validation-and-error-detection)

<!-- /toc -->

---

## 1. Data model

### Core tables

```sql
-- Project master
CREATE TABLE projects (
  id UUID PRIMARY KEY,
  project_number VARCHAR(20) UNIQUE NOT NULL,  -- matches SIE object_no
  name VARCHAR(200) NOT NULL,
  description TEXT,
  status TEXT CHECK (status IN ('SETUP','ACTIVE','CLOSED','ARCHIVED')) DEFAULT 'SETUP',
  project_type TEXT CHECK (project_type IN (
    'FIXED_PRICE','TIME_MATERIALS','TIME_LIMITED','ONGOING'
  )) NOT NULL,
  revenue_method TEXT CHECK (revenue_method IN (
    'SUCCESSIV_VINSTAVRAKNING','FARDIGSTALLANDEMETODEN','LOPANDE_RAKNING'
  )),
  customer_id UUID REFERENCES customers(id),
  cost_center_id UUID REFERENCES cost_centers(id),
  start_date DATE,
  end_date DATE,
  contract_revenue DECIMAL(15,2),       -- total contract amount (fixed-price)
  budgeted_total_cost DECIMAL(15,2),    -- estimated total cost
  budgeted_hours DECIMAL(10,2),
  is_rd_project BOOLEAN DEFAULT FALSE,  -- for forskningsavdrag tracking
  grant_funded BOOLEAN DEFAULT FALSE,
  reverse_charge_default BOOLEAN DEFAULT FALSE, -- omvänd skattskyldighet
  created_at TIMESTAMPTZ DEFAULT NOW(),
  closed_at TIMESTAMPTZ,
  sie_dimension INTEGER DEFAULT 6       -- SIE dimension number
);

-- Cost centers
CREATE TABLE cost_centers (
  id UUID PRIMARY KEY,
  code VARCHAR(20) UNIQUE NOT NULL,
  name VARCHAR(200) NOT NULL,
  is_active BOOLEAN DEFAULT TRUE,
  sie_dimension INTEGER DEFAULT 1
);

-- Per-account dimension enforcement
CREATE TABLE account_dimension_settings (
  account_number INTEGER NOT NULL,
  dimension_type TEXT CHECK (dimension_type IN ('PROJECT','COST_CENTER')),
  setting TEXT CHECK (setting IN ('ALLOWED','MANDATORY','NOT_ALLOWED')) DEFAULT 'ALLOWED',
  PRIMARY KEY (account_number, dimension_type)
);

-- Journal entry lines with project/cost center
CREATE TABLE journal_entry_lines (
  id UUID PRIMARY KEY,
  journal_entry_id UUID NOT NULL REFERENCES journal_entries(id),
  account_number INTEGER NOT NULL,
  debit DECIMAL(15,2) DEFAULT 0,
  credit DECIMAL(15,2) DEFAULT 0,
  description TEXT,
  project_id UUID REFERENCES projects(id),         -- nullable
  cost_center_id UUID REFERENCES cost_centers(id),  -- nullable
  quantity DECIMAL(10,2),                           -- for SIE quantity field
  CONSTRAINT valid_amount CHECK (
    (debit > 0 AND credit = 0) OR (credit > 0 AND debit = 0) OR (debit = 0 AND credit = 0)
  )
);

-- Project budget lines (per account, per period)
CREATE TABLE project_budgets (
  id UUID PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES projects(id),
  account_number INTEGER NOT NULL,
  period VARCHAR(6) NOT NULL,  -- YYYYMM
  amount DECIMAL(15,2) NOT NULL
);

-- WIP snapshots (calculated at each period close)
CREATE TABLE project_wip_snapshots (
  id UUID PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES projects(id),
  snapshot_date DATE NOT NULL,
  actual_costs_to_date DECIMAL(15,2),
  estimated_remaining_costs DECIMAL(15,2),
  estimated_total_cost DECIMAL(15,2),
  fardigstallandegrad DECIMAL(5,4),  -- 0.0000 to 1.0000
  contract_revenue DECIMAL(15,2),
  upparbetad_intakt DECIMAL(15,2),
  fakturerat_belopp DECIMAL(15,2),
  wip_balance DECIMAL(15,2),         -- 1620 or 2450 amount
  wip_account INTEGER,               -- 1620 or 2450
  befarad_forlust DECIMAL(15,2),
  tax_basis_revenue DECIMAL(15,2),   -- for löpande räkning divergence
  UNIQUE (project_id, snapshot_date)
);

-- Time entries (for integration with time tracking)
CREATE TABLE project_time_entries (
  id UUID PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES projects(id),
  employee_id UUID NOT NULL,
  entry_date DATE NOT NULL,
  hours DECIMAL(6,2) NOT NULL,
  activity_type VARCHAR(50),
  internal_rate DECIMAL(10,2),       -- cost rate
  external_rate DECIMAL(10,2),       -- billing rate
  is_billable BOOLEAN DEFAULT TRUE,
  is_rd_activity BOOLEAN DEFAULT FALSE, -- for forskningsavdrag
  invoiced BOOLEAN DEFAULT FALSE
);
```

### Indexes for project reporting

```sql
CREATE INDEX idx_jel_project ON journal_entry_lines(project_id) WHERE project_id IS NOT NULL;
CREATE INDEX idx_jel_cost_center ON journal_entry_lines(cost_center_id) WHERE cost_center_id IS NOT NULL;
CREATE INDEX idx_jel_account_project ON journal_entry_lines(account_number, project_id);
CREATE INDEX idx_time_project_date ON project_time_entries(project_id, entry_date);
CREATE INDEX idx_wip_project_date ON project_wip_snapshots(project_id, snapshot_date);
```

---

## 2. Project lifecycle state machine

```
SETUP ──────► ACTIVE ──────► CLOSED ──────► ARCHIVED
                │                │
                │                └──► ACTIVE (reopen with elevated permissions)
                │
                └──► CLOSED (skip if zero transactions)
```

### State transitions and validations

**SETUP → ACTIVE**
- Requires: project_number, name, project_type, revenue_method set
- For fixed-price: contract_revenue and budgeted_total_cost must be set
- Enables: transaction booking, time entry, invoicing

**ACTIVE → CLOSED**
- Pre-close checklist (all must pass):
  1. No pending supplier invoices (kontrollera leverantörsskuld per project)
  2. All time entries invoiced or written off
  3. Final WIP adjustment posted (1620/2450/1470 cleared to zero)
  4. Final invoice issued
  5. Moms reported for all invoices
  6. Garantiavsättning booked (if construction project)
  7. Project trial balance: all balance sheet accounts net to zero
  8. Residual periodiseringar cleared (17xx/29xx)
- On transition: record closed_at timestamp, freeze project from new transactions
- Resultatföring: project's accumulated P&L becomes part of company P&L

**CLOSED → ACTIVE (reopen)**
- Requires elevated permissions (admin/revisor role)
- Audit trail entry documenting reason for reopening
- Common reasons: late supplier invoice, warranty claim, grant audit adjustment

**CLOSED → ARCHIVED**
- Read-only, no modifications permitted
- Can be triggered after retention period (typically 7 years per BFL)

---

## 3. WIP calculation logic

### Successiv vinstavräkning (percentage of completion)

```python
def calculate_wip_successiv(project, period_date):
    actual_costs = sum_project_costs(project.id, up_to=period_date)
    estimated_total = project.budgeted_total_cost  # or latest revised estimate
    
    if estimated_total <= 0:
        return None  # cannot calculate
    
    fardigstallandegrad = actual_costs / estimated_total
    fardigstallandegrad = min(fardigstallandegrad, 1.0)  # cap at 100%
    
    upparbetad_intakt = project.contract_revenue * fardigstallandegrad
    fakturerat = sum_project_invoiced(project.id, up_to=period_date)
    
    wip_balance = upparbetad_intakt - fakturerat
    
    # Check for befarad förlust
    befarad_forlust = 0
    if estimated_total > project.contract_revenue:
        befarad_forlust = estimated_total - project.contract_revenue
    
    if wip_balance > 0:
        # Upparbetad > fakturerad: asset on 1620
        return WIPResult(
            account=1620, amount=wip_balance,
            revenue_account=3041, 
            fardigstallandegrad=fardigstallandegrad,
            befarad_forlust=befarad_forlust
        )
    else:
        # Fakturerad > upparbetad: liability on 2450
        return WIPResult(
            account=2450, amount=abs(wip_balance),
            revenue_account=3041,
            fardigstallandegrad=fardigstallandegrad,
            befarad_forlust=befarad_forlust
        )
```

### Alternativregeln (completed contract)

```python
def calculate_wip_alternativ(project, period_date):
    actual_costs = sum_project_costs(project.id, up_to=period_date)
    fakturerat = sum_project_invoiced(project.id, up_to=period_date)
    
    # Capitalize costs as inventory
    # Net position determines balance sheet presentation
    if actual_costs >= fakturerat:
        # Asset: more costs than invoiced
        return WIPResult(
            account=1470, amount=actual_costs,
            contra_account=4970,
            fakturerat_offset=fakturerat  # netted in disclosure
        )
    else:
        # Liability: more invoiced than costs
        net_liability = fakturerat - actual_costs
        return WIPResult(
            account=2430, amount=net_liability,
            asset_account=1470, asset_amount=actual_costs,
            contra_account=4970
        )
```

### Löpande räkning

```python
def calculate_wip_lopande(project, period_date):
    # Revenue = work performed at agreed rates
    time_entries = get_unbilled_time(project.id, up_to=period_date)
    upparbetad = sum(e.hours * e.external_rate for e in time_entries)
    fakturerat = sum_project_invoiced(project.id, up_to=period_date)
    
    wip_balance = upparbetad - fakturerat
    
    # Tax basis: invoiced amounts (IL 17:26; industries per IL 17:23)
    tax_revenue = fakturerat
    accounting_revenue = upparbetad
    
    return WIPResult(
        account=1620 if wip_balance > 0 else 2450,
        amount=abs(wip_balance),
        tax_basis_revenue=tax_revenue,
        accounting_revenue=accounting_revenue,
        tax_difference=accounting_revenue - tax_revenue
    )
```

---

## 4. Overhead allocation engine

```python
def allocate_overhead(period, allocation_key_type, source_cost_center, target_projects):
    """
    Allocate shared costs from a cost center to projects.
    
    allocation_key_type: 'SALARY', 'HOURS', 'REVENUE', 'HEADCOUNT', 'SQMETERS'
    """
    total_overhead = sum_costs(source_cost_center, period, account_range=(5000, 6999))
    
    if allocation_key_type == 'SALARY':
        denominators = {p: sum_salary_costs(p, period) for p in target_projects}
    elif allocation_key_type == 'HOURS':
        denominators = {p: sum_hours(p, period) for p in target_projects}
    elif allocation_key_type == 'REVENUE':
        denominators = {p: sum_revenue(p, period) for p in target_projects}
    
    total_denominator = sum(denominators.values())
    if total_denominator == 0:
        return []  # no basis for allocation
    
    allocations = []
    for project, value in denominators.items():
        share = value / total_denominator
        amount = round(total_overhead * share, 2)
        allocations.append(AllocationEntry(
            source=source_cost_center,
            target_project=project,
            amount=amount,
            key_type=allocation_key_type,
            key_value=value,
            share_pct=share
        ))
    
    # Rounding adjustment: assign remainder to largest project
    allocated_total = sum(a.amount for a in allocations)
    if allocated_total != total_overhead:
        diff = total_overhead - allocated_total
        largest = max(allocations, key=lambda a: a.amount)
        largest.amount += diff
    
    return allocations
```

---

## 5. Profitability reporting

### Projektresultaträkning structure

```
Intäkter
  Fakturerad intäkt (3xxx)
  + Upparbetad ej fakturerad (1620 change)
  - Fakturerad ej upparbetad (2450 change)
  = Nettointäkt

Direkta kostnader
  Personalkostnader (7xxx tagged to project)
  Materialkostnader (4xxx tagged to project)
  Underleverantörer (tagged subcontractor costs)
  Övriga direkta kostnader (5xxx/6xxx tagged to project)
  = Summa direkta kostnader

Täckningsbidrag 1 = Nettointäkt - Direkta kostnader

Indirekta kostnader (allocated overhead)
  OH-påslag personal
  OH-påslag lokaler
  OH-påslag administration
  = Summa indirekta kostnader

Täckningsbidrag 2 = TB1 - Indirekta kostnader

Projektresultat = TB2
```

### Key KPIs

| KPI | Formula | Target |
|-----|---------|--------|
| Debiteringsgrad | Billable hours / Total hours | 65-85% (consulting) |
| Faktisk timpris | Project revenue / Billable hours | > Internal rate × 2.5 |
| Täckningsgrad | TB1 / Nettointäkt | > 50% (consulting), > 15% (construction) |
| Budget adherence | Actual cost / Budgeted cost | < 1.0 |
| Färdigställandegrad | Actual cost / Est. total cost | Should track time-elapsed |
| WIP days | WIP balance / (Revenue / 365) | < 30 days |

### Multi-project dashboard

The engine should support a project overview showing:
- All active projects with status indicators (on track, at risk, over budget)
- Aggregate WIP position (total 1620, total 2450, total 1470)
- Revenue pipeline (contracted but not yet recognized)
- Resource utilization across projects
- Cash flow impact (invoiced vs collected per project)

---

## 6. Time tracking integration

### Rate hierarchy

When calculating project costs from time entries, rates are resolved in priority order:

1. **Customer-specific rate** (override per customer contract)
2. **Project-specific rate** (override per project agreement)
3. **Activity-type rate** (e.g., senior consulting vs. junior)
4. **User role rate** (based on employee level/title)
5. **Default company rate** (fallback)

### Internal cost rate calculation

```
Internal rate = (Årslön + Arbetsgivaravgifter 31.42% + OH-påslag) / Produktiva timmar

Produktiva timmar = Total hours - Semester - Sjukdom - Utbildning - Intern tid
Typically 1,600-1,760 hours/year for full-time employee.
```

### Time entry → cost → WIP → invoice pipeline

```
Time Entry (hours × activity)
    ↓
Cost Calculation (hours × internal rate → project cost)
    ↓
WIP Calculation (upparbetad intäkt = hours × external rate)
    ↓
Invoice Generation (group unbilled entries, create faktura)
    ↓
Revenue Recognition (clear WIP, book revenue + moms)
```

---

## 7. Payroll distribution

### Salary booking with project tags

When employees work on multiple projects, their salary costs must be distributed based on time reports.

Monthly flow:
1. Calculate total bruttolön per employee
2. Get time distribution: percentage per project from time entries
3. Book salary proportionally:

```
Employee A: 50,000 SEK bruttolön, 60% Project X, 40% Project Y

Debet 7010 {6 "X"} 30,000
Debet 7010 {6 "Y"} 20,000
Kredit 2710         50,000
```

4. Arbetsgivaravgifter follow same distribution:

```
Avgifter = 50,000 × 31.42% = 15,710

Debet 7510 {6 "X"} 9,426
Debet 7510 {6 "Y"} 6,284
Kredit 2730         15,710
```

5. Semesterlöneskuld changes (7090/7290) should follow the same proportional distribution. Unallocated vacation liability distorts project profitability.

---

## 8. Asset register integration

### Project as cost collector for assets

Projects serve as cost collectors during development/construction phases. Upon completion:

1. Accumulated qualifying costs transfer from project accounts to anläggningsregister
2. The asset follows normal avskrivning schedules

```
Completion entry:
Debet 1010/1020 (materiell/immateriell tillgång)  500,000
Kredit 1470 {6 "P001"} OR 38xx {6 "P001"}        500,000
```

### K2 vs K3 constraints

- K3: both materiella and immateriella egenupparbetade tillgångar can be activated
- K2: only förvärvade immateriella tillgångar; egenupparbetade must be expensed
- Project-specific tangible assets (e.g., construction equipment bought for a project) follow normal asset rules regardless of K2/K3

---

## 9. Period-end procedures

At each period close, the engine should execute per-project:

1. **Update färdigställandegrad**: recalculate based on latest cost data
2. **Adjust upparbetad intäkt**: book changes to 1620/2450 (successiv vinstavräkning) or 1470/4970 (alternativregeln)
3. **Assess cost accruals**: book upplupna kostnader (2990) for work received but not yet invoiced by suppliers
4. **Review prepaid costs**: verify kontogrupp 17xx items still relate to future project work
5. **Evaluate befarade förluster**: compare estimated total cost to contract revenue; if loss expected, book provision immediately
6. **Calculate tax divergence**: for löpande räkning projects, compute difference between accounting and tax revenue
7. **Run overhead allocation**: distribute shared costs using configured fördelningsnycklar

### Automated checks

The engine should flag:
- Projects where färdigställandegrad > 90% but status is still ACTIVE (prompt for completion review)
- Projects where actual costs > 110% of budget (trigger cost review)
- Projects with no time entries in last 30 days but status ACTIVE (dormant project)
- Projects with 1620/2450/1470 balances but status CLOSED (incomplete closing)
- Projects approaching end_date with significant remaining work

---

## 10. Validation and error detection

### Transaction-level validation

Before saving a journal entry line with a project tag:
1. Verify project status is ACTIVE
2. Check account_dimension_settings: if MANDATORY for this account, project_id must be set
3. Check account_dimension_settings: if NOT_ALLOWED for this account, project_id must be null
4. Verify project's cost_center matches the line's cost_center (if both set and company enforces hierarchy)
5. For construction projects: check reverse_charge flag consistency with VAT account used

### Period-level validation

At period close:
1. **Orphaned costs**: identify transactions on project-mandatory accounts lacking project tags
2. **Closed project entries**: detect transactions booked to closed projects
3. **Balance sheet consistency**: verify 1620+1470 totals match subsidiary project ledger
4. **Cross-project netting**: ensure no netting between projects on 1620/2450/1470 (Srf U 14 violation)
5. **Moms consistency**: verify WIP adjustments (1620/2450 entries) carry no moms amounts
6. **Befarad förlust coverage**: all projects with estimated loss have corresponding provision

### SIE export validation

Before generating SIE4 export:
1. All projects with transactions have corresponding #OBJEKT declarations
2. Object numbers match between #OBJEKT and #TRANS records
3. Multi-year projects carry correct #OIB/#OUB balances
4. Dimension 6 is declared if any project objects exist
5. No transaction line references both a project and a cost center from different organizational units (if hierarchy enforced)

### Common error patterns

1. **Incorrect färdigställandegrad**: over/under-recognition of revenue. Flag projects where completion % diverges >20% from time-elapsed or budget-consumed ratios.
2. **Missing project tags**: orphaned costs. Enforce MANDATORY project code on accounts flagged in dimension settings.
3. **Mixing recognition methods**: without disclosure violates consistency. Lock method per project type at company config level.
4. **Unrecognized befarade förluster**: automatic detection required per K3 23.24 (23.32 under färdigställandemetoden) and K2 6.19/6.23.
5. **Incomplete project closings**: residual balances on 1620/2450/1470. Enforce zero-balance check before CLOSED status.
6. **Missing garantiavsättningar**: common audit finding for construction. Prompt at project close.
7. **VAT-revenue timing mismatch**: booking 1620 entries with moms, or failing to report moms on advance invoices.
