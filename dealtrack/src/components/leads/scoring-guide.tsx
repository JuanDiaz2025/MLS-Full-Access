// How lead scores work, in plain words, for the Leads page, the lead panel and Lead automation.
// The numbers are the ones scoring.ts uses: change them together. Not a client module, so both
// server pages and client components can show it.
import { gradeStyle } from "@/components/leads/grades"
import { HOT_AT, WARM_AT } from "@/lib/leads/score-levels"
import { cn } from "@/lib/utils"

const POINTS: [string, string, string?][] = [
  ["+25", "Real phone number", "−15 if it looks fake or incomplete (555 numbers, 1234567890, too few digits)"],
  ["+20", "Property address with a house number", "+8 for just a street or area"],
  [
    "+15",
    "Motivated seller: their message mentions a reason",
    "Inherited, probate, foreclosure, behind on payments, divorce, repairs, vacant, tenants, relocating, back taxes, urgent…",
  ],
  ["+10", "Email address", "−10 for a throwaway email (Mailinator and the like)"],
  ["+10", "Came from a paid ad click", "A Google click ID, or a paid tag on the link"],
  ["+10", "Searched like a seller", "The keyword or campaign says sell, cash, we buy, fast, as is, offer, foreclosure, inherited…"],
  ["+5", "Full name", "First and last"],
  ["+5", "Came back", "Sent a form before with the same phone or email"],
  ["−30", "Links in the message", "Often spam. Zillow, Redfin, Realtor.com and map links are fine"],
  ["−25", "The website's form flagged it as spam", "Usually reCAPTCHA. Check it: it may be a real person"],
]

const STATUS: [string, string][] = [
  ["Interested", "+15, and at least 50"],
  ["Appointment", "+25, and at least 75 (Hot)"],
  ["Offer made", "+35, and at least 85 (Hot)"],
  ["Closed deal", "100"],
  ["Not interested", "−40, and never Hot"],
]

const Chip = ({ grade }: { grade: keyof typeof gradeStyle }) => (
  <span className={cn("inline-block w-14 shrink-0 rounded-full px-2 py-0.5 text-center text-xs font-semibold", gradeStyle[grade].cls)}>{gradeStyle[grade].label}</span>
)

// How the points add up, what a status does to them, and the leads that aren't scored. Two
// columns only when its box is wide (the Leads page), one in the narrow lead panel.
export function ScorePoints() {
  return (
    <div className="@container flex flex-col gap-4">
      <div>
        <p className="font-medium">How the points add up</p>
        <ul className="mt-1.5 grid gap-x-6 gap-y-2 @2xl:grid-cols-2">
          {POINTS.map(([points, what, more]) => (
            <li key={what} className="flex gap-2">
              <span className={cn("w-9 shrink-0 text-right font-semibold tabular-nums", points.startsWith("−") ? "text-destructive" : "text-emerald-700 dark:text-emerald-400")}>
                {points}
              </span>
              <span>
                {what}
                {more && <span className="block text-xs text-muted-foreground">{more}</span>}
              </span>
            </li>
          ))}
        </ul>
        <p className="mt-2 text-muted-foreground">The total stays between 0 and 100.</p>
      </div>
      <div>
        <p className="font-medium">The status you set changes the score right away</p>
        <ul className="mt-1.5 grid gap-x-6 gap-y-1 @2xl:grid-cols-2">
          {STATUS.map(([status, effect]) => (
            <li key={status}>
              <span className="font-medium">{status}:</span> <span className="text-muted-foreground">{effect}</span>
            </li>
          ))}
        </ul>
        <p className="mt-2 text-muted-foreground">
          New and Unresponsive leave it as it was. Once you mark a lead Interested or further, it&apos;s real: it&apos;s never counted as
          Junk after that.
        </p>
      </div>
      <div>
        <p className="font-medium">Leads that aren&apos;t scored</p>
        <ul className="mt-1.5 list-disc space-y-1 pl-5 text-muted-foreground">
          <li>A tap on the website&apos;s phone number shows 50 (Warm) until you check the call in REI BlackBook and set its status.</li>
          <li>A website lead whose form fields weren&apos;t recognized shows 0: read its message and set its status yourself.</li>
        </ul>
      </div>
    </div>
  )
}

// The whole guide: what the grades mean, how the points add up, and what the score does.
export default function ScoringGuide() {
  return (
    <div className="flex flex-col gap-4 text-sm">
      <p>
        Every lead gets a score from 0 to 100 the moment it arrives, worked out from what it sent: its contact details, the property,
        where it came from and what it wrote. Open a lead to see its own score, point by point.
      </p>
      <div>
        <p className="font-medium">What the grades mean</p>
        <ul className="mt-1.5 flex flex-col gap-2">
          <li className="flex items-start gap-2">
            <Chip grade="hot" />
            <span>
              {HOT_AT} or more, <strong>and</strong> a sign they want to sell: they searched like a seller, or their message gives a
              reason. Good contact details alone stay Warm.
            </span>
          </li>
          <li className="flex items-start gap-2">
            <Chip grade="warm" />
            <span>
              {WARM_AT} to {HOT_AT - 1}.
            </span>
          </li>
          <li className="flex items-start gap-2">
            <Chip grade="cold" />
            <span>Under {WARM_AT}.</span>
          </li>
          <li className="flex items-start gap-2">
            <Chip grade="junk" />
            <span>A test or fake name, an advert (SEO, crypto, loans…), or no real phone number or email. Scored 0.</span>
          </li>
        </ul>
      </div>
      <ScorePoints />
      <div>
        <p className="font-medium">What the score does</p>
        <ul className="mt-1.5 list-disc space-y-1 pl-5 text-muted-foreground">
          <li>It never changes a lead&apos;s status: that&apos;s always yours to set.</li>
          <li>
            With <strong className="text-foreground">Send new leads to Google Ads automatically</strong> on (Lead automation), a Hot lead
            that just came in is sent to Google Ads as a qualified lead, and Junk is reported as an invalid lead (reporting only: Google
            never bids for it). Only leads from the last 24 hours, and never one that couldn&apos;t be scored. An admin can change these
            rules on Lead automation.
          </li>
          <li>
            The status you set always reaches Google Ads too: Interested, Appointment and Offer made send a qualified lead, Closed deal
            sends a closed deal as well, and Not interested takes back what was sent and reports it as an invalid lead.
          </li>
        </ul>
      </div>
    </div>
  )
}
