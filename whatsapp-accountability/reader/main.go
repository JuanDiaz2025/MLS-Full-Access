// WhatsApp Reader links to a phone the way WhatsApp Web does and saves that
// phone's group messages on this computer, so the accountability dashboard
// can read them through the Claude desktop app. It never sends anything.
package main

import (
	"bufio"
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"
	"github.com/skip2/go-qrcode"
	"go.mau.fi/whatsmeow"
	waLog "go.mau.fi/whatsmeow/util/log"
)

const version = "1.0.0"

func main() {
	setupConsole()
	dir := dataDir()
	args := os.Args[1:]
	cmd := ""
	if len(args) > 0 {
		cmd, args = args[0], args[1:]
	}

	if cmd == "serve" {
		if err := serve(dir); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		return
	}

	err := interactive(dir, cmd, args)
	if err != nil {
		fmt.Println()
		fmt.Println("Problem:", err)
	}
	pause()
	if err != nil {
		os.Exit(1)
	}
}

func dataDir() string {
	if exe, err := os.Executable(); err == nil {
		if real, err := filepath.EvalSymlinks(exe); err == nil {
			exe = real
		}
		return filepath.Dir(exe)
	}
	wd, _ := os.Getwd()
	return wd
}

func pause() {
	if os.Getenv("WHATSAPP_READER_NO_PAUSE") != "" {
		return
	}
	fmt.Println()
	fmt.Print("Press Enter to close this window.")
	_, _ = bufio.NewReader(os.Stdin).ReadString('\n')
}

func interactive(dir, cmd string, args []string) error {
	logger := newFileLogger(filepath.Join(dir, "reader.log"))
	r, err := OpenReader(dir, logger)
	if err != nil {
		return err
	}
	defer r.Close()
	ctx := context.Background()

	switch cmd {
	case "", "link":
		fs := flag.NewFlagSet("link", flag.ContinueOnError)
		phone := fs.String("phone", "", "link with an 8-character code instead of a QR code (your number with country code, digits only)")
		if err := fs.Parse(args); err != nil {
			return err
		}
		dev, err := r.Device(ctx)
		if err != nil {
			return err
		}
		if dev.ID != nil {
			if cmd == "" {
				return printStatus(r)
			}
			fmt.Printf("Already linked to +%s. To link a different phone, run: whatsapp-reader.exe unlink\n", dev.ID.User)
			return nil
		}
		return link(r, strings.TrimLeft(strings.ReplaceAll(*phone, " ", ""), "+"))
	case "status":
		return printStatus(r)
	case "unlink":
		return unlink(r)
	case "help", "-h", "--help", "/?":
		usage()
		return nil
	}
	usage()
	return fmt.Errorf("unknown command %q", cmd)
}

func usage() {
	fmt.Println(`WhatsApp Reader ` + version + `

  whatsapp-reader.exe                 Link to your phone (first time), or show status
  whatsapp-reader.exe link --phone 15551234567
                                      Link with an 8-character code instead of a QR code
  whatsapp-reader.exe status          Show what is linked and saved
  whatsapp-reader.exe unlink          Unlink from WhatsApp and delete everything saved here
  whatsapp-reader.exe serve           Used by the Claude desktop app; you don't run this yourself

It only reads. It never sends messages, reactions, read receipts or typing status.`)
}

func printStatus(r *Reader) error {
	ctx := context.Background()
	dev, err := r.Device(ctx)
	if err != nil {
		return err
	}
	msgs, groups, last := r.store.Counts()
	fmt.Println("WhatsApp Reader", version)
	if dev.ID == nil {
		fmt.Println("Not linked yet. Close this window and double-click whatsapp-reader.exe to link it.")
		return nil
	}
	fmt.Printf("Linked to:        +%s\n", dev.ID.User)
	fmt.Printf("Groups known:     %d\n", groups)
	fmt.Printf("Messages saved:   %d\n", msgs)
	if last > 0 {
		fmt.Printf("Newest message:   %s\n", time.UnixMilli(last).Format("Mon Jan 2, 3:04 PM"))
	}
	fmt.Printf("Saved in:         %s\n", r.dir)
	fmt.Println()
	fmt.Println("The Claude desktop app runs this reader for you while the app is open.")
	return nil
}

// ---- linking ----

func lockPath(dir string) string { return filepath.Join(dir, "link.lock") }

func link(r *Reader, phone string) error {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	_ = os.WriteFile(lockPath(r.dir), []byte(fmt.Sprint(os.Getpid())), 0o600)
	defer os.Remove(lockPath(r.dir))

	dev, err := r.Device(ctx)
	if err != nil {
		return err
	}
	cli := r.NewClient(dev)
	qrChan, err := cli.GetQRChannel(ctx)
	if err != nil {
		return err
	}
	if err := cli.Connect(); err != nil {
		return fmt.Errorf("couldn't reach WhatsApp: %w", err)
	}
	defer cli.Disconnect()

	fmt.Println("WhatsApp Reader", version, "- link to your phone")
	fmt.Println()
	codeShown := false
	pngPath := filepath.Join(r.dir, "link-qr.png")
	defer os.Remove(pngPath)

	for item := range qrChan {
		switch item.Event {
		case "code":
			if phone != "" {
				if codeShown {
					continue
				}
				code, err := cli.PairPhone(ctx, phone, true, whatsmeow.PairClientChrome, "Chrome (Windows)")
				if err != nil {
					return fmt.Errorf("WhatsApp refused the code request: %w", err)
				}
				codeShown = true
				fmt.Println("On your phone: WhatsApp > Settings > Linked devices > Link a device >")
				fmt.Println("Link with phone number instead, then type this code:")
				fmt.Println()
				fmt.Printf("        %s-%s\n", code[:4], code[4:])
				fmt.Println()
				fmt.Println("Waiting for you to enter it...")
				continue
			}
			fmt.Print("\033[H\033[2J")
			fmt.Println("On your phone: WhatsApp > Settings > Linked devices > Link a device, then scan this.")
			fmt.Println("The code changes every few seconds; just keep the camera on it.")
			fmt.Println()
			printQR(item.Code)
			_ = qrcode.WriteFile(item.Code, qrcode.Low, 420, pngPath)
			fmt.Println("If it won't scan, open link-qr.png in this folder, or close this window and run:")
			fmt.Println("  whatsapp-reader.exe link --phone <your number with country code>")
		case "success":
			fmt.Print("\033[H\033[2J")
			fmt.Println("Linked. Saving recent group messages from your phone. This can take a minute...")
			waitForHistory(r)
			r.refreshGroups()
			msgs, groups, _ := r.store.Counts()
			fmt.Println()
			fmt.Printf("Done. %d groups and %d messages saved on this computer.\n", groups, msgs)
			fmt.Println("Next: add WhatsApp Reader to the Claude desktop app (see the README).")
			return nil
		case "timeout":
			return errors.New("the code expired before it was scanned. Run whatsapp-reader.exe again")
		default:
			if item.Error != nil {
				return fmt.Errorf("linking failed: %w", item.Error)
			}
			return fmt.Errorf("linking stopped (%s). Run whatsapp-reader.exe again", item.Event)
		}
	}
	return errors.New("linking stopped. Run whatsapp-reader.exe again")
}

// waitForHistory gives the phone time to send recent chats. It stops once
// nothing new has arrived for 20 seconds, or after two minutes.
func waitForHistory(r *Reader) {
	start := time.Now()
	lastCount, lastChange := int64(-1), time.Now()
	for time.Since(start) < 2*time.Minute {
		time.Sleep(2 * time.Second)
		n := r.history.Load()
		if n != lastCount {
			lastCount, lastChange = n, time.Now()
			fmt.Printf("\r  %d messages received", n)
		}
		if time.Since(start) > 25*time.Second && time.Since(lastChange) > 20*time.Second {
			break
		}
	}
	fmt.Println()
}

// printQR draws the code with half-height blocks so it fits the window.
// Light squares are drawn and dark ones left blank, which reads correctly
// on the usual black console background.
func printQR(code string) {
	q, err := qrcode.New(code, qrcode.Low)
	if err != nil {
		fmt.Println(code)
		return
	}
	q.DisableBorder = false
	bits := q.Bitmap()
	light := func(y, x int) bool { return y >= len(bits) || !bits[y][x] }
	var b strings.Builder
	for y := 0; y < len(bits); y += 2 {
		b.WriteString("  ")
		for x := range bits[y] {
			top, bottom := light(y, x), light(y+1, x)
			switch {
			case top && bottom:
				b.WriteString("█")
			case top:
				b.WriteString("▀")
			case bottom:
				b.WriteString("▄")
			default:
				b.WriteString(" ")
			}
		}
		b.WriteString("\n")
	}
	fmt.Print(b.String())
}

func unlink(r *Reader) error {
	ctx := context.Background()
	dev, err := r.Device(ctx)
	if err != nil {
		return err
	}
	if dev.ID == nil {
		fmt.Println("Nothing is linked.")
	} else {
		fmt.Printf("This unlinks +%s and deletes every message saved in %s.\n", dev.ID.User, r.dir)
		fmt.Print("Type YES to continue: ")
		answer, _ := bufio.NewReader(os.Stdin).ReadString('\n')
		if strings.TrimSpace(answer) != "YES" {
			fmt.Println("Nothing changed.")
			return nil
		}
		cli := r.NewClient(dev)
		if err := cli.Connect(); err == nil {
			time.Sleep(3 * time.Second)
			if err := cli.Logout(ctx); err != nil {
				fmt.Println("Couldn't reach WhatsApp to unlink; remove it on your phone under Linked devices.")
				_ = dev.Delete(ctx)
			}
		} else {
			_ = dev.Delete(ctx)
		}
	}
	r.Close()
	for _, f := range []string{"messages.db", "messages.db-wal", "messages.db-shm", "session.db", "session.db-wal", "session.db-shm"} {
		_ = os.Remove(filepath.Join(r.dir, f))
	}
	fmt.Println("Unlinked and deleted.")
	os.Exit(0)
	return nil
}

// ---- serving the Claude desktop app ----

func serve(dir string) error {
	logger := newFileLogger(filepath.Join(dir, "reader.log"))
	r, err := OpenReader(dir, logger)
	if err != nil {
		logger.Errorf("Startup failed: %v", err)
		return err
	}
	defer r.Close()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go keepConnected(ctx, r)

	server := mcp.NewServer(&mcp.Implementation{Name: "whatsapp-reader", Version: version}, nil)
	addTools(server, r)
	logger.Infof("Serving the Claude desktop app")
	return server.Run(ctx, &mcp.StdioTransport{})
}

// keepConnected waits until the reader has been linked, then connects.
// whatsmeow reconnects on its own after network drops.
func keepConnected(ctx context.Context, r *Reader) {
	for ctx.Err() == nil {
		if info, err := os.Stat(lockPath(r.dir)); err == nil && time.Since(info.ModTime()) < 10*time.Minute {
			sleep(ctx, 5*time.Second) // a link is in progress in another window
			continue
		}
		dev, err := r.Device(ctx)
		if err != nil || dev.ID == nil {
			sleep(ctx, 10*time.Second)
			continue
		}
		cli := r.NewClient(dev)
		if err := cli.Connect(); err != nil {
			r.log.Warnf("Connecting failed, retrying: %v", err)
			sleep(ctx, 30*time.Second)
			continue
		}
		<-ctx.Done()
		return
	}
}

func sleep(ctx context.Context, d time.Duration) {
	select {
	case <-ctx.Done():
	case <-time.After(d):
	}
}

// ---- logging to reader.log ----

type fileLogger struct {
	mod string
	min int
	mu  *sync.Mutex
	w   io.Writer
}

func newFileLogger(path string) waLog.Logger {
	if info, err := os.Stat(path); err == nil && info.Size() > 5<<20 {
		_ = os.Remove(path)
	}
	var w io.Writer = io.Discard
	if f, err := os.OpenFile(path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600); err == nil {
		w = f
	}
	return &fileLogger{mod: "Reader", min: 1, mu: &sync.Mutex{}, w: w}
}

func (l *fileLogger) out(level int, name, msg string, args ...any) {
	if level < l.min {
		return
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	fmt.Fprintf(l.w, "%s [%s %s] %s\n", time.Now().Format("2006-01-02 15:04:05"), l.mod, name, fmt.Sprintf(msg, args...))
}
func (l *fileLogger) Errorf(msg string, args ...any) { l.out(3, "ERROR", msg, args...) }
func (l *fileLogger) Warnf(msg string, args ...any)  { l.out(2, "WARN", msg, args...) }
func (l *fileLogger) Infof(msg string, args ...any)  { l.out(1, "INFO", msg, args...) }
func (l *fileLogger) Debugf(msg string, args ...any) { l.out(0, "DEBUG", msg, args...) }
func (l *fileLogger) Sub(mod string) waLog.Logger {
	min := l.min
	if mod == "Client" || mod == "Session" {
		min = 2 // the WhatsApp library is chatty; keep its warnings and errors only
	}
	return &fileLogger{mod: l.mod + "/" + mod, min: min, mu: l.mu, w: l.w}
}
