// How each lead grade looks, wherever a score shows (the leads table, the lead panel, the scoring
// guide). Not a client module, so server-rendered pages can read it too.
export const gradeStyle = {
  hot: { label: "Hot", cls: "bg-red-600 text-white" },
  warm: { label: "Warm", cls: "bg-amber-400 text-amber-950" },
  cold: { label: "Cold", cls: "bg-sky-100 text-sky-900" },
  junk: { label: "Junk", cls: "bg-muted text-muted-foreground line-through" },
} as const
