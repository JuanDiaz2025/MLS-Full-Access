import { readFile } from "node:fs/promises"
import path from "node:path"

import { headers } from "next/headers"
import { CircleAlert, CircleCheck, Download, Globe, TriangleAlert } from "lucide-react"

import CopyButton from "@/components/copy-button"
import WordPressForm from "@/components/leads/wordpress-form"
import { buttonVariants } from "@/components/ui/button"
import Disclosure from "@/components/ui/disclosure"
import { tunnelUrl, webhookSecret } from "@/lib/leads/webhook"
import { recentAttempts, type WebhookAttempt } from "@/lib/leads/webhook-log"
import { CF7_HIDDEN_FIELDS, TRACKING_SNIPPET } from "@/lib/leads/wordpress-snippets"
import { getWordPress, type SiteEvent } from "@/lib/leads/wordpress"
import { PLUGIN_VERSION } from "@/lib/leads/wordpress-plugin"
import { timeAgo } from "@/lib/leads/time"
import { DATA_DIR } from "@/lib/store"
import { cn } from "@/lib/utils"

// Google Ads fills in {campaignid}, {keyword} and {creative} for each click.
const FINAL_URL_SUFFIX = "utm_source=google&utm_medium=cpc&utm_campaign={campaignid}&utm_term={keyword}&utm_content={creative}"

const LOCAL = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/

function describe(a: WebhookAttempt) {
  if (a.result === "lead") return `Lead received: ${a.lead ?? "website lead"}`
  if (a.result === "test") return "Connection test: OK"
  if (a.result === "unrecognized") {
    return `Lead saved as "Website lead", but its name, phone and email weren't recognized: check its notes. The form sent: ${a.fields?.join(", ") || "no fields"}.`
  }
  if (a.result === "wrong-key") return "Turned away: the key in the address was wrong or missing. Copy the address above again."
  return `Turned away: no name, phone or email found. The form sent: ${a.fields?.length ? a.fields.join(", ") : "no fields"}.`
}

// Whether the old Google Sheet inbox (removed) was set up here: its leads no longer come in.
async function oldSheetInbox() {
  try {
    const state = JSON.parse(await readFile(path.join(DATA_DIR, "lead-inbox.json"), "utf8")) as { url?: string }
    return Boolean(state.url)
  } catch {
    return false
  }
}

// What happened to a form submission on the site, in plain words.
const outcome: Record<string, string> = {
  mail_sent: "Sent normally",
  mail_failed: "Accepted, but your site couldn't send its email (the lead is still saved)",
  spam: "Blocked as spam by Contact Form 7 (usually reCAPTCHA). Saved anyway and marked, so check it",
  aborted: "Stopped by another plugin before its email went out. Saved anyway",
  validation_failed: "Not sent: a required field was empty or wrong",
  acceptance_missing: "Not sent: the consent box wasn't ticked",
}
const describeEvent = (e: SiteEvent) => outcome[e.status] ?? (e.status || "Unknown")
const badEvent = (e: SiteEvent) => e.status === "spam" || e.status === "aborted" || e.status === "mail_failed"

// Connecting the WordPress site: the Lead Saver plugin keeps every Contact Form 7 lead on the site,
// and the app picks them up. Below that, the lead log, UTM tracking set-up, and the older instant
// webhook for anyone who wants it. Starts open until the site is connected and a lead has come in.
export default async function WebhookSetup({ websiteLeads }: { websiteLeads: number }) {
  const h = await headers()
  const configured = process.env.SITE_URL?.replace(/\/$/, "")
  const tunnel = configured ? null : await tunnelUrl()
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "localhost:3000"
  const origin = configured || tunnel || `${h.get("x-forwarded-proto") ?? "http"}://${host}`
  const url = `${origin}/api/leads/webhook?key=${encodeURIComponent(await webhookSecret())}`
  const localOnly = !configured && !tunnel && LOCAL.test(host)
  const attempts = await recentAttempts()
  const wp = await getWordPress()
  const connected = Boolean(wp.site && wp.lastSync && !wp.lastError)
  const siteName = wp.site?.replace(/^https?:\/\//, "")
  const usedSheet = await oldSheetInbox()

  return (
    <Disclosure className="group rounded-2xl border bg-card shadow-xs" initialOpen={!connected || websiteLeads === 0 || usedSheet}>
      <summary className="flex cursor-pointer list-none items-center gap-3 p-5 sm:px-6">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
          <Globe className="size-5" />
        </span>
        <span className="flex flex-col">
          <span className="text-lg font-semibold">Website leads (WordPress)</span>
          <span className={cn("text-sm", wp.lastError ? "font-medium text-destructive" : "text-muted-foreground")}>
            {wp.lastError
              ? `Problem reaching ${siteName}. Click to see why.`
              : connected
                ? `Connected to ${siteName}. ${websiteLeads} lead${websiteLeads === 1 ? "" : "s"} from the website so far.`
                : "Connect your website so every form lead comes in here."}
          </span>
        </span>
      </summary>
      <div className="flex flex-col gap-5 border-t px-5 py-5 text-sm sm:px-6">
        {usedSheet && (
          <p className="flex gap-2 rounded-xl border-2 border-amber-500/50 bg-amber-500/10 p-4 font-medium text-amber-950">
            <TriangleAlert className="mt-0.5 size-5 shrink-0 text-amber-600" />
            <span>
              The Google Sheet lead inbox you set up before isn&apos;t used any more, so leads sent to it don&apos;t come in here.
              Set up the Lead Saver below, then in Contact Form 7&apos;s <strong>Webhook</strong> tab remove the Google Sheet
              address. Check the Sheet for any leads sent since the update.
            </span>
          </p>
        )}
        <section
          className={cn(
            "flex flex-col gap-3 rounded-xl border-2 p-4",
            connected ? "border-emerald-500/40 bg-emerald-500/5" : wp.lastError ? "border-destructive/40 bg-destructive/5" : "border-primary/40 bg-primary/5",
          )}
        >
          <div>
            <p className="text-base font-semibold">
              {connected ? `Connected to ${siteName}` : "Connect your WordPress site (Contact Form 7)"}
            </p>
            <p className="text-muted-foreground">
              A small plugin on your site saves every Contact Form 7 lead in WordPress itself. The app picks them up every 30
              seconds while it&apos;s open, so leads sent while this computer was off still show up here, with the time they
              were really sent. No Google Sheet, no go-online window, and the address never changes.
            </p>
          </div>

          {wp.site && (
            <p className={cn("flex gap-2", wp.lastError ? "font-medium text-destructive" : "text-emerald-800")}>
              {wp.lastError ? <CircleAlert className="mt-0.5 size-4 shrink-0" /> : <CircleCheck className="mt-0.5 size-4 shrink-0 text-emerald-600" />}
              <span>
                {wp.lastError
                  ? wp.lastError
                  : wp.lastSync
                    ? `Checked ${timeAgo(wp.lastSync)}. ${wp.saved ?? 0} lead${wp.saved === 1 ? "" : "s"} saved on your site so far.`
                    : "Not checked yet."}
              </span>
            </p>
          )}

          {wp.site && wp.events && wp.events.length > 0 && (
            <div className="flex flex-col gap-1.5 rounded-lg border bg-card p-3">
              <p className="font-medium">Forms sent on your site lately</p>
              <ul className="flex flex-col gap-1">
                {wp.events.slice(0, 8).map((e, i) => (
                  <li key={`${e.at}-${i}`} className="flex items-start gap-2">
                    {badEvent(e) ? (
                      <TriangleAlert className="mt-0.5 size-4 shrink-0 text-amber-600" />
                    ) : e.saved ? (
                      <CircleCheck className="mt-0.5 size-4 shrink-0 text-emerald-600" />
                    ) : (
                      <CircleAlert className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                    )}
                    <span className={cn(badEvent(e) && "font-medium text-amber-900")}>
                      <span className="text-muted-foreground">
                        {timeAgo(e.at)}
                        {e.form ? ` · ${e.form}` : ""} ·{" "}
                      </span>
                      {describeEvent(e)}
                    </span>
                  </li>
                ))}
              </ul>
              {wp.events.some((e) => e.status === "spam") && (
                <p className="text-amber-900">
                  If real people are being blocked as spam, check reCAPTCHA in WordPress (<strong>Contact → Integration</strong>):
                  the keys must be for reCAPTCHA v3 and for your site&apos;s address. Their leads are still saved and show up here.
                </p>
              )}
            </div>
          )}

          {connected && wp.plugin && wp.plugin !== PLUGIN_VERSION && (
            <p className="flex gap-2 rounded-lg border-2 border-amber-500/50 bg-amber-500/10 p-3 font-medium text-amber-950">
              <TriangleAlert className="mt-0.5 size-4 shrink-0 text-amber-600" />
              <span>
                A newer Lead Saver plugin is ready (version {PLUGIN_VERSION}; your site has {wp.plugin}). Download it below and
                upload it the same way; when WordPress asks, click <strong>Replace current with uploaded</strong>.
              </span>
            </p>
          )}

          <Disclosure className="rounded-lg border bg-card p-3" initialOpen={!connected}>
            <summary className="cursor-pointer font-medium">{connected ? "Set-up steps" : "Set it up (about 3 minutes, once)"}</summary>
            <ol className="mt-2 list-decimal space-y-3 pl-5 text-muted-foreground">
              <li>
                <a href="/leads/wordpress-plugin" download className={buttonVariants({ size: "lg", className: "h-auto min-h-11 max-w-full px-5 py-2 whitespace-normal" })}>
                  <Download data-icon="inline-start" />
                  Download the Lead Saver plugin
                </a>
                <p className="mt-1">
                  This plugin is made for you by this app, so you won&apos;t find it by searching in WordPress: you upload the
                  file instead. It has your private key inside, so don&apos;t share it.
                </p>
              </li>
              <li>
                In WordPress, open <strong>Plugins → Add New Plugin</strong> and click the <strong>Upload Plugin</strong> button at the
                top (don&apos;t search). Choose the file you just downloaded
                (<code className="font-mono">omcc-lead-saver.zip</code>), click <strong>Install Now</strong>, then{" "}
                <strong>Activate</strong>.
              </li>
              <li>Type your website&apos;s address below and click <strong>Connect</strong>.</li>
              <li>
                Send a test lead from your form. It shows up in the leads list within 30 seconds. In WordPress you can also see
                every saved lead under <strong>Contact → Command Center leads</strong>.
              </li>
              <li>
                Already set up <strong>CF7 to Webhook</strong>? It isn&apos;t needed any more; you can turn it off. If you keep it,
                a lead still only shows up once.
              </li>
            </ol>
          </Disclosure>
          <WordPressForm current={wp.site} />
        </section>

        <div className="flex flex-col gap-2">
          <p className="font-medium">What came in lately</p>
          {attempts.length ? (
            <ul className="flex flex-col gap-1.5">
              {attempts.map((a, i) => (
                <li key={`${a.at}-${i}`} className="flex items-start gap-2">
                  {a.ok ? (
                    <CircleCheck className="mt-0.5 size-4 shrink-0 text-emerald-600" />
                  ) : (
                    <CircleAlert className="mt-0.5 size-4 shrink-0 text-destructive" />
                  )}
                  <span className={cn(!a.ok && "text-destructive")}>
                    <span className="text-muted-foreground">{timeAgo(a.at)} · </span>
                    {describe(a)}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-muted-foreground">
              Nothing yet. After connecting, send a test lead from your form; it shows up here within 30 seconds.
            </p>
          )}
        </div>

        <div className="flex flex-col gap-2">
          <p className="font-medium">Track where each lead came from (UTM source, campaign, keyword, Google click)</p>
          <p className="flex gap-2 rounded-xl bg-emerald-500/10 p-3 text-emerald-900">
            <CircleCheck className="mt-0.5 size-4 shrink-0 text-emerald-600" />
            <span>
              Built into the Lead Saver plugin: it adds the tracking to every page and every Contact Form 7 form by itself.
              Nothing to paste. No WPCode, no hidden fields to add. (Already pasted them? That&apos;s fine; you can leave them
              or remove them.)
            </span>
          </p>
          <ol className="list-decimal space-y-3 pl-5 text-muted-foreground">
            <li>
              In Google Ads, make sure <strong>Admin → Account settings → Auto-tagging</strong> is on (it adds the Google
              click ID). To also fill UTM columns for ad clicks, set{" "}
              <strong>Admin → Account settings → Tracking → Final URL suffix</strong> to:
              <pre className="mt-2 overflow-x-auto rounded-lg bg-muted px-3 py-2 font-mono text-xs text-foreground">{FINAL_URL_SUFFIX}</pre>
              <div className="mt-2">
                <CopyButton text={FINAL_URL_SUFFIX} label="Copy URL suffix" />
              </div>
            </li>
            <li>For other links (Facebook, email, postcards with a web address), add your own ?utm_source=…&amp;utm_medium=… tags.</li>
          </ol>
        </div>

        <Disclosure className="rounded-xl border p-4" initialOpen={false}>
          <summary className="cursor-pointer font-medium">Other way (advanced): an instant webhook straight to this computer</summary>
          <div className="mt-3 flex flex-col gap-5">
            <p className="text-muted-foreground">
              Not needed with the Lead Saver plugin. A webhook only works while the app is running and reachable from the
              internet, and leads sent at other times are lost. It&apos;s here for other form plugins.
            </p>
            {localOnly && (
              <div className="flex gap-2 rounded-xl border-2 border-amber-500/50 bg-amber-500/10 p-4 text-amber-950">
                <TriangleAlert className="mt-0.5 size-5 shrink-0 text-amber-600" />
                <div className="flex flex-col gap-2">
                  <p className="font-semibold">
                    WordPress can&apos;t reach this address yet: &ldquo;localhost&rdquo; means this computer, and
                    your website runs somewhere else.
                  </p>
                  <ol className="list-decimal space-y-1 pl-5">
                    <li>
                      Keep the app running, open the app folder, and double-click <strong>go-online.bat</strong>.
                    </li>
                    <li>
                      It gives the app a public address, and shows and copies the full webhook address (it starts
                      with <code className="font-mono">https://</code> and ends in <code className="font-mono">trycloudflare.com/…</code>).
                    </li>
                    <li>Paste that into WordPress instead of the localhost address, save, and submit a test lead.</li>
                  </ol>
                  <p className="text-amber-900/80">
                    Leads arrive while that window and the app are running. The address changes each time you
                    start go-online.bat, so paste the new one into WordPress each time. To stop that, the app can be
                    put online for good; the README explains how.
                  </p>
                </div>
              </div>
            )}

            {tunnel && (
              <p className="flex gap-2 rounded-xl bg-emerald-500/10 p-3 text-emerald-900">
                <CircleCheck className="mt-0.5 size-4 shrink-0 text-emerald-600" />
                <span>
                  Online through go-online.bat. This address works while its window is open, and changes the next
                  time you run it: paste the new one into WordPress then.
                </span>
              </p>
            )}

            <div className="flex flex-col gap-2">
              <p className="font-medium">
                Webhook address
              </p>
              <code className="block rounded-lg bg-muted px-3 py-2 font-mono text-xs break-all">{url}</code>
              <div>
                <CopyButton text={url} label="Copy webhook address" />
              </div>
              <p className="text-muted-foreground">
                The part after <code className="font-mono">key=</code> is the secret that keeps others from sending fake leads.
                Treat it like a password.
              </p>
            </div>

            <div className="flex flex-col gap-1">
              <p className="font-medium">Contact Form 7 with the CF7 to Webhook plugin</p>
              <ol className="list-decimal space-y-1 pl-5 text-muted-foreground">
                <li>
                  In WordPress, open <strong>Plugins → Add New</strong>, search for <strong>CF7 to Webhook</strong>,
                  then install and activate it.
                </li>
                <li>
                  Open <strong>Contact → Contact Forms</strong>, edit your form, and open its new <strong>Webhook</strong> tab.
                </li>
                <li>Tick the box to send to a webhook, paste the webhook address, and save.</li>
                <li>
                  Keep the usual field names (<code className="font-mono">your-name</code>,{" "}
                  <code className="font-mono">your-email</code>, <code className="font-mono">your-phone</code>,{" "}
                  <code className="font-mono">your-message</code>; address fields named address). Other fields go into the
                  lead&apos;s notes.
                </li>
              </ol>
            </div>

            <div className="flex flex-col gap-1">
              <p className="font-medium">Other form plugins</p>
              <ol className="list-decimal space-y-1 pl-5 text-muted-foreground">
                <li>Elementor: the form&apos;s Actions After Submit → Webhook. WPForms or Gravity Forms: their webhook add-on.</li>
                <li>Paste the webhook address, method POST. JSON or a regular form post both work.</li>
                <li>Send name (or first and last name), phone, email, property address and message.</li>
              </ol>
            </div>

            <div className="flex flex-col gap-2">
              <p className="font-medium">Tracking without the Lead Saver plugin</p>
              <ol className="list-decimal space-y-3 pl-5 text-muted-foreground">
                <li>
                  <span>
                    In Contact Form 7, edit your form and paste these hidden fields anywhere in the <strong>Form</strong> tab,
                    then save. Visitors don&apos;t see them.
                  </span>
                  <pre className="mt-2 overflow-x-auto rounded-lg bg-muted px-3 py-2 font-mono text-xs text-foreground">{CF7_HIDDEN_FIELDS}</pre>
                  <div className="mt-2">
                    <CopyButton text={CF7_HIDDEN_FIELDS} label="Copy hidden fields" />
                  </div>
                </li>
                <li>
                  <span>
                    Add this snippet to every page of the site: install the free <strong>WPCode</strong> plugin, open{" "}
                    <strong>Code Snippets → Header &amp; Footer</strong>, paste it into <strong>Footer</strong>, and save. It
                    remembers the UTM tags and Google click ID from the ad a visitor came in on, even if they browse other
                    pages first, and fills in the hidden fields.
                  </span>
                  <pre className="mt-2 max-h-40 overflow-auto rounded-lg bg-muted px-3 py-2 font-mono text-xs text-foreground">{TRACKING_SNIPPET}</pre>
                  <div className="mt-2">
                    <CopyButton text={TRACKING_SNIPPET} label="Copy tracking snippet" />
                  </div>
                </li>
              </ol>
            </div>
          </div>
        </Disclosure>
      </div>
    </Disclosure>
  )
}
