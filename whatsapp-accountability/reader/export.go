package main

import (
	"bufio"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"
	_ "time/tzdata" // Pacific time on Windows computers without zone files
)

// The export: one plain text file per tracked group, written into a folder
// that Google Drive for desktop copies to the company Drive, so Juan and John
// can ask their own Claude "What's missing at Norton?". Each file holds the
// last 30 days, newest first; older messages go to a second file.

const (
	exportEvery  = 15 * time.Minute
	exportWindow = 30 * 24 * time.Hour
	settingsName = "export.txt"
	olderSuffix  = " - older messages.txt"
	// every file starts with this, so asking Claude about "Norton" finds the
	// WhatsApp file and not the property's other folders in Drive
	filePrefix    = "WhatsApp - "
	pacificZone   = "America/Los_Angeles"
	quoteLength   = 60
	settingsStart = `# WhatsApp Reader: what to write and where.
#
# folder: the folder Google Drive for desktop copies to the company Drive.
# group:  one line per WhatsApp group to read and write. A group matches when
#         its name contains this text (capitals don't matter). Only these
#         groups are saved while the reader runs in the background.
#
# Changes are picked up within 15 minutes; no restart needed.

folder:
group: 972 Norton
`
)

// ExportSettings is export.txt next to the exe.
type ExportSettings struct {
	Folder string
	Groups []string
}

func readExportSettings(path string) (ExportSettings, error) {
	f, err := os.Open(path)
	if err != nil {
		return ExportSettings{}, err
	}
	defer f.Close()
	var s ExportSettings
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		key, val, ok := strings.Cut(line, ":")
		if !ok {
			continue
		}
		val = strings.Trim(strings.TrimSpace(val), `"`)
		switch strings.ToLower(strings.TrimSpace(key)) {
		case "folder":
			s.Folder = val
		case "group":
			if val != "" {
				s.Groups = append(s.Groups, val)
			}
		}
	}
	return s, sc.Err()
}

// wants says whether a group with this name is one of the groups to read.
func (s ExportSettings) wants(name string) bool {
	n := strings.ToLower(strings.TrimSpace(name))
	if n == "" {
		return false
	}
	for _, g := range s.Groups {
		if strings.Contains(n, strings.ToLower(g)) {
			return true
		}
	}
	return false
}

var badFileChars = regexp.MustCompile(`[<>:"/\\|?*\x00-\x1f]+`)

// fileName makes a group name safe as a Windows file name.
func fileName(name string) string {
	s := strings.TrimRight(strings.TrimSpace(badFileChars.ReplaceAllString(name, " ")), ". ")
	s = strings.Join(strings.Fields(s), " ")
	if s == "" {
		s = "WhatsApp group"
	}
	if len(s) > 120 {
		s = strings.TrimSpace(s[:120])
	}
	return s
}

func pacific() *time.Location {
	if loc, err := time.LoadLocation(pacificZone); err == nil {
		return loc
	}
	return time.FixedZone("PT", -8*3600)
}

var markers = map[string]string{
	"image": "[photo]", "video": "[video]", "audio": "[voice note]", "sticker": "[sticker]",
	"location": "[location]", "contact": "[contact card]", "poll": "[poll]", "document": "[document]",
}

var mentionRE = regexp.MustCompile(`@(\d{6,})`)

// Reactions as words: an emoji can arrive garbled, and a word can't be misread.
var reactionWords = map[string]string{
	"👍": "thumbs up", "👍🏻": "thumbs up", "👍🏼": "thumbs up", "👍🏽": "thumbs up", "👍🏾": "thumbs up", "👍🏿": "thumbs up",
	"❤️": "heart", "❤": "heart", "✅": "check mark", "👌": "OK hand", "🙏": "praying hands", "😂": "laughing",
	"😮": "surprised", "😢": "sad", "👎": "thumbs down", "🔥": "fire", "💯": "100", "👏": "clapping",
}

func reactionWord(e string) string {
	if w := reactionWords[e]; w != "" {
		return w
	}
	return e
}

// renderGroup writes one group's file: a header for people and instructions
// for Claude, then one line per message, newest first. msgs is every saved
// message of the group with reactions; only those from or after since and
// before until are written (until 0: no end).
func renderGroup(g GroupRecord, msgs []Message, now time.Time, since, until int64, older bool, connection string) string {
	loc := pacific()
	names := map[string]string{}
	for _, p := range g.Participants {
		if strings.TrimSpace(p.Name) != "" && !strings.HasPrefix(p.Name, "+") {
			names[p.ID] = p.Name
		}
	}
	byID := map[string]Message{}
	for _, m := range msgs {
		if m.SenderName != "" && names[m.SenderID] == "" {
			names[m.SenderID] = m.SenderName
		}
		if m.Kind != "reaction" {
			byID[m.ID] = m
		}
	}
	who := func(id string) string {
		if n := names[id]; n != "" {
			return n
		}
		if strings.HasSuffix(id, "@lid") || id == "" {
			return "Unknown member"
		}
		return "+" + id
	}
	when := func(ms int64) string { return time.UnixMilli(ms).In(loc).Format("Mon Jan 2, 3:04 PM") }
	short := func(s string) string {
		s = strings.Join(strings.Fields(s), " ")
		if r := []rune(s); len(r) > quoteLength {
			return string(r[:quoteLength]) + "…"
		}
		return s
	}
	body := func(m Message) string {
		if m.Deleted {
			return "[deleted by the sender]"
		}
		text := mentionRE.ReplaceAllStringFunc(m.Text, func(t string) string {
			if n := names[t[1:]]; n != "" {
				return "@" + n
			}
			return t
		})
		out := strings.TrimSpace(text)
		if mk := markers[m.Kind]; mk != "" {
			if m.Kind == "document" && out != "" {
				out = "[document: " + out + "]"
			} else if out != "" {
				out = mk + " " + out
			} else {
				out = mk
			}
		}
		if m.Edited {
			out += " (edited)"
		}
		return strings.ReplaceAll(out, "\n", "\n    ")
	}

	shown := []Message{}
	for _, m := range msgs {
		if m.At >= since && (until == 0 || m.At < until) {
			shown = append(shown, m)
		}
	}
	sort.SliceStable(shown, func(i, j int) bool {
		if shown[i].At != shown[j].At {
			return shown[i].At > shown[j].At
		}
		return shown[i].ID > shown[j].ID
	})

	var b strings.Builder
	name := strings.TrimSpace(g.Name)
	if name == "" {
		name = "WhatsApp group"
	}
	if older {
		fmt.Fprintf(&b, "%s: older WhatsApp group messages (more than 30 days old)\n", name)
	} else {
		fmt.Fprintf(&b, "%s: WhatsApp group messages, last 30 days\n", name)
	}
	fmt.Fprintf(&b, "Updated: %s Pacific. WhatsApp Reader rewrites this file every 15 minutes while it runs.\n", now.In(loc).Format("Mon Jan 2, 2006, 3:04 PM"))
	if connection != "" {
		b.WriteString(connection + "\n")
	}
	count := 0
	for _, m := range shown {
		if m.Kind != "reaction" {
			count++
		}
	}
	fmt.Fprintf(&b, "Messages: %d, newest first.", count)
	if !older {
		fmt.Fprintf(&b, " Older ones are in \"%s\".", filePrefix+fileName(name)+olderSuffix)
	}
	b.WriteString("\n\n")
	b.WriteString(`How to read this file (for Claude):
- Each line is one message: day and time (Pacific), who sent it, then what it said.
- [photo], [video], [voice note], [document: name], [sticker], [location], [contact card] and [poll] mark media. The media itself isn't in this file: say one was sent, and never guess what a photo showed or a voice note said.
- "replying to" shows which earlier message an answer is for. "reacted" lines are emoji reactions.
- When asked what's pending, missing, late or a problem: list each item with who said it and when, and who it's waiting on. If the messages don't say, answer "not in the messages" instead of guessing.
- If the Updated time above is more than an hour old, or the WhatsApp line says NOT connected, say so first: newer messages are missing.
`)
	b.WriteString("\n---\n")
	for _, m := range shown {
		if m.Kind == "reaction" {
			target, ok := byID[m.ReactionTo]
			if !ok {
				fmt.Fprintf(&b, "%s · %s reacted %s to an earlier message\n", when(m.At), who(m.SenderID), reactionWord(m.Text))
				continue
			}
			fmt.Fprintf(&b, "%s · %s reacted %s to %s's message of %s\n", when(m.At), who(m.SenderID), reactionWord(m.Text), who(target.SenderID), when(target.At))
			continue
		}
		reply := ""
		if m.QuotedID != "" {
			if q, ok := byID[m.QuotedID]; ok {
				reply = fmt.Sprintf(" (replying to %s, %s: \"%s\")", who(q.SenderID), when(q.At), short(body(q)))
			} else {
				reply = " (replying to an earlier message)"
			}
		}
		fmt.Fprintf(&b, "%s · %s%s: %s\n", when(m.At), who(m.SenderID), reply, body(m))
	}
	if len(shown) == 0 {
		b.WriteString("(no messages in this period)\n")
	}
	return b.String()
}

// writeFile replaces a file in one step, so Google Drive never copies half of it.
func writeFile(path, content string) error {
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, []byte(content), 0o644); err != nil {
		return err
	}
	if err := os.Rename(tmp, path); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	return nil
}

// exportOnce writes the file of every wanted group. The older-messages file
// is rewritten once a day (olderDay remembers the day it was last written).
// Returns one line per group for the console.
func exportOnce(st *Store, s ExportSettings, now time.Time, connection string, olderDay map[string]string) ([]string, error) {
	if s.Folder == "" {
		return nil, fmt.Errorf("export.txt has no folder")
	}
	if err := os.MkdirAll(s.Folder, 0o755); err != nil {
		return nil, fmt.Errorf("can't open the export folder %s: %w", s.Folder, err)
	}
	groups, err := st.GroupSummaries()
	if err != nil {
		return nil, err
	}
	sort.Slice(groups, func(i, j int) bool { return groups[i].Name < groups[j].Name })
	cutoff := now.Add(-exportWindow).UnixMilli()
	today := now.In(pacific()).Format("2006-01-02")
	var report []string
	for _, gs := range groups {
		if !s.wants(gs.Name) {
			continue
		}
		g, _ := st.Group(gs.ID)
		msgs, _, err := st.Messages(gs.ID, 0, 1_000_000)
		if err != nil {
			return report, err
		}
		base := filepath.Join(s.Folder, filePrefix+fileName(g.Name))
		if err := writeFile(base+".txt", renderGroup(g, msgs, now, cutoff, 0, false, connection)); err != nil {
			report = append(report, fmt.Sprintf("%s: couldn't write the file (%v)", g.Name, err))
			continue
		}
		recent := 0
		for _, m := range msgs {
			if m.At >= cutoff && m.Kind != "reaction" {
				recent++
			}
		}
		if olderDay[gs.ID] != today {
			if err := writeFile(base+olderSuffix, renderGroup(g, msgs, now, 0, cutoff, true, connection)); err == nil {
				olderDay[gs.ID] = today
			}
		}
		report = append(report, fmt.Sprintf("%s: %d messages in the last 30 days", g.Name, recent))
	}
	if len(report) == 0 {
		return nil, fmt.Errorf("no saved group matches export.txt (%s); run whatsapp-reader.exe groups to see the names", strings.Join(s.Groups, ", "))
	}
	return report, nil
}
