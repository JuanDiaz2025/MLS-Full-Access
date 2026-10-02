// Color themes for the page people see after scanning.
export const qrThemes = [
  { id: "blue", label: "Blue", primary: "#1d4ed8", soft: "#e8eefc" },
  { id: "green", label: "Green", primary: "#15803d", soft: "#e7f5ec" },
  { id: "red", label: "Red", primary: "#b91c1c", soft: "#fbeaea" },
  { id: "charcoal", label: "Charcoal", primary: "#1f2937", soft: "#eef0f3" },
] as const

export type QrThemeId = (typeof qrThemes)[number]["id"]

export function qrTheme(id: string) {
  return qrThemes.find((t) => t.id === id) ?? qrThemes[0]
}

// A QR code on a yard sign, postcard, door hanger or flyer. Scanning it opens a short form;
// sending the form records a lead tagged with where the code was placed.
export type QrCode = {
  id: string
  businessName: string
  // Where the code goes, e.g. "Yard sign, 123 Main St" or "October postcard".
  placement: string
  headline: string
  message: string
  theme: QrThemeId
  active: boolean
  createdAt: string // ISO datetime
}

// Where a website lead came from, as the form sent it (from the WordPress tracking snippet).
export type LeadTracking = {
  utmSource?: string
  utmMedium?: string
  utmCampaign?: string
  utmTerm?: string
  utmContent?: string
  // Google Ads click id. On iPhones Google sends gbraid or wbraid instead (older website
  // scripts also copied those into gclid; see googleClick in tracking.ts).
  gclid?: string
  gbraid?: string
  wbraid?: string
  fbclid?: string
  msclkid?: string
  // The page the visitor first landed on, and the site that sent them there.
  landingPage?: string
  referrer?: string
}

// Where a lead stands with the team. "interested" and "closed" are sent back to Google Ads as
// offline conversions, so Google learns which clicks bring real sellers.
export const leadStatuses = [
  { id: "new", label: "New" },
  { id: "interested", label: "Interested" },
  { id: "appointment", label: "Appointment" },
  { id: "offer", label: "Offer made" },
  { id: "closed", label: "Closed deal" },
  { id: "not_interested", label: "Not interested" },
] as const
export type LeadStatus = (typeof leadStatuses)[number]["id"]

// The two moments Google Ads hears about.
// "invalid" reports a lead you don't want more of to a reporting-only (secondary) action: Google
// never bids for it, but its reports show which campaigns and keywords bring junk.
export type ConversionKind = "interested" | "closed" | "invalid"
export const conversionKinds: ConversionKind[] = ["interested", "closed", "invalid"]
export type ConversionUpload = {
  state: "pending" | "sent" | "failed" | "skipped"
  // When the lead reached this stage (the conversion's time in Google Ads).
  at: string
  tries?: number
  lastTry?: string
  error?: string
  // How Google can match it: the ad click id, or the lead's email/phone (enhanced conversions).
  matchedBy?: string
  // Held back until a set-up step is done: a Google permission, or the Data Manager API turned on.
  waitingFor?: "permission" | "api"
  // The value sent with it (1 when not set), and the Google Ads rule that queued it, if one did.
  value?: number
  rule?: string
  // What it was sent as: the id Google knows it by and the conversion action it went to, so it
  // can be taken back later.
  transactionId?: string
  action?: string
  // Google's id for the upload, and what Google decided once it had checked it.
  requestId?: string
  google?: { status: "processing" | "accepted" | "rejected"; reason?: string; checkedAt: string }
  // Taking it back from Google Ads (a retraction), when the lead turned out Not interested.
  retraction?: { state: "pending" | "sent" | "failed"; at: string; tries?: number; lastTry?: string; error?: string }
  // Sent once more after a "not found" refusal, when the app learned to send to the owning account.
  fixRetry?: boolean
  // Retried once after DealTrack learned to use its existing conversion action when Google said the name was taken.
  nameRetry?: boolean
  // The Google Ads account it last failed in, and how often it was tried again after the account changed.
  accountId?: string
  accountResets?: number
}

// How good a lead looks the moment it arrives, scored by the app (scoring.ts).
export type LeadGrade = "hot" | "warm" | "cold" | "junk"
export type LeadScore = {
  value: number // 0-100
  grade: LeadGrade
  // Why, in plain words: "+25 Real phone number", "-30 Message has links (often spam)"...
  reasons: string[]
  // Couldn't be scored (its fields weren't recognized): never given a status automatically.
  unscored?: boolean
}

export type Lead = {
  id: string
  // Set for leads from a QR code form. Website leads have `source` instead.
  qrCodeId?: string
  // Where a lead came from when it wasn't a QR code, e.g. "Website · Cash offer form".
  source?: string
  createdAt: string // ISO datetime
  name: string
  phone?: string
  email?: string
  propertyAddress?: string
  notes?: string
  tracking?: LeadTracking
  // Set for leads picked up from the WordPress Lead Saver plugin ("wp:<site>:<id>"), so none is added twice.
  inboxId?: string
  status?: LeadStatus
  statusChangedAt?: string
  // "auto" when the app set the status from the lead's score; anything you set yourself wins.
  statusBy?: "auto" | "you"
  // Set when an old lead rule set the status (rules now only decide what Google Ads hears).
  statusRule?: string
  // A Google Ads rule said not to send this lead (setting a status yourself still sends it).
  googleBlockedBy?: string
  score?: LeadScore
  conversions?: Partial<Record<ConversionKind, ConversionUpload>>
}
