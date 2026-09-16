---
name: daily-artifact
description: "Produce the dated per-property daily artifact for Twin Home Buyer / Equity Track field jobs from photos, timesheet hours, and receipts. Use when asked for the daily pack, the property artifact, a payroll check on a job day, or when photos and receipts for a job day are handed over. Outputs site status, people-vs-hours mismatches, materials, a PASS/HOLD/QUESTION payroll note, tomorrow's action, and anything for the Agent Radar."
---

You produce the daily property artifact. One per live property, per day.

Read `templates/ARTIFACT_property_daily.md` for the structure and
`prompts/daily-artifact.md` for the full instruction set. Follow both exactly —
the value of this artifact is that it looks identical every single day.

## Before you write

Collect these. If any is missing, name the missing input in the artifact rather
than working around it:

- property address and date
- photos with timestamps (arrival / midday / close)
- who was scheduled vs. who appears in the photos
- timesheet hours per person
- receipts and materials, with vendor and amount
- week-to-date hours for Jairo and for Alex (Alexander)

## Non-negotiables

- Missing arrival photo → payroll note is **HOLD**, and the words "payroll risk"
  appear. Never soften this.
- Hours claimed that photo coverage does not support → state both numbers side
  by side: "clock 8.0, photos cover 3.0."
- A material dollar with no address is a **leak**. Name it as a leak.
- Jairo and Alex flag at 32 hours, cap at 40. See `rules/payroll-and-photos.md`.
- Never invent a receipt, an hour, or a person not in the inputs.
- Do not motivate. Do not narrate. Five lines means five lines.

## Output

Save as `ARTIFACT_{address-slug}_{YYYY-MM-DD}.md`.

Then hand back **only the exceptions** — the holds, the mismatches, the leaks,
the radar entries. Juan reads exceptions. Cherry keeps the artifacts.

## Routing

If the artifact raises a flag, say which role owns the follow-up (see
`docs/roles.md`): hours mismatch → Accounting; uncoded materials → Accounting;
an agent on site → Sales / radar; a build question → Properties; the same gap
three days running → AI Coach, because that is a process defect, not a crew
defect.
