package main

import (
	"context"
	"database/sql"
	"errors"
	"testing"
	"time"

	"go.mau.fi/whatsmeow/proto/waCommon"
	"go.mau.fi/whatsmeow/proto/waE2E"
	"go.mau.fi/whatsmeow/types"
	"go.mau.fi/whatsmeow/types/events"
	"google.golang.org/protobuf/proto"
)

func ev(id, sender string, at time.Time, m *waE2E.Message) *events.Message {
	return &events.Message{
		Info: types.MessageInfo{
			MessageSource: types.MessageSource{
				Chat:    types.NewJID("120363000000000001", types.GroupServer),
				Sender:  types.NewJID(sender, types.DefaultUserServer),
				IsGroup: true,
			},
			ID: id, Timestamp: at, PushName: "Name " + sender,
		},
		Message: m,
	}
}

func TestSaveAndRead(t *testing.T) {
	dir := t.TempDir()
	st, err := OpenStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	r := &Reader{dir: dir, store: st, log: newFileLogger(dir + "/t.log")}
	ctx := context.Background()
	t0 := time.Date(2026, 10, 24, 9, 0, 0, 0, time.Local)
	chat := "120363000000000001@g.us"

	// boss instruction
	r.saveEvent(ctx, ev("A1", "15550000001", t0, &waE2E.Message{Conversation: proto.String("Everyone confirm the schedule")}))
	// quoted reply with a mention
	r.saveEvent(ctx, ev("B1", "15550000002", t0.Add(3*time.Minute), &waE2E.Message{ExtendedTextMessage: &waE2E.ExtendedTextMessage{
		Text: proto.String("Confirmed @15550000001"),
		ContextInfo: &waE2E.ContextInfo{StanzaID: proto.String("A1"), Participant: proto.String("15550000001@s.whatsapp.net"),
			MentionedJID: []string{"15550000001@s.whatsapp.net"}},
	}}))
	// thumbs up reaction, then changed to a heart, from the same person
	react := func(id, emoji string, after time.Duration) {
		r.saveEvent(ctx, ev(id, "15550000003", t0.Add(after), &waE2E.Message{ReactionMessage: &waE2E.ReactionMessage{
			Key: &waCommon.MessageKey{ID: proto.String("A1")}, Text: proto.String(emoji)}}))
	}
	react("C1", "👍", 5*time.Minute)
	react("C2", "❤️", 6*time.Minute)
	// a photo with a caption
	r.saveEvent(ctx, ev("D1", "15550000004", t0.Add(7*time.Minute), &waE2E.Message{ImageMessage: &waE2E.ImageMessage{Caption: proto.String("site photo")}}))
	// edit B1, delete D1
	r.saveEvent(ctx, ev("E1", "15550000002", t0.Add(8*time.Minute), &waE2E.Message{ProtocolMessage: &waE2E.ProtocolMessage{
		Type: waE2E.ProtocolMessage_MESSAGE_EDIT.Enum(), Key: &waCommon.MessageKey{ID: proto.String("B1")},
		EditedMessage: &waE2E.Message{Conversation: proto.String("Confirmed, thanks")}}}))
	r.saveEvent(ctx, ev("F1", "15550000004", t0.Add(9*time.Minute), &waE2E.Message{ProtocolMessage: &waE2E.ProtocolMessage{
		Type: waE2E.ProtocolMessage_REVOKE.Enum(), Key: &waCommon.MessageKey{ID: proto.String("D1")}}}))
	// a message with nothing to show is skipped
	r.saveEvent(ctx, ev("G1", "15550000005", t0.Add(10*time.Minute), &waE2E.Message{SenderKeyDistributionMessage: &waE2E.SenderKeyDistributionMessage{}}))
	// a one-to-one chat is never stored
	dm := ev("H1", "15550000006", t0, &waE2E.Message{Conversation: proto.String("private")})
	dm.Info.Chat = types.NewJID("15550000006", types.DefaultUserServer)
	r.saveEvent(ctx, dm)
	// the same message arriving twice (live + history) is kept once
	r.saveEvent(ctx, ev("A1", "15550000001", t0, &waE2E.Message{Conversation: proto.String("Everyone confirm the schedule")}))

	msgs, more, err := st.Messages(chat, 0, 100)
	if err != nil || more {
		t.Fatal(err, more)
	}
	got := map[string]Message{}
	for _, m := range msgs {
		got[m.ID] = m
		t.Logf("%+v", m)
	}
	if len(msgs) != 4 {
		t.Fatalf("want 4 stored rows (A1, B1, C2, D1), got %d", len(msgs))
	}
	if got["B1"].QuotedID != "A1" || got["B1"].Text != "Confirmed, thanks" || !got["B1"].Edited || len(got["B1"].Mentions) != 1 {
		t.Errorf("quoted/edited reply wrong: %+v", got["B1"])
	}
	if _, ok := got["C1"]; ok {
		t.Errorf("replaced reaction C1 should be gone")
	}
	if got["C2"].Kind != "reaction" || got["C2"].ReactionTo != "A1" || got["C2"].Text != "❤️" {
		t.Errorf("reaction wrong: %+v", got["C2"])
	}
	if got["D1"].Kind != "image" || got["D1"].Text != "site photo" || !got["D1"].Deleted {
		t.Errorf("image/revoke wrong: %+v", got["D1"])
	}
	if got["A1"].At != t0.UnixMilli() || got["A1"].SenderID != "15550000001" {
		t.Errorf("basic fields wrong: %+v", got["A1"])
	}
	// taking a reaction back removes it
	react("C3", "", 11*time.Minute)
	msgs, _, _ = st.Messages(chat, 0, 100)
	if len(msgs) != 3 {
		t.Errorf("reaction removal: want 3 rows, got %d", len(msgs))
	}
	// paging by time
	page, more, _ := st.Messages(chat, t0.Add(time.Minute).UnixMilli(), 1)
	if len(page) != 1 || page[0].ID != "B1" || !more {
		t.Errorf("paging wrong: %+v more=%v", page, more)
	}
}

func TestWithSecret(t *testing.T) {
	code := "https://wa.me/settings/linked_devices#2@abc==,NOISE==,IDENT==,OLDSECRET==,1"
	got := withSecret(code, []byte{1, 2, 3})
	want := "https://wa.me/settings/linked_devices#2@abc==,NOISE==,IDENT==,AQID,1"
	if got != want {
		t.Fatalf("got %s", got)
	}
	if withSecret("no-hash", []byte{1}) != "" || withSecret("x#a,b", []byte{1}) != "" {
		t.Fatal("malformed codes should give an empty result")
	}
}

// A messages.db from 1.0.1 has no creation dates; 1.0.2 adds the column and
// keeps a known date when a later read of the group doesn't carry one.
func TestGroupCreatedDate(t *testing.T) {
	dir := t.TempDir()
	old, err := sql.Open("sqlite", sqlitePath(dir, "messages.db"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := old.Exec(`CREATE TABLE groups (id TEXT PRIMARY KEY, name TEXT, participants TEXT, updated INTEGER);
		INSERT INTO groups VALUES ('g1@g.us', 'Old group', '[]', 1)`); err != nil {
		t.Fatal(err)
	}
	old.Close()

	st, err := OpenStore(dir)
	if err != nil {
		t.Fatal("opening a 1.0.1 database:", err)
	}
	created := time.Date(2026, 10, 20, 9, 0, 0, 0, time.UTC).UnixMilli()
	if err := st.SaveGroup(GroupRecord{ID: "g2@g.us", Name: "New deal", UpdatedAt: 2, CreatedAt: created}); err != nil {
		t.Fatal(err)
	}
	// a later read without the date, and a name from history sync, keep it
	if err := st.SaveGroup(GroupRecord{ID: "g2@g.us", Name: "New deal", UpdatedAt: 3}); err != nil {
		t.Fatal(err)
	}
	if err := st.SaveGroupName("g2@g.us", "New deal renamed"); err != nil {
		t.Fatal(err)
	}
	st.Close()

	st, err = OpenStore(dir) // the column already exists the second time
	if err != nil {
		t.Fatal("reopening:", err)
	}
	defer st.Close()
	got := map[string]int64{}
	sums, err := st.GroupSummaries()
	if err != nil {
		t.Fatal(err)
	}
	for _, g := range sums {
		got[g.ID] = g.CreatedAt
	}
	if got["g1@g.us"] != 0 || got["g2@g.us"] != created {
		t.Fatalf("created dates = %v, want g1 0 and g2 %d", got, created)
	}
	if g, ok := st.Group("g2@g.us"); !ok || g.CreatedAt != created || g.Name != "New deal renamed" {
		t.Fatalf("Group(g2) = %+v", g)
	}
}

// Member lists come from the saved copy while it is recent; real requests to
// WhatsApp are spaced out and pause when WhatsApp says to slow down.
func TestGroupRequestsAreSpacedOut(t *testing.T) {
	now := time.Date(2026, 10, 27, 12, 0, 0, 0, time.UTC)
	clock := func() time.Time { return now }
	slept := time.Duration(0)
	sleep := func(d time.Duration) { slept += d; now = now.Add(d) }
	var l groupLimiter
	asks := 0
	ok := func() error { asks++; return nil }

	if err := l.do(clock, sleep, ok); err != nil || asks != 1 || slept != 0 {
		t.Fatalf("first request should go straight away: err=%v asks=%d slept=%v", err, asks, slept)
	}
	if err := l.do(clock, sleep, ok); err != nil || asks != 2 || slept != groupGap {
		t.Fatalf("second request should wait %v: asks=%d slept=%v", groupGap, asks, slept)
	}
	now = now.Add(time.Minute)
	limited := func() error { asks++; return errors.New("server returned error 429: rate-overlimit") }
	if err := l.do(clock, sleep, limited); err == nil || asks != 3 {
		t.Fatalf("the refused request should report its error")
	}
	if err := l.do(clock, sleep, ok); err != errSlowDown || asks != 3 {
		t.Fatalf("after a rate limit, requests should pause: err=%v asks=%d", err, asks)
	}
	now = now.Add(groupBackoff + time.Second)
	if err := l.do(clock, sleep, ok); err != nil || asks != 4 {
		t.Fatalf("after the pause, requests should resume: err=%v asks=%d", err, asks)
	}

	at := now.Add(-30 * time.Minute).UnixMilli()
	if !groupFreshAt(at, now) || groupFreshAt(now.Add(-2*time.Hour).UnixMilli(), now) || groupFreshAt(0, now) {
		t.Fatal("a saved member list counts as recent for an hour, and never when it has no time")
	}
}
