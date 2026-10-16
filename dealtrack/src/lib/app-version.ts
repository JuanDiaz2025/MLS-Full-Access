// Which version of DealTrack is running, for "Check sending to Google Ads": the git commit start.bat
// built the fast version from (.next/dealtrack-built-version), or, without a build, the one checked
// out. Also notices a newer version that was pulled but not started yet.
import { readFile } from "node:fs/promises"
import path from "node:path"

const read = (file: string) => readFile(file, "utf8").then((s) => s.trim(), () => "")
const isCommit = (s: string) => /^[0-9a-f]{40}$/i.test(s)

// The commit checked out in the repository the app folder is in (DealTrack lives in its "dealtrack" folder).
async function checkedOut(app: string) {
  for (const root of [app, path.dirname(app)]) {
    const head = await read(path.join(root, ".git", "HEAD"))
    if (!head) continue
    if (isCommit(head)) return head
    const ref = head.match(/^ref:\s*(\S+)/)?.[1]
    if (!ref) return ""
    const loose = await read(path.join(root, ".git", ref))
    if (isCommit(loose)) return loose
    const packed = await read(path.join(root, ".git", "packed-refs"))
    return packed.split("\n").map((line) => line.trim().split(" ")).find(([sha, name]) => name === ref && isCommit(sha))?.[0] ?? ""
  }
  return ""
}

export async function appVersion(app = process.cwd()): Promise<{ running?: string; latest?: string }> {
  const [built, onDisk] = await Promise.all([read(path.join(app, ".next", "dealtrack-built-version")), checkedOut(app)])
  // `next start` runs that build; `next dev` (start.bat's fallback when building fails) runs the files on disk.
  const running = process.env.NODE_ENV === "production" && isCommit(built) ? built : onDisk
  return { running: running.slice(0, 7) || undefined, latest: onDisk.slice(0, 7) || undefined }
}
