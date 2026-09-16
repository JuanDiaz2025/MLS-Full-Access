# The One Tool

This repo is the operating system for Twin Home Buyer / Equity Track.

It is not software to install. It is the **one decision process** every tool
feeds, and the **artifacts** that come out the other end.

## What we are trying to accomplish

Four things. Everything in this repo exists to serve one of them.

1. **Know, by property, every dollar of materials and every hour of labor.**
   Not "we spent a lot at Home Depot." `820 28th / 2026-09-16 / $412 lumber /
   6.5 hrs Cesar + 1 helper.`
2. **Protect payroll with proof.** A timestamped photo on site is the record.
   No photo, no story. One Photographer A, one Photographer B.
3. **Turn raw field data into artifacts.** Photos + receipts + hours become one
   dated pack per property that Cherry can book, Juan can read in 60 seconds,
   and AI can reason over the next morning.
4. **Treat San Francisco agents like a pipeline, not a Christmas list.** A radar
   of 25-50 names with rules that fire texts and gifts without a human
   remembering.

## Why this exists

We have a lot of tools. REI BlackBook, spreadsheets, a books stack, six AI role
skills, a dozen logins. Every one of them was built for a different job, and
none of them was built for *this* job: physical work on Bay Area properties plus
an agent relationship business in San Francisco.

The fix is not another login. The fix is one process that the tools report into.

## The shape of it

Four rooms, one hallway.

| Room | Owns | Source of truth |
|---|---|---|
| **Field** | hours, materials, photos, job cost | job cards (Jobber or equivalent) |
| **Relationships** | SF agents, legacy sellers | Agent Radar sheet; BlackBook for legacy only |
| **Money** | coding every dollar to an address | QuickBooks + Cherry's rules |
| **Brain** | the daily artifact, the exceptions | this repo's prompts + role skills |

The hallway is the artifact. See `docs/decision-process.md`.

## Map

```
docs/decision-process.md    The one process. Read this first.
docs/tool-decisions.md      Keep / freeze / kill. Including the BlackBook verdict.
docs/roles.md               Which AI role skill answers which question.
rules/payroll-and-photos.md Photo protocol + the 40-hour caps. Non-negotiable.
rules/materials-coding.md   No address, no purchase.
templates/                  The artifacts themselves.
prompts/                    What to hand AI every morning and every Friday.
.claude/skills/             The process as invocable tools.
```

## Start here

- Cherry, every day: `docs/cherry-daily.md` — plain version, the whole job in order
- Cherry, the prompt itself: `prompts/daily-artifact.md`
- Cherry, Friday: `prompts/weekly-pulse.md`
- Juan, this week: `docs/week-of-2026-09-16.md`
