package main

import "golang.org/x/sys/windows"

// setupConsole switches the console to UTF-8 and turns on colour/cursor
// codes so the QR code and screen clearing display properly.
func setupConsole() {
	_ = windows.SetConsoleOutputCP(65001)
	h, err := windows.GetStdHandle(windows.STD_OUTPUT_HANDLE)
	if err != nil {
		return
	}
	var mode uint32
	if windows.GetConsoleMode(h, &mode) == nil {
		_ = windows.SetConsoleMode(h, mode|windows.ENABLE_VIRTUAL_TERMINAL_PROCESSING)
	}
}
