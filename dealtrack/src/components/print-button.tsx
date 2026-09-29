"use client"

import { Printer } from "lucide-react"

import { Button } from "@/components/ui/button"

export default function PrintButton({ label = "Print" }: { label?: string }) {
  return (
    <Button type="button" variant="outline" size="sm" onClick={() => window.print()}>
      <Printer data-icon="inline-start" />
      {label}
    </Button>
  )
}
