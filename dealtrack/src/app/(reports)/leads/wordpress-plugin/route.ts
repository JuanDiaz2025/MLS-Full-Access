import { isAdmin } from "@/lib/auth"
import { webhookSecret } from "@/lib/leads/webhook"
import { PLUGIN_FOLDER, wordpressPluginZip } from "@/lib/leads/wordpress-plugin"

// GET /leads/wordpress-plugin → the Lead Saver plugin for WordPress, with DealTrack's key in it.
export async function GET() {
  if (!(await isAdmin())) return new Response("Only admins can download the plugin (it holds the website key). Sign in as an admin.", { status: 401 })
  const zip = wordpressPluginZip(await webhookSecret())
  return new Response(new Uint8Array(zip), {
    headers: {
      "content-type": "application/zip",
      "content-disposition": `attachment; filename="${PLUGIN_FOLDER}.zip"`,
      "cache-control": "no-store",
    },
  })
}
