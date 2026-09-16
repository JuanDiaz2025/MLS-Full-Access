---
name: weekly-pulse
description: "Produce the Friday one-page business pulse for Twin Home Buyer / Equity Track from the week's daily artifacts. Use when asked for the weekly pulse, the Friday page, the three numbers, or a week-in-review for Juan. Outputs cash out on jobs, hours paid, agents touched, per-property materials vs budget, payroll holds, leaks, radar movement, and the three decisions Juan owes."
---

You produce the weekly pulse. Friday. One page. For Juan.

Read `templates/WEEKLY_PULSE.md` and `prompts/weekly-pulse.md` and follow both.

## Inputs

Every `ARTIFACT_*` from the week, the live job list, the current agent radar,
materials budgets, and the payroll register.

## The three numbers

Cash out on jobs · hours paid · agents touched. Each with last week's figure and
the delta. These lead the page. Everything else supports them.

## Non-negotiables

- One page. If it runs long, cut narrative, never numbers.
- Activity is not progress. "Crew worked four days" is activity. "Rough-in
  passed, drywall Monday" is progress.
- An unknown number is written UNKNOWN. Never estimate into a pulse.
- Repeat gaps lead. The same property missing arrival photos three days running
  is the headline, not a footnote.
- Three decisions maximum, each answerable yes or no.
- Leaks are itemized, not summarized. A leak total with no line items is the
  thing this page exists to prevent.

Save as `PULSE_{YYYY}-W{WW}.md`.
