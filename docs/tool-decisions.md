# Tool Decisions

Short list on purpose. If a tool is not named here, it does not get a
subscription without Juan saying yes.

## Verdicts

| Tool | Verdict | Job |
|---|---|---|
| Job cards (Jobber or equivalent) | **KEEP — make it the field source of truth** | hours, materials, job photos, job cost, per-property profit |
| QuickBooks + Cherry's coding rules | **KEEP** | book of record; every dollar hits an address |
| REI BlackBook | **FREEZE** | legacy seller archive + drips already running. No new SF workflow built inside it. |
| Agent Radar (sheet, then HubSpot or Follow Up Boss) | **BUILD THIS WEEK** | the new sales brain for San Francisco |
| SMS lane (OpenPhone / SalesMessage / FUB) | **STAGE** | agent texts from a real number, not a personal cell |
| Amazon Business | **STAGE** | gift fulfillment, three saved SKU tiers |
| Make.com or Zapier | **STAGE** | the hands: radar status → text, gift, log |
| AI role skills (this repo) | **KEEP — consolidate** | the brain that turns the rooms into artifacts |
| TV / new media buy | **OFF** | not this week, not at $40k, not before the radar is real |

"Stage" means: set it up, leave the automations switched off until the radar has
been touched by a human for a week.

## The REI BlackBook answer

The honest version: BlackBook is still a real tool. It is not *the* tool.

It was built for wholesaling — lists, dialer minutes, drip texts to sellers. It
does that fine, and the seller pipeline already inside it should finish running.

It was not built for any of the four things we are actually trying to do:
per-property job costing, payroll proof from the field, SF agent relationship
logic, or rule-fired gifts. That mismatch is the "feels old school" feeling. It
is not nostalgia, it is a genuine fit problem.

So: keep it, freeze it, and build the San Francisco business next to it rather
than inside it. Revisit in 90 days. If the seller pipeline inside it is empty by
then, it is a line item to cancel.

## Agent automation — what is actually possible

Both of the things Juan asked about are possible today. Neither needs a human in
the loop once the rule is set.

**Auto text to an agent.** Radar status changes → text fires. Real triggers,
not a drip:

| Trigger | Message | Timing |
|---|---|---|
| Agent added to radar | intro, names the specific neighborhood we buy in | day 0 |
| Agent lists in a neighborhood we buy | the actual street pattern we want, not "checking in" | within 2 hrs |
| We walked or offered on their listing | short follow-up | next morning |
| No reply in 14 days | one bump, then quiet | day 14 |

Use a real SMS lane, keep it A2P compliant, and do not blast the MLS.

**Auto Amazon gift.** Amazon Business account, three saved SKU tiers
($25 / $50 / $100 — coffee, desk, nothing that reads as a bribe), Make or Zapier
watching radar status. Status hits "gift due" → order to the office address →
gift date and tracking log to the contact → text fires: "sent a small thank-you
to the office."

Guardrails, and these matter:

- Gift only on a trigger. Showed our listing, sent an off-market, toured with a
  buyer, closed something that touched us. Not a birthday list.
- Cap one gift per agent per 90 days.
- Office address only, unless they gave you a home address themselves.
- Never a public official, and never anyone mid-transaction where it creates a
  disclosure problem. Flag those to a human. Real estate gift rules vary by
  brokerage and some brokerages ban them outright — check before the first send.
- Both automations stay **off** until the radar list has real last-touch data.
  An automation on a dirty list is how you burn fifty relationships in a day.
