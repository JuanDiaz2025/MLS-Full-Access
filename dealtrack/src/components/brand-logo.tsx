import Link from "next/link"
import { House } from "lucide-react"

export default function BrandLogo({ href = "/overview" }: { href?: string }) {
  return (
    <Link href={href} className="flex items-center gap-2.5 font-semibold tracking-tight">
      <span className="flex size-8 items-center justify-center rounded-lg bg-primary text-primary-foreground shadow-sm">
        <House className="size-4.5" aria-hidden />
      </span>
      <span>
        DealTrack <span className="font-normal text-muted-foreground">· Twin Home Buyer</span>
      </span>
    </Link>
  )
}
