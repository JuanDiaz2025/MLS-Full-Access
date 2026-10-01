// The Weekly negatives tabs. Kept out of the client files so the page (a server component) can
// read ?tab= against the same list.
export const TABS = ["batches", "new", "check"] as const
export type Tab = (typeof TABS)[number]
