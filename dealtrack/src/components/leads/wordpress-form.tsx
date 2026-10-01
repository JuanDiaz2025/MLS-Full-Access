"use client"

import { useActionState } from "react"

import { Button } from "@/components/ui/button"
import { connectWordPressAction } from "@/lib/leads/wordpress-actions"

export default function WordPressForm({ current }: { current?: string }) {
  const [state, action, pending] = useActionState(connectWordPressAction, undefined)
  return (
    <form action={action} className="flex flex-col gap-2">
      <label htmlFor="wp-site" className="font-medium">
        Your website&apos;s address
      </label>
      <div className="flex flex-wrap gap-2">
        <input
          id="wp-site"
          name="site"
          defaultValue={current}
          placeholder="twinhomebuyer.com"
          className="h-11 min-w-0 flex-1 basis-full rounded-lg border bg-card px-3 text-sm sm:basis-0"
        />
        <Button type="submit" size="lg" className="h-11 px-5" disabled={pending}>
          {pending ? "Connecting…" : current ? "Check again" : "Connect"}
        </Button>
        {current && (
          <Button type="submit" name="disconnect" value="1" variant="outline" size="lg" className="h-11" disabled={pending}>
            Disconnect
          </Button>
        )}
      </div>
      {state?.error && <p className="font-medium text-destructive">{state.error}</p>}
      {state?.connected && <p className="font-medium text-emerald-700">Connected. Leads saved on your site are coming in.</p>}
      {state?.disconnected && <p className="text-muted-foreground">Disconnected.</p>}
    </form>
  )
}
