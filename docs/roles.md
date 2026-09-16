# Roles — Which Brain Answers Which Question

We already built six AI roles. They were sprawling because nothing said when to
use which. This is that.

| Role skill | Owns | Ask it |
|---|---|---|
| **Chief of Staff** (`general-ceo-role-instructions`) | coordination, weekly pulse, priorities | "What matters most right now? What is blocking revenue? Who owns this?" |
| **Accounting** (`accounting`) | reconciliation, cash flow, KPIs | "Cash out by property this week. What did not code to an address?" |
| **Properties** (`properties-role-instructions`) | comps, ARV, zoning, permits, rehab plans | "What is the rehab plan and the number on 820 28th?" |
| **Sales** (`sales`) | scripts, campaigns, cash offers, close rates | "Write the agent outreach for the Noe Valley pattern." |
| **AI Coach** (`ai-coach-role-instructions`) | workflow audits, new prompts, automations | "What in this week's process should be automated?" |
| **HomeScout** (`homescout`) | visual lead screening from Maps / Street View | "Screen these 40 leads. Keep yes / no / manual." |

## The routing rule

The **artifact** is produced by the daily prompt, not by a role. Roles get
invoked on the **exceptions** the artifact surfaces.

```
artifact says "hours 8.0, photos cover 3.0"   → Accounting + Juan
artifact says "materials $412 uncoded"        → Accounting
artifact says "agent walked the job"          → Sales (radar entry)
artifact says "framing done, next is rough-in"→ Properties
three artifacts in a row show the same gap    → AI Coach (fix the process)
Friday                                        → Chief of Staff (pulse)
```

That is the whole consolidation. Six roles stop being six chat windows and
become one process that calls a role when the artifact raises a flag.
