// What an ad text edit changes: removed lines struck through, new lines in green, pin moves, and
// (folded away) the full text before and after. Used on the request card, in the Compliance
// history, and on the campaign page.

import { adTextDiff, shownText, type AdLine, type AdTextSet } from "@/lib/ad-text"
import type { ChangeRequest } from "@/lib/store"

const pin = (l: AdLine) => (l.pinned ? ` (pin ${l.pinned.replace(/\D/g, "")})` : "")

function Part({ title, d, total }: { title: string; d: ReturnType<typeof adTextDiff>["headlines"]; total: number }) {
  if (!d.removed.length && !d.added.length && !d.repinned.length) return null
  return (
    <div className="flex flex-col gap-1">
      <p className="text-xs font-medium text-muted-foreground">
        {title}: {d.kept} kept, {d.removed.length} removed, {d.added.length} added ({total} after)
      </p>
      <ul className="flex flex-col gap-0.5 text-[13px]">
        {d.removed.map((l) => (
          <li key={`-${l.text}`} className="text-red-800 line-through decoration-red-400">
            − {shownText(l.text)}
            {pin(l)}
          </li>
        ))}
        {d.added.map((l) => (
          <li key={`+${l.text}`} className="text-emerald-800">
            + {shownText(l.text)}
            {pin(l)}
          </li>
        ))}
        {d.repinned.map((l) => (
          <li key={`~${l.text}`} className="text-amber-800">
            ~ {shownText(l.text)}: {l.pinned ? `pinned to ${l.pinned.replace(/\D/g, "")}` : "unpinned"}
          </li>
        ))}
      </ul>
    </div>
  )
}

function FullText({ title, set }: { title: string; set: AdTextSet }) {
  return (
    <div className="flex flex-col gap-1">
      <p className="text-xs font-semibold">{title}</p>
      <ol className="list-decimal pl-5 text-xs">
        {set.headlines.map((l, i) => (
          <li key={`h${i}`}>
            {shownText(l.text)}
            {pin(l)}
          </li>
        ))}
      </ol>
      <ol className="list-decimal pl-5 text-xs text-muted-foreground">
        {set.descriptions.map((l, i) => (
          <li key={`d${i}`}>
            {shownText(l.text)}
            {pin(l)}
          </li>
        ))}
      </ol>
    </div>
  )
}

export default function AdDiff({ ad }: { ad: NonNullable<ChangeRequest["ad"]> }) {
  const diff = adTextDiff(ad.before, ad.after)
  return (
    <div className="mt-1 flex flex-col gap-2 rounded-xl border bg-muted/30 p-3">
      <p className="text-xs text-muted-foreground">Ad group {ad.adGroup}</p>
      <Part title="Headlines" d={diff.headlines} total={ad.after.headlines.length} />
      <Part title="Descriptions" d={diff.descriptions} total={ad.after.descriptions.length} />
      <details className="group/full text-xs">
        <summary className="cursor-pointer list-none font-medium text-primary hover:underline">
          <span className="group-open/full:hidden">Show the full text before and after</span>
          <span className="hidden group-open/full:inline">Hide the full text</span>
        </summary>
        <div className="mt-2 grid gap-3 sm:grid-cols-2">
          <FullText title="Before" set={ad.before} />
          <FullText title="After" set={ad.after} />
        </div>
      </details>
    </div>
  )
}

// A folded "What changed" for lists and tables.
export function AdChangeDetails({ ad }: { ad: NonNullable<ChangeRequest["ad"]> }) {
  return (
    <details className="group/changes mt-1">
      <summary className="cursor-pointer list-none text-xs font-medium text-primary hover:underline">
        <span className="group-open/changes:hidden">What changed ▸</span>
        <span className="hidden group-open/changes:inline">Hide ▾</span>
      </summary>
      <AdDiff ad={ad} />
    </details>
  )
}
