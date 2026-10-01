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
  // Google Ads click id (gclid, or gbraid/wbraid on iPhones).
  gclid?: string
  fbclid?: string
  msclkid?: string
  // The page the visitor first landed on, and the site that sent them there.
  landingPage?: string
  referrer?: string
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
}
