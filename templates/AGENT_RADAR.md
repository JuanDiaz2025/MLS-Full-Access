# Agent Radar — field guide

25 to 50 names. Not the whole BlackBook dump. Names Juan would recognize.

## Status values (only these)

| Status | Means | Next |
|---|---|---|
| `new` | just added, no contact yet | day-0 intro text |
| `warm` | replied at least once | keep cadence |
| `active` | in a live conversation or deal | human owns it |
| `gift_due` | a trigger fired, gift not sent | automation sends |
| `quiet` | no reply 14+ days | one bump, then `cold` |
| `cold` | bumped, still nothing | no automation touches |
| `dnc` | asked us to stop, or compliance flag | nothing, ever |

## Gift triggers (the only ones)

- Showed our listing
- Sent us an off-market
- Toured a property with a buyer that touched us
- Closed something that touched us

Cap: one gift per agent per 90 days. Office address only. Never a public
official, never mid-transaction where it creates a disclosure problem — those
get flagged to a human instead.

## Neighborhoods first

Fill `sf_neighborhoods_actually_worked` from their real closed listings, not
their bio. An agent who says "all of SF" works two neighborhoods. Find which two.

## What makes this different from BlackBook

BlackBook stores contacts. The radar stores **state** — last touch, last listing,
gift date, next auto action. State is what lets a rule fire without a human
remembering. That column set is the entire reason to build this outside
BlackBook.
