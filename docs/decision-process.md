# The Decision Process

One loop. Everything else is plumbing.

```
FIELD          RELATIONSHIPS        MONEY
photos         agent radar          receipts coded to address
hours          last touch           hours posted to address
materials      gift / text triggers job cost
   \                |                  /
    \               |                 /
     ----------> THE ARTIFACT <-------
                    |
              EXCEPTIONS ONLY
                    |
              JUAN DECIDES
```

A tool earns its subscription only if it puts data into the top row or
consumes the artifact at the bottom. Nothing else gets paid for.

## The five questions the artifact must answer

Every daily pack answers these. If it cannot, the inputs were bad, not the AI.

1. **Who was on site, and does it match the clock?**
   Scheduled vs. appears-in-photos vs. hours claimed.
2. **What changed since yesterday?**
   Five lines. Physical progress, not activity.
3. **What did we buy, and where did it go?**
   Materials received, materials still open, anything that looks missing.
4. **Is payroll safe to run?**
   Pass / hold / question. Hours with no photo coverage is a hold.
5. **What is the next physical action?**
   One line. Tomorrow.

Plus a sixth, when it applies: **anything that belongs on the Agent Radar** —
an agent walked the job, an inspector showed, a neighbor asked who is buying.

## Daily loop (Cherry, ~20 minutes)

1. Arrival photo posted before 10:00 on every live job, or flag the job.
2. Close yesterday's hours. Hours without photo coverage go to hold, not to payroll.
3. Running total on capped crew (`rules/payroll-and-photos.md`).
4. Every receipt coded to an address. No address, it is a leak — log it.
5. Run `prompts/daily-artifact.md` per live property. Save the artifact.
6. Send Juan only the exceptions. Not the artifacts. The exceptions.

## Weekly loop (Friday)

Run `prompts/weekly-pulse.md`. One page to Juan, three numbers:

- cash out on jobs this week
- hours paid
- agents touched

Plus: materials vs. budget by property, hours vs. progress by property, who on
the radar went quiet.

## Artifact naming

Every artifact is dated, named, and findable by a human who was not there.

```
ARTIFACT_820-28th_2026-09-16.md
PULSE_2026-W38.md
RADAR_2026-09-16.csv
```

Photos:

```
820-28th_2026-09-16_0905_arrival_Cesar+2.jpg
820-28th_2026-09-16_1230_midday_drywall-north-wall.jpg
820-28th_2026-09-16_1610_close_covered.jpg
820-28th_2026-09-16_receipt_homedepot_412.jpg
```

The filename is half the artifact. It is what makes the pack searchable a year
from now when someone asks what we actually spent on that house.

## What the process refuses to do

- Motivate. The artifact does not cheerlead.
- Narrate. "Crew worked hard today" is not a line item.
- Hide a missing photo. Missing photos are a payroll risk and get said out loud.
- Invent. If the receipt is not there, the artifact says the receipt is not there.
