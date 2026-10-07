"use client";

// Competitors → Google rankings, laid out like a rank tracker (Semrush's Position Tracking,
// Ahrefs' Rank Tracker): the Overview (visibility, where we rank, keyword difficulty, the main
// competitors and the easiest keywords to win) and the Keywords table, one row per keyword with
// its difficulty, our best position and who holds #1, opening to every place it was searched from.

import { Fragment, useMemo, useState } from "react";
import { Download, Search } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DIFFICULTY_BANDS,
  difficultyLabel,
  type Analysis,
  type KeywordRow,
  type KeywordSummary,
} from "@/lib/research/serp-analysis";
import { cn } from "@/lib/utils";

const fmt = (n: number) => n.toLocaleString("en-US");
const pct = (n: number) =>
  n > 0 && n < 0.001 ? "<0.1%" : `${(n * 100).toFixed(n >= 0.1 ? 0 : 1)}%`;
const PAGE = 50;

const BAND_STYLE: Record<string, string> = {
  Easy: "bg-emerald-100 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-200",
  Possible: "bg-lime-100 text-lime-900 dark:bg-lime-950 dark:text-lime-200",
  Difficult:
    "bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200",
  Hard: "bg-orange-100 text-orange-900 dark:bg-orange-950 dark:text-orange-200",
  "Very hard": "bg-red-100 text-red-900 dark:bg-red-950 dark:text-red-200",
};
const BAND_BAR: Record<string, string> = {
  Easy: "bg-emerald-500",
  Possible: "bg-lime-500",
  Difficult: "bg-amber-500",
  Hard: "bg-orange-500",
  "Very hard": "bg-red-500",
};

export function Difficulty({ value }: { value: number }) {
  const label = difficultyLabel(value);
  return (
    <span
      className={cn(
        "inline-flex min-w-[4.5rem] items-center justify-between gap-1.5 rounded-md px-1.5 py-0.5 text-xs font-medium",
        BAND_STYLE[label],
      )}
      title={`Keyword difficulty ${value} of 100: ${label}`}
    >
      <b className="tabular-nums">{value}</b>
      <span className="text-[10px] opacity-80">{label}</span>
    </span>
  );
}

function Position({ value }: { value: number | null }) {
  if (value === null) return <span className="text-muted-foreground">–</span>;
  return (
    <b
      className={cn(
        "tabular-nums",
        value <= 3
          ? "text-emerald-700 dark:text-emerald-400"
          : value <= 10
            ? "text-foreground"
            : "text-muted-foreground",
      )}
    >
      {value}
    </b>
  );
}

function Card({
  title,
  action,
  children,
  className,
}: {
  title: string;
  action?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section
      className={cn(
        "flex flex-col gap-3 rounded-2xl border bg-card p-4 shadow-xs",
        className,
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">{title}</h3>
        {action}
      </div>
      {children}
    </section>
  );
}

function Kpi({
  label,
  value,
  note,
  children,
}: {
  label: string;
  value: React.ReactNode;
  note?: React.ReactNode;
  children?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1 rounded-2xl border bg-card p-4 shadow-xs">
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      <div className="text-2xl font-semibold tabular-nums">{value}</div>
      {children}
      {note && <p className="text-xs text-muted-foreground">{note}</p>}
    </div>
  );
}

// ---- Overview ---------------------------------------------------------------------------------

export function Overview({
  analysis,
  onOpen,
}: {
  analysis: Analysis;
  onOpen: (tab: "sites" | "keywords") => void;
}) {
  const { summary, positions } = analysis;
  const searches = positions.top3 + positions.top10 + positions.none;
  const places = new Set(
    analysis.keywords.filter((k) => !k.err).map((k) => k.loc),
  ).size;
  const avgDifficulty = summary.length
    ? Math.round(summary.reduce((n, k) => n + k.difficulty, 0) / summary.length)
    : 0;
  const bands = DIFFICULTY_BANDS.map((b) => ({
    label: b.label,
    count: summary.filter((k) => difficultyLabel(k.difficulty) === b.label)
      .length,
  }));
  const competitors = analysis.sites
    .filter((s) => !s.directory && !s.outOfState && !s.ours)
    .slice(0, 8);
  const topShare = Math.max(
    analysis.ourShare,
    ...competitors.map((s) => s.share),
    0.0001,
  );
  const ours = analysis.sites.find((s) => s.ours);
  // Easiest wins: keywords we're not in the top 10 for, easiest first, then the busiest.
  const opportunities = summary
    .filter((k) => k.ranked === 0 && k.places > 0)
    .sort(
      (a, b) =>
        a.difficulty - b.difficulty || (b.volume ?? 0) - (a.volume ?? 0),
    )
    .slice(0, 8);
  const winning = summary
    .filter((k) => k.ranked > 0)
    .sort((a, b) => (a.best ?? 99) - (b.best ?? 99));

  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Kpi
          label="Visibility"
          value={pct(analysis.ourShare)}
          note={
            ours
              ? `Our share of the clicks these searches get. In the top 10 for ${fmt(ours.results)} of ${fmt(searches)} searches.`
              : "Our share of the clicks these searches get. Not in the top 10 yet."
          }
        />
        <Kpi
          label="Keywords"
          value={fmt(summary.length)}
          note={`${fmt(searches)} searches from ${fmt(places)} place${places === 1 ? "" : "s"}`}
        />
        <Kpi
          label="Where we rank"
          value={
            <>
              {fmt(positions.top3 + positions.top10)}
              <span className="text-sm font-normal text-muted-foreground">
                {" "}
                / {fmt(searches)} in the top 10
              </span>
            </>
          }
        >
          <div
            className="flex h-2.5 overflow-hidden rounded-full bg-muted"
            aria-hidden
          >
            <div
              className="bg-emerald-500"
              style={{
                width: `${(positions.top3 / Math.max(1, searches)) * 100}%`,
              }}
            />
            <div
              className="bg-sky-500"
              style={{
                width: `${(positions.top10 / Math.max(1, searches)) * 100}%`,
              }}
            />
          </div>
          <p className="flex flex-wrap gap-x-3 text-xs text-muted-foreground">
            <span>
              <span className="mr-1 inline-block size-2 rounded-full bg-emerald-500" />
              Top 3: {fmt(positions.top3)}
            </span>
            <span>
              <span className="mr-1 inline-block size-2 rounded-full bg-sky-500" />
              4–10: {fmt(positions.top10)}
            </span>
            <span>
              <span className="mr-1 inline-block size-2 rounded-full bg-muted-foreground/40" />
              Not in top 10: {fmt(positions.none)}
            </span>
          </p>
        </Kpi>
        <Kpi
          label="Average keyword difficulty"
          value={<Difficulty value={avgDifficulty} />}
        >
          <div
            className="flex h-2.5 overflow-hidden rounded-full bg-muted"
            aria-hidden
          >
            {bands.map((b) => (
              <div
                key={b.label}
                className={BAND_BAR[b.label]}
                style={{
                  width: `${(b.count / Math.max(1, summary.length)) * 100}%`,
                }}
              />
            ))}
          </div>
          <p className="flex flex-wrap gap-x-3 text-xs text-muted-foreground">
            {bands
              .filter((b) => b.count)
              .map((b) => (
                <span key={b.label}>
                  <span
                    className={cn(
                      "mr-1 inline-block size-2 rounded-full",
                      BAND_BAR[b.label],
                    )}
                  />
                  {b.label}: {fmt(b.count)}
                </span>
              ))}
          </p>
        </Kpi>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card
          title="Top competitors"
          action={
            <button
              type="button"
              onClick={() => onOpen("sites")}
              className="text-xs text-primary hover:underline"
            >
              See all
            </button>
          }
        >
          <p className="-mt-2 text-xs text-muted-foreground">
            Cash buyers and other businesses: listing sites, dictionaries,
            brokerages and other states left out.
          </p>
          <ul className="flex flex-col gap-2 text-sm">
            {[
              ...(ours
                ? [
                    {
                      site: ours.site,
                      share: analysis.ourShare,
                      results: ours.results,
                      avg: ours.avg,
                      us: true,
                    },
                  ]
                : []),
              ...competitors.map((s) => ({
                site: s.site,
                share: s.share,
                results: s.results,
                avg: s.avg,
                us: false,
              })),
            ].map((s) => (
              <li key={s.site} className="flex flex-col gap-1">
                <div className="flex items-baseline justify-between gap-2">
                  <span
                    className={cn(
                      "truncate font-medium",
                      s.us && "text-primary",
                    )}
                  >
                    {s.site}
                    {s.us && (
                      <span className="ml-1.5 rounded bg-primary/15 px-1.5 py-0.5 text-[10px] font-semibold">
                        US
                      </span>
                    )}
                  </span>
                  <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                    {pct(s.share)} · top 10 in {fmt(s.results)} · avg{" "}
                    {s.results ? s.avg : "–"}
                  </span>
                </div>
                <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                  <div
                    className={cn(
                      "h-full rounded-full",
                      s.us ? "bg-primary" : "bg-foreground/40",
                    )}
                    style={{ width: `${(s.share / topShare) * 100}%` }}
                  />
                </div>
              </li>
            ))}
            {!competitors.length && (
              <li className="text-xs text-muted-foreground">
                No competitors in these results.
              </li>
            )}
          </ul>
        </Card>

        <Card
          title="Easiest keywords to win"
          action={
            <button
              type="button"
              onClick={() => onOpen("keywords")}
              className="text-xs text-primary hover:underline"
            >
              All keywords
            </button>
          }
        >
          <p className="-mt-2 text-xs text-muted-foreground">
            Where we&apos;re not in the top 10 yet, easiest first.
          </p>
          {opportunities.length ? (
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-muted-foreground">
                <tr>
                  <th className="py-1 font-medium">Keyword</th>
                  <th className="py-1 text-right font-medium">Volume</th>
                  <th className="py-1 pl-3 font-medium">Difficulty</th>
                  <th className="py-1 pl-3 font-medium">Holds #1 most</th>
                </tr>
              </thead>
              <tbody>
                {opportunities.map((k) => (
                  <tr key={k.k} className="border-t">
                    <td className="py-1.5 pr-2 font-medium">{k.k}</td>
                    <td className="py-1.5 text-right tabular-nums">
                      {k.volume === null ? "–" : fmt(k.volume)}
                    </td>
                    <td className="py-1.5 pl-3">
                      <Difficulty value={k.difficulty} />
                    </td>
                    <td className="max-w-40 truncate py-1.5 pl-3 text-xs text-muted-foreground">
                      {k.leader ?? "–"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="text-xs text-muted-foreground">
              We&apos;re in the top 10 for every keyword in this scan.
            </p>
          )}
        </Card>
      </div>

      {winning.length > 0 && (
        <Card title="Where we rank">
          <div className="flex flex-wrap gap-2">
            {winning.map((k) => (
              <span
                key={k.k}
                className="flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs"
              >
                {k.k} <Position value={k.best} />
                <span className="text-muted-foreground">
                  in {k.ranked} of {k.places}
                </span>
              </span>
            ))}
          </div>
        </Card>
      )}

      <p className="text-xs text-muted-foreground">
        Difficulty is DealTrack&apos;s estimate from who holds each top 10:
        listing sites like Zillow and national buyers make a keyword harder,
        California businesses make it easier. 0–29 easy, 30–49 possible, 50–69
        difficult, 70–84 hard, 85+ very hard. Visibility weighs each position by
        the share of clicks it usually gets.
      </p>
    </div>
  );
}

// ---- Keywords ---------------------------------------------------------------------------------

type Sort = "volume" | "easiest" | "hardest" | "ours";

export function KeywordTable({
  analysis,
  compared,
}: {
  analysis: Analysis;
  compared: boolean;
}) {
  const [search, setSearch] = useState("");
  const [band, setBand] = useState("");
  const [show, setShow] = useState<"all" | "ranked" | "missing">("all");
  const [sort, setSort] = useState<Sort>("volume");
  const [open, setOpen] = useState("");
  const [shown, setShown] = useState(PAGE);
  const [hideOutOfState, setHideOutOfState] = useState(true);
  const hasAds = analysis.summary.some((k) => k.ads > 0);
  const away = useMemo(
    () =>
      new Set(analysis.sites.filter((s) => s.outOfState).map((s) => s.site)),
    [analysis.sites],
  );
  const byKeyword = useMemo(() => {
    const m = new Map<string, KeywordRow[]>();
    for (const r of analysis.keywords) m.set(r.k, [...(m.get(r.k) ?? []), r]);
    return m;
  }, [analysis.keywords]);

  const rows = useMemo(() => {
    const terms = search.toLowerCase().split(/\s+/).filter(Boolean);
    const list = analysis.summary.filter(
      (k) =>
        terms.every((t) => k.k.includes(t)) &&
        (!band || difficultyLabel(k.difficulty) === band) &&
        (show === "all" || (show === "ranked" ? k.ranked > 0 : k.ranked === 0)),
    );
    const by: Record<Sort, (a: KeywordSummary, b: KeywordSummary) => number> = {
      volume: (a, b) => (b.volume ?? -1) - (a.volume ?? -1),
      easiest: (a, b) =>
        a.difficulty - b.difficulty || (b.volume ?? -1) - (a.volume ?? -1),
      hardest: (a, b) =>
        b.difficulty - a.difficulty || (b.volume ?? -1) - (a.volume ?? -1),
      ours: (a, b) =>
        (a.best ?? 99) - (b.best ?? 99) || (b.volume ?? -1) - (a.volume ?? -1),
    };
    return [...list].sort((a, b) => by[sort](a, b) || a.k.localeCompare(b.k));
  }, [analysis.summary, search, band, show, sort]);

  const top3 = (r: KeywordRow) =>
    r.top
      .map((site, i) => ({ site, p: i + 1 }))
      .filter((t) => !hideOutOfState || !away.has(t.site))
      .slice(0, 3);
  const cols = 6 + (hasAds ? 1 : 0);

  return (
    <section className="flex flex-col gap-3 rounded-2xl border bg-card p-4 shadow-xs">
      <div className="flex flex-wrap items-center gap-2">
        <label className="flex h-9 min-w-56 flex-1 items-center gap-2 rounded-lg border border-input bg-background px-2.5 text-sm">
          <Search className="size-4 text-muted-foreground" aria-hidden />
          <input
            value={search}
            onChange={(e) => (setSearch(e.target.value), setShown(PAGE))}
            placeholder="Search keywords…"
            aria-label="Search keywords"
            className="w-full bg-transparent outline-none"
          />
        </label>
        <select
          value={show}
          onChange={(e) => (
            setShow(e.target.value as typeof show),
            setShown(PAGE)
          )}
          aria-label="Show"
          className="h-9 rounded-lg border border-input bg-background px-2 text-sm"
        >
          <option value="all">All keywords</option>
          <option value="ranked">We&apos;re in the top 10</option>
          <option value="missing">We&apos;re not in the top 10</option>
        </select>
        <select
          value={band}
          onChange={(e) => (setBand(e.target.value), setShown(PAGE))}
          aria-label="Difficulty"
          className="h-9 rounded-lg border border-input bg-background px-2 text-sm"
        >
          <option value="">Any difficulty</option>
          {DIFFICULTY_BANDS.map((b) => (
            <option key={b.label} value={b.label}>
              {b.label}
            </option>
          ))}
        </select>
        <select
          value={sort}
          onChange={(e) => setSort(e.target.value as Sort)}
          aria-label="Sort by"
          className="h-9 rounded-lg border border-input bg-background px-2 text-sm"
        >
          <option value="volume">Most searched first</option>
          <option value="easiest">Easiest first</option>
          <option value="hardest">Hardest first</option>
          <option value="ours">Our best position first</option>
        </select>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() =>
            downloadCsv(rows.flatMap((k) => byKeyword.get(k.k) ?? []))
          }
        >
          <Download data-icon="inline-start" /> CSV
        </Button>
        <label className="flex items-center gap-1.5 text-xs">
          <input
            type="checkbox"
            checked={hideOutOfState}
            onChange={(e) => setHideOutOfState(e.target.checked)}
          />
          Skip sites from other states
        </label>
        <span className="text-xs text-muted-foreground">
          {fmt(rows.length)} keywords
        </span>
      </div>

      <div className="overflow-x-auto rounded-xl border">
        <table className="w-full min-w-[900px] text-sm">
          <thead className="bg-muted/50 text-left text-xs text-muted-foreground">
            <tr>
              <th className="px-3 py-2 font-medium">Keyword</th>
              <th className="px-3 py-2 text-right font-medium">Volume</th>
              <th
                className="px-3 py-2 font-medium"
                title="How hard the top 10 is to get into, 0 to 100"
              >
                Difficulty
              </th>
              <th
                className="px-3 py-2 text-right font-medium"
                title="Our best position, and in how many of the places searched we're in the top 10"
              >
                Us
              </th>
              <th className="px-3 py-2 font-medium">Holds #1 most</th>
              <th className="px-3 py-2 font-medium">
                Competitors in the top 10
              </th>
              {hasAds && (
                <th className="px-3 py-2 text-right font-medium">Ads seen</th>
              )}
            </tr>
          </thead>
          <tbody>
            {rows.slice(0, shown).map((k) => {
              const isOpen = open === k.k;
              return (
                <Fragment key={k.k}>
                  <tr
                    className={cn(
                      "border-t align-top",
                      isOpen && "bg-muted/30",
                    )}
                  >
                    <td className="px-3 py-2">
                      <button
                        type="button"
                        onClick={() => setOpen(isOpen ? "" : k.k)}
                        aria-expanded={isOpen}
                        className="text-left font-medium hover:text-primary"
                      >
                        {isOpen ? "▾" : "▸"} {k.k}
                      </button>
                      <div className="pl-4 text-xs text-muted-foreground">
                        {k.places} place{k.places === 1 ? "" : "s"}
                      </div>
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {k.volume === null ? (
                        <span className="text-muted-foreground">–</span>
                      ) : (
                        fmt(k.volume)
                      )}
                    </td>
                    <td className="px-3 py-2">
                      <Difficulty value={k.difficulty} />
                    </td>
                    <td className="px-3 py-2 text-right whitespace-nowrap">
                      <Position value={k.best} />
                      {k.ranked > 0 && (
                        <div className="text-xs text-muted-foreground">
                          top 10 in {k.ranked} of {k.places}
                        </div>
                      )}
                    </td>
                    <td className="max-w-48 truncate px-3 py-2 text-xs">
                      {k.leader ? (
                        <>
                          {k.leader}
                          <span className="text-muted-foreground">
                            {" "}
                            · {k.leaderCount}×
                          </span>
                        </>
                      ) : (
                        <span className="text-muted-foreground">–</span>
                      )}
                    </td>
                    <td className="max-w-72 px-3 py-2 text-xs">
                      {k.buyers.length ? (
                        <>
                          {k.buyers.slice(0, 3).join(", ")}
                          {k.buyers.length > 3 && (
                            <span className="text-muted-foreground">
                              {" "}
                              +{k.buyers.length - 3}
                            </span>
                          )}
                        </>
                      ) : (
                        <span className="text-muted-foreground">
                          None: listing sites only
                        </span>
                      )}
                    </td>
                    {hasAds && (
                      <td className="px-3 py-2 text-right tabular-nums">
                        {k.ads ? fmt(k.ads) : "–"}
                      </td>
                    )}
                  </tr>
                  {isOpen && (
                    <tr className="border-t bg-muted/20">
                      <td colSpan={cols} className="px-3 py-2">
                        <div className="max-h-96 overflow-y-auto">
                          <table className="w-full text-xs">
                            <thead className="text-left text-muted-foreground">
                              <tr>
                                <th className="py-1 pr-3 font-medium">From</th>
                                <th className="py-1 pr-3 text-right font-medium">
                                  Volume
                                </th>
                                <th className="py-1 pr-3 text-right font-medium">
                                  Us
                                </th>
                                <th className="py-1 pr-3 font-medium">#1</th>
                                <th className="py-1 pr-3 font-medium">#2</th>
                                <th className="py-1 pr-3 font-medium">#3</th>
                                {hasAds && (
                                  <th className="py-1 font-medium">Ads</th>
                                )}
                              </tr>
                            </thead>
                            <tbody>
                              {[...(byKeyword.get(k.k) ?? [])]
                                .sort(
                                  (a, b) =>
                                    (b.volume ?? -1) - (a.volume ?? -1) ||
                                    a.loc.localeCompare(b.loc),
                                )
                                .map((r) => (
                                  <tr
                                    key={r.loc}
                                    className="border-t border-border/50"
                                  >
                                    <td className="py-1 pr-3">{r.loc}</td>
                                    <td className="py-1 pr-3 text-right tabular-nums">
                                      {r.volume === null ? "–" : fmt(r.volume)}
                                    </td>
                                    <td className="py-1 pr-3 text-right">
                                      {r.err ? (
                                        <span
                                          className="text-amber-700"
                                          title={r.err}
                                        >
                                          failed
                                        </span>
                                      ) : (
                                        <Position value={r.ours} />
                                      )}
                                      {compared &&
                                        r.oursBefore !== undefined &&
                                        r.oursBefore !== r.ours &&
                                        !r.err && (
                                          <span className="ml-1 text-[10px] text-muted-foreground">
                                            (was {r.oursBefore ?? "–"})
                                          </span>
                                        )}
                                    </td>
                                    {[0, 1, 2].map((i) => {
                                      const t = top3(r)[i];
                                      return (
                                        <td
                                          key={i}
                                          className="max-w-40 truncate py-1 pr-3"
                                        >
                                          {t ? (
                                            <>
                                              {hideOutOfState && (
                                                <span className="text-muted-foreground tabular-nums">
                                                  {t.p}.{" "}
                                                </span>
                                              )}
                                              {t.site}
                                            </>
                                          ) : (
                                            "–"
                                          )}
                                        </td>
                                      );
                                    })}
                                    {hasAds && (
                                      <td className="max-w-48 truncate py-1">
                                        {r.ads.join(", ") || "–"}
                                      </td>
                                    )}
                                  </tr>
                                ))}
                            </tbody>
                          </table>
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
      {rows.length > shown && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="self-center"
          onClick={() => setShown(shown + PAGE)}
        >
          Show more ({fmt(rows.length - shown)} left)
        </Button>
      )}
    </section>
  );
}

function downloadCsv(rows: KeywordRow[]) {
  const cell = (v: string | number | null | undefined) => {
    const s = v === null || v === undefined ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const head = [
    "Keyword",
    "From",
    "Volume",
    "Our position",
    ...Array.from({ length: 10 }, (_, i) => `#${i + 1}`),
    "Ads",
  ];
  const lines = rows.map((k) =>
    [
      k.k,
      k.loc,
      k.volume,
      k.ours,
      ...Array.from({ length: 10 }, (_, i) => k.top[i]),
      k.ads.join(" "),
    ]
      .map(cell)
      .join(","),
  );
  const url = URL.createObjectURL(
    new Blob([[head.join(","), ...lines].join("\n")], { type: "text/csv" }),
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = "google-rankings.csv";
  a.click();
  URL.revokeObjectURL(url);
}
