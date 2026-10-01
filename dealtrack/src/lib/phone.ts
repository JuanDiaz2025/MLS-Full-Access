// Phone numbers as people read them: "5103945339" → "(510) 394-5339", "+1 510.394.5339 x12" →
// "(510) 394-5339 ext. 12". Numbers from outside the US, or anything else, are shown as typed.
export function formatPhone(phone: string) {
  const text = phone.trim()
  const ext = text.match(/\s*(?:x|ext\.?|extension)\s*(\d+)\s*$/i)
  const main = ext ? text.slice(0, ext.index) : text
  let d = main.replace(/\D/g, "")
  if (d.length === 11 && d.startsWith("1")) d = d.slice(1)
  const usLike = d.length === 10 && (!main.startsWith("+") || main.startsWith("+1"))
  if (!usLike) return text
  return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}${ext ? ` ext. ${ext[1]}` : ""}`
}

// A link that dials the number on a phone (the extension is left out).
export const telHref = (phone: string) =>
  `tel:${phone.replace(/\s*(?:x|ext\.?|extension)\s*\d+\s*$/i, "").replace(/[^\d+]/g, "")}`
