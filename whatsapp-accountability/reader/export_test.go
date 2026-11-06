package main

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"go.mau.fi/whatsmeow/proto/waE2E"
	"go.mau.fi/whatsmeow/types"
	"go.mau.fi/whatsmeow/types/events"
	"google.golang.org/protobuf/proto"
)

func TestExportSettings(t *testing.T) {
	path := filepath.Join(t.TempDir(), settingsName)
	_ = os.WriteFile(path, []byte(settingsStart+"folder: \"G:\\My Drive\\WhatsApp - Construction\"\ngroup: Paramount\nnot a setting\n"), 0o644)
	s, err := readExportSettings(path)
	if err != nil {
		t.Fatal(err)
	}
	if s.Folder != `G:\My Drive\WhatsApp - Construction` || strings.Join(s.Groups, "|") != "972 Norton|Paramount" {
		t.Fatalf("read %+v", s)
	}
	for name, want := range map[string]bool{"972 Norton St - Crew": true, "972 NORTON": true, "Paramount reno": true, "Norton 2": false, "": false} {
		if s.wants(name) != want {
			t.Errorf("wants(%q) = %v", name, !want)
		}
	}
}

func TestFileName(t *testing.T) {
	for in, want := range map[string]string{
		"972 Norton":             "972 Norton",
		`Norton: "crew" / site?`: "Norton crew site",
		"  dots...  ":            "dots",
		"":                       "WhatsApp group",
	} {
		if got := fileName(in); got != want {
			t.Errorf("fileName(%q) = %q, want %q", in, got, want)
		}
	}
}

// Fri Nov 6 2026 in Pacific time (PST, after the clock change)
func pt(h, m int) time.Time { return time.Date(2026, 11, 6, h, m, 0, 0, pacific()) }

func TestRenderGroup(t *testing.T) {
	g := GroupRecord{ID: "1@g.us", Name: "972 Norton", Participants: []Participant{
		{ID: "14155550001", Name: "Mike Santos"}, {ID: "14155550002", Name: "+14155550002"}, {ID: "14155550003", Name: "John Decena"}}}
	msgs := []Message{
		{ID: "A", At: pt(9, 0).UnixMilli(), SenderID: "14155550003", Kind: "text", Text: "@14155550001 is the drywall coming today?"},
		{ID: "B", At: pt(9, 12).UnixMilli(), SenderID: "14155550001", Kind: "text", Text: "Moved to Monday", QuotedID: "A", Edited: true},
		{ID: "C", At: pt(9, 15).UnixMilli(), SenderID: "14155550002", SenderName: "Rey", Kind: "image", Text: "panel"},
		{ID: "D", At: pt(9, 20).UnixMilli(), SenderID: "14155550002", SenderName: "Rey", Kind: "audio"},
		{ID: "E", At: pt(9, 21).UnixMilli(), SenderID: "14155550003", Kind: "reaction", Text: "👍", ReactionTo: "B"},
		{ID: "F", At: pt(9, 25).UnixMilli(), SenderID: "99@lid", Kind: "text", Text: "gone", Deleted: true},
		{ID: "G", At: pt(9, 30).UnixMilli(), SenderID: "14155550001", Kind: "document", Text: "invoice.pdf"},
		{ID: "H", At: pt(9, 31).UnixMilli(), SenderID: "14155550001", Kind: "text", Text: "line one\nline two"},
		{ID: "OLD", At: pt(9, 0).Add(-40 * 24 * time.Hour).UnixMilli(), SenderID: "14155550001", Kind: "text", Text: "old news"},
	}
	now := pt(10, 0)
	cutoff := now.Add(-exportWindow).UnixMilli()
	out := renderGroup(g, msgs, now, cutoff, 0, false, connectionNote(0))
	for _, want := range []string{
		"972 Norton: WhatsApp group messages, last 30 days\n",
		"Updated: Fri Nov 6, 2026, 10:00 AM Pacific.",
		"WhatsApp: connected.",
		"Messages: 7, newest first. Older ones are in \"WhatsApp - 972 Norton - older messages.txt\".",
		"How to read this file (for Claude):",
		"Fri Nov 6, 9:31 AM · Mike Santos: line one\n    line two\n",
		"Fri Nov 6, 9:30 AM · Mike Santos: [document: invoice.pdf]\n",
		"Fri Nov 6, 9:25 AM · Unknown member: [deleted by the sender]\n",
		"Fri Nov 6, 9:21 AM · John Decena reacted thumbs up to Mike Santos's message of Fri Nov 6, 9:12 AM\n",
		"Fri Nov 6, 9:20 AM · Rey: [voice note]\n",
		"Fri Nov 6, 9:15 AM · Rey: [photo] panel\n",
		"Fri Nov 6, 9:12 AM · Mike Santos (replying to John Decena, Fri Nov 6, 9:00 AM: \"@Mike Santos is the drywall coming today?\"): Moved to Monday (edited)\n",
		"Fri Nov 6, 9:00 AM · John Decena: @Mike Santos is the drywall coming today?\n",
	} {
		if !strings.Contains(out, want) {
			t.Errorf("missing %q in:\n%s", want, out)
		}
	}
	if strings.Contains(out, "old news") {
		t.Error("a message older than 30 days is in the 30-day file")
	}
	if strings.Index(out, "9:31 AM") > strings.Index(out, "9:00 AM ·") {
		t.Error("not newest first")
	}
	older := renderGroup(g, msgs, now, 0, cutoff, true, connectionNote(pt(8, 2).UnixMilli()))
	if !strings.Contains(older, "older WhatsApp group messages") || !strings.Contains(older, "old news") || strings.Contains(older, "Moved to Monday") {
		t.Errorf("older file:\n%s", older)
	}
	if !strings.Contains(older, "WhatsApp: NOT connected since Fri Nov 6, 8:02 AM Pacific.") {
		t.Errorf("connection line:\n%s", older)
	}
}

func TestExportOnce(t *testing.T) {
	dir := t.TempDir()
	st, err := OpenStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	_ = st.SaveGroup(GroupRecord{ID: "1@g.us", Name: "972 Norton", UpdatedAt: 1})
	_ = st.SaveGroup(GroupRecord{ID: "2@g.us", Name: "Paramount", UpdatedAt: 1})
	_ = st.SaveMessage(Message{chat: "1@g.us", ID: "a", At: pt(9, 0).UnixMilli(), SenderID: "1", Kind: "text", Text: "norton msg"})
	_ = st.SaveMessage(Message{chat: "2@g.us", ID: "b", At: pt(9, 0).UnixMilli(), SenderID: "1", Kind: "text", Text: "paramount msg"})
	out := filepath.Join(dir, "Drive", "WhatsApp")
	s := ExportSettings{Folder: out, Groups: []string{"norton"}}
	days := map[string]string{}
	report, err := exportOnce(st, s, pt(10, 0), connectionNote(0), days)
	if err != nil || len(report) != 1 || report[0] != "972 Norton: 1 messages in the last 30 days" {
		t.Fatalf("report %v, %v", report, err)
	}
	files, _ := os.ReadDir(out)
	names := []string{}
	for _, f := range files {
		names = append(names, f.Name())
	}
	if strings.Join(names, "|") != "WhatsApp - 972 Norton - older messages.txt|WhatsApp - 972 Norton.txt" {
		t.Fatalf("files: %v (only Norton, no leftovers)", names)
	}
	b, _ := os.ReadFile(filepath.Join(out, "WhatsApp - 972 Norton.txt"))
	if !strings.Contains(string(b), "norton msg") || strings.Contains(string(b), "paramount") {
		t.Errorf("Norton file:\n%s", b)
	}
	// the older file is written once a day
	olderPath := filepath.Join(out, "WhatsApp - 972 Norton - older messages.txt")
	_ = os.WriteFile(olderPath, []byte("kept"), 0o644)
	_, _ = exportOnce(st, s, pt(10, 15), connectionNote(0), days)
	if b, _ := os.ReadFile(olderPath); string(b) != "kept" {
		t.Error("older file rewritten twice in one day")
	}
	_, _ = exportOnce(st, s, pt(10, 0).Add(24*time.Hour), connectionNote(0), days)
	if b, _ := os.ReadFile(olderPath); string(b) == "kept" {
		t.Error("older file not rewritten the next day")
	}
	if _, err := exportOnce(st, ExportSettings{Folder: out, Groups: []string{"nowhere"}}, pt(10, 0), "", days); err == nil || !strings.Contains(err.Error(), "no saved group matches") {
		t.Errorf("no match: %v", err)
	}
	if _, err := exportOnce(st, ExportSettings{Groups: []string{"norton"}}, pt(10, 0), "", days); err == nil {
		t.Error("no folder should be an error")
	}
}

// Running for chosen groups only: messages from the other groups are never saved.
func TestKeepOnlyChosenGroups(t *testing.T) {
	dir := t.TempDir()
	st, err := OpenStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	r := &Reader{dir: dir, store: st, log: newFileLogger(dir + "/t.log")}
	s := ExportSettings{Groups: []string{"972 Norton"}}
	r.keep = func(chat string) bool { g, ok := st.Group(chat); return ok && s.wants(g.Name) }
	norton, other := types.NewJID("111", types.GroupServer), types.NewJID("222", types.GroupServer)
	_ = st.SaveGroupName(norton.String(), "972 Norton")
	_ = st.SaveGroupName(other.String(), "Paramount")
	send := func(chat types.JID, id string) {
		r.saveEvent(context.Background(), &events.Message{Info: types.MessageInfo{
			MessageSource: types.MessageSource{Chat: chat, Sender: types.NewJID("15550000001", types.DefaultUserServer), IsGroup: true},
			ID:            id, Timestamp: time.Now()}, Message: &waE2E.Message{Conversation: proto.String("hi")}})
	}
	send(norton, "n1")
	send(other, "p1")
	send(types.NewJID("333", types.GroupServer), "x1") // a group with no name yet
	if n, _, _ := st.Counts(); n != 1 {
		t.Fatalf("saved %d messages, want only Norton's", n)
	}
	if msgs, _, _ := st.Messages(norton.String(), 0, 10); len(msgs) != 1 {
		t.Error("Norton's message not saved")
	}
}

func TestRunActive(t *testing.T) {
	dir := t.TempDir()
	if runActive(dir) {
		t.Fatal("no lock: not running")
	}
	_ = os.WriteFile(runLockPath(dir), []byte("1"), 0o600)
	if !runActive(dir) {
		t.Fatal("fresh lock: running")
	}
	old := time.Now().Add(-5 * time.Minute)
	_ = os.Chtimes(runLockPath(dir), old, old)
	if runActive(dir) {
		t.Fatal("a lock 5 minutes old is left over from a closed window")
	}
}
