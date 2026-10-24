package main

import (
	"context"
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
