package main

import (
	"context"
	"database/sql"
	"fmt"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"go.mau.fi/whatsmeow"
	"go.mau.fi/whatsmeow/proto/waCompanionReg"
	"go.mau.fi/whatsmeow/proto/waE2E"
	"go.mau.fi/whatsmeow/store"
	"go.mau.fi/whatsmeow/store/sqlstore"
	"go.mau.fi/whatsmeow/types"
	"go.mau.fi/whatsmeow/types/events"
	waLog "go.mau.fi/whatsmeow/util/log"
)

// Reader holds the WhatsApp connection. It only listens: nothing in this
// program sends a message, a reaction, a read receipt or a typing status.
type Reader struct {
	dir       string
	log       waLog.Logger
	session   *sqlstore.Container
	store     *Store
	mu        sync.RWMutex
	cli       *whatsmeow.Client
	connected atomic.Bool
	loggedOut atomic.Bool
	lastEvent atomic.Int64
	history   atomic.Int64 // messages saved from history sync, for the link screen
}

func init() {
	store.SetOSInfo("WhatsApp Reader", [3]uint32{1, 0, 1})
	// Present as a desktop browser, the most common kind of linked device.
	store.DeviceProps.PlatformType = waCompanionReg.DeviceProps_CHROME.Enum()
}

func OpenReader(dir string, log waLog.Logger) (*Reader, error) {
	db, err := sql.Open("sqlite", sqlitePath(dir, "session.db"))
	if err != nil {
		return nil, err
	}
	session := sqlstore.NewWithDB(db, "sqlite3", log.Sub("Session"))
	if err := session.Upgrade(context.Background()); err != nil {
		return nil, fmt.Errorf("opening session store: %w", err)
	}
	st, err := OpenStore(dir)
	if err != nil {
		return nil, fmt.Errorf("opening message store: %w", err)
	}
	return &Reader{dir: dir, log: log, session: session, store: st}, nil
}

func (r *Reader) Close() {
	r.mu.RLock()
	cli := r.cli
	r.mu.RUnlock()
	if cli != nil {
		cli.Disconnect()
	}
	r.store.Close()
	r.session.Close()
}

// Device returns the linked device, or one ready to be linked.
func (r *Reader) Device(ctx context.Context) (*store.Device, error) {
	return r.session.GetFirstDevice(ctx)
}

func (r *Reader) Client() *whatsmeow.Client {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return r.cli
}

func (r *Reader) NewClient(dev *store.Device) *whatsmeow.Client {
	cli := whatsmeow.NewClient(dev, r.log.Sub("Client"))
	cli.AddEventHandler(r.handle)
	r.mu.Lock()
	r.cli = cli
	r.mu.Unlock()
	return cli
}

func (r *Reader) handle(evt any) {
	r.lastEvent.Store(nowMs())
	switch v := evt.(type) {
	case *events.Message:
		r.saveEvent(context.Background(), v)
	case *events.HistorySync:
		r.saveHistory(v)
	case *events.Connected:
		r.connected.Store(true)
		r.log.Infof("Connected to WhatsApp")
		go r.refreshGroups()
	case *events.Disconnected:
		r.connected.Store(false)
	case *events.LoggedOut:
		r.connected.Store(false)
		r.loggedOut.Store(true)
		r.log.Warnf("WhatsApp logged this device out. Run whatsapp-reader.exe again to link it.")
	case *events.StreamReplaced:
		r.connected.Store(false)
		r.log.Warnf("Another copy of WhatsApp Reader connected with the same link, so this one stopped.")
	case *events.GroupInfo:
		go r.refreshGroup(v.JID)
	case *events.JoinedGroup:
		go r.refreshGroup(v.JID)
	}
}

// ---- identities ----

// personID gives everyone one stable id: their phone number when known,
// otherwise WhatsApp's hidden id with an "@lid" suffix.
func (r *Reader) personID(ctx context.Context, j types.JID) string {
	if j.IsEmpty() {
		return ""
	}
	j = j.ToNonAD()
	if j.Server == types.HiddenUserServer {
		if cli := r.Client(); cli != nil && cli.Store != nil && cli.Store.LIDs != nil {
			if pn, err := cli.Store.LIDs.GetPNForLID(ctx, j); err == nil && !pn.IsEmpty() {
				return pn.User
			}
		}
		return j.User + "@lid"
	}
	return j.User
}

func (r *Reader) personIDString(ctx context.Context, s string) string {
	if s == "" {
		return ""
	}
	j, err := types.ParseJID(s)
	if err != nil {
		return s
	}
	return r.personID(ctx, j)
}

func (r *Reader) senderID(ctx context.Context, info types.MessageInfo) string {
	if info.IsFromMe {
		if cli := r.Client(); cli != nil && cli.Store != nil && cli.Store.ID != nil {
			return cli.Store.ID.User
		}
	}
	if info.Sender.Server == types.HiddenUserServer && info.SenderAlt.Server == types.DefaultUserServer {
		return info.SenderAlt.User
	}
	return r.personID(ctx, info.Sender)
}

func (r *Reader) displayName(ctx context.Context, id string) string {
	cli := r.Client()
	if cli != nil && cli.Store != nil && cli.Store.Contacts != nil {
		var jid types.JID
		if strings.HasSuffix(id, "@lid") {
			jid = types.NewJID(strings.TrimSuffix(id, "@lid"), types.HiddenUserServer)
		} else {
			jid = types.NewJID(id, types.DefaultUserServer)
		}
		if c, err := cli.Store.Contacts.GetContact(ctx, jid); err == nil && c.Found {
			for _, n := range []string{c.FullName, c.FirstName, c.PushName, c.BusinessName} {
				if strings.TrimSpace(n) != "" {
					return n
				}
			}
		}
	}
	if n := r.store.LastSenderName(id); n != "" {
		return n
	}
	if strings.HasSuffix(id, "@lid") {
		return "Unknown member"
	}
	return "+" + id
}

// ---- messages ----

func contextOf(m *waE2E.Message) *waE2E.ContextInfo {
	switch {
	case m.GetExtendedTextMessage() != nil:
		return m.GetExtendedTextMessage().GetContextInfo()
	case m.GetImageMessage() != nil:
		return m.GetImageMessage().GetContextInfo()
	case m.GetVideoMessage() != nil:
		return m.GetVideoMessage().GetContextInfo()
	case m.GetDocumentMessage() != nil:
		return m.GetDocumentMessage().GetContextInfo()
	case m.GetAudioMessage() != nil:
		return m.GetAudioMessage().GetContextInfo()
	case m.GetStickerMessage() != nil:
		return m.GetStickerMessage().GetContextInfo()
	case m.GetLocationMessage() != nil:
		return m.GetLocationMessage().GetContextInfo()
	case m.GetContactMessage() != nil:
		return m.GetContactMessage().GetContextInfo()
	}
	return nil
}

// classify returns what kind of message this is and its readable text.
// An empty kind means there is nothing a person would see (key exchanges etc).
func classify(m *waE2E.Message) (kind, text string) {
	switch {
	case m.GetConversation() != "":
		return "text", m.GetConversation()
	case m.GetExtendedTextMessage() != nil:
		return "text", m.GetExtendedTextMessage().GetText()
	case m.GetImageMessage() != nil:
		return "image", m.GetImageMessage().GetCaption()
	case m.GetVideoMessage() != nil:
		return "video", m.GetVideoMessage().GetCaption()
	case m.GetDocumentMessage() != nil:
		d := m.GetDocumentMessage()
		text = d.GetFileName()
		if d.GetCaption() != "" {
			text = strings.TrimSpace(text + "\n" + d.GetCaption())
		}
		return "document", text
	case m.GetAudioMessage() != nil:
		return "audio", ""
	case m.GetStickerMessage() != nil:
		return "sticker", ""
	case m.GetLocationMessage() != nil:
		return "location", m.GetLocationMessage().GetName()
	case m.GetContactMessage() != nil:
		return "contact", m.GetContactMessage().GetDisplayName()
	case m.GetPollCreationMessage() != nil:
		return "poll", m.GetPollCreationMessage().GetName()
	case m.GetPollCreationMessageV3() != nil:
		return "poll", m.GetPollCreationMessageV3().GetName()
	}
	return "", ""
}

func (r *Reader) saveEvent(ctx context.Context, evt *events.Message) {
	if evt == nil || evt.Message == nil || evt.Info.Chat.Server != types.GroupServer {
		return // only group chats are kept; one-to-one chats are never stored
	}
	chat := evt.Info.Chat.String()
	m := evt.Message

	if pm := m.GetProtocolMessage(); pm != nil {
		target := pm.GetKey().GetID()
		switch pm.GetType() {
		case waE2E.ProtocolMessage_REVOKE:
			_ = r.store.MarkDeleted(chat, target)
		case waE2E.ProtocolMessage_MESSAGE_EDIT:
			if _, text := classify(pm.GetEditedMessage()); text != "" {
				_ = r.store.MarkEdited(chat, target, text)
			}
		}
		return
	}

	base := Message{
		chat:       chat,
		ID:         evt.Info.ID,
		At:         evt.Info.Timestamp.UnixMilli(),
		SenderID:   r.senderID(ctx, evt.Info),
		SenderName: evt.Info.PushName,
		FromMe:     evt.Info.IsFromMe,
	}

	if rm := m.GetReactionMessage(); rm != nil {
		base.Kind = "reaction"
		base.Text = rm.GetText()
		base.ReactionTo = rm.GetKey().GetID()
		if err := r.store.SaveReaction(base); err != nil {
			r.log.Warnf("Saving a reaction failed: %v", err)
		}
		return
	}

	kind, text := classify(m)
	if kind == "" {
		return
	}
	base.Kind, base.Text = kind, text
	if ci := contextOf(m); ci != nil {
		base.QuotedID = ci.GetStanzaID()
		for _, mj := range ci.GetMentionedJID() {
			if id := r.personIDString(ctx, mj); id != "" {
				base.Mentions = append(base.Mentions, id)
			}
		}
	}
	if err := r.store.SaveMessage(base); err != nil {
		r.log.Warnf("Saving a message failed: %v", err)
	}
}

func (r *Reader) saveHistory(evt *events.HistorySync) {
	cli := r.Client()
	if cli == nil || evt.Data == nil {
		return
	}
	ctx := context.Background()
	for _, conv := range evt.Data.GetConversations() {
		jid, err := types.ParseJID(conv.GetID())
		if err != nil || jid.Server != types.GroupServer {
			continue
		}
		_ = r.store.SaveGroupName(jid.String(), conv.GetName())
		for _, hm := range conv.GetMessages() {
			parsed, err := cli.ParseWebMessage(jid, hm.GetMessage())
			if err != nil {
				continue
			}
			r.saveEvent(ctx, parsed)
			r.history.Add(1)
		}
	}
}

// ---- groups ----

func (r *Reader) groupRecord(ctx context.Context, info *types.GroupInfo) GroupRecord {
	g := GroupRecord{ID: info.JID.String(), Name: info.Name, UpdatedAt: nowMs(), Participants: []Participant{}}
	if !info.GroupCreated.IsZero() {
		g.CreatedAt = info.GroupCreated.UnixMilli()
	}
	for _, p := range info.Participants {
		id := ""
		if !p.PhoneNumber.IsEmpty() {
			id = p.PhoneNumber.User
		} else {
			id = r.personID(ctx, p.JID)
		}
		phone := ""
		if !strings.HasSuffix(id, "@lid") {
			phone = "+" + id
		}
		g.Participants = append(g.Participants, Participant{
			ID: id, Name: r.displayName(ctx, id), Phone: phone, Admin: p.IsAdmin || p.IsSuperAdmin,
		})
	}
	return g
}

func (r *Reader) refreshGroups() {
	cli := r.Client()
	if cli == nil || !r.connected.Load() {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	groups, err := cli.GetJoinedGroups(ctx)
	if err != nil {
		r.log.Warnf("Reading the group list failed: %v", err)
		return
	}
	for _, info := range groups {
		_ = r.store.SaveGroup(r.groupRecord(ctx, info))
	}
}

func (r *Reader) refreshGroup(jid types.JID) (GroupRecord, error) {
	cli := r.Client()
	if cli == nil || !r.connected.Load() {
		return GroupRecord{}, fmt.Errorf("not connected")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	info, err := cli.GetGroupInfo(ctx, jid)
	if err != nil {
		return GroupRecord{}, err
	}
	g := r.groupRecord(ctx, info)
	return g, r.store.SaveGroup(g)
}

func (r *Reader) MyID() string {
	if cli := r.Client(); cli != nil && cli.Store != nil && cli.Store.ID != nil {
		return cli.Store.ID.User
	}
	return ""
}
