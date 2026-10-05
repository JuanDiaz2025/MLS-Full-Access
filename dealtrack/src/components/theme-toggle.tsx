"use client"

import { Moon, Sun } from "lucide-react"

import { Button } from "@/components/ui/button"

// Switches between light and dark, and remembers the choice on this computer. Both icons are drawn
// and CSS shows the right one, so the page needs no state and never flickers.
export default function ThemeToggle() {
  function toggle() {
    const root = document.documentElement
    const dark = !root.classList.contains("dark")
    root.classList.toggle("dark", dark)
    root.style.colorScheme = dark ? "dark" : "light"
    try {
      localStorage.setItem("dealtrack-theme", dark ? "dark" : "light")
    } catch {
      // Private window: it still switches, it just isn't remembered.
    }
  }
  return (
    <Button type="button" variant="ghost" size="icon" onClick={toggle} aria-label="Switch light or dark mode" title="Light or dark mode">
      <Moon className="dark:hidden" />
      <Sun className="hidden dark:block" />
    </Button>
  )
}
