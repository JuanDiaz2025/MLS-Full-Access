package main

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"
	"go.mau.fi/whatsmeow/types"
)

// The dashboard can only call these four tools. All of them read; none of
// them can send anything to WhatsApp.

type noInput struct{}

type StatusOut struct {
	Linked         bool   `json:"linked"`
	Connected      bool   `json:"connected"`
	LoggedOut      bool   `json:"logged_out"`
	Phone          string `json:"phone"`
	MessagesStored int    `json:"messages_stored"`
	GroupsKnown    int    `json:"groups_known"`
	LastMessageAt  int64  `json:"last_message_at"`
	LastEventAt    int64  `json:"last_event_at"`
	Folder         string `json:"folder"`
	Version        string `json:"version"`
}

type GroupsOut struct {
	Groups    []GroupSummary `json:"groups"`
	Me        string         `json:"me"`
	FromCache bool           `json:"from_cache"`
}

type GroupIn struct {
	GroupID string `json:"group_id" jsonschema:"the group id from list_groups, ending in @g.us"`
}

type GroupOut struct {
	ID           string        `json:"id"`
	Name         string        `json:"name"`
	Me           string        `json:"me"`
	Participants []Participant `json:"participants"`
	UpdatedAt    int64         `json:"updated_at"`
	CreatedAt    int64         `json:"created_at"`
	FromCache    bool          `json:"from_cache"`
}

type MessagesIn struct {
	GroupID string `json:"group_id" jsonschema:"the group id from list_groups, ending in @g.us"`
	Since   int64  `json:"since,omitempty" jsonschema:"only messages at or after this time, in unix milliseconds"`
	Limit   int    `json:"limit,omitempty" jsonschema:"most messages to return, 1 to 2000 (default 1000)"`
}

type MessagesOut struct {
	Messages []Message `json:"messages"`
	More     bool      `json:"more"`
	Me       string    `json:"me"`
}

var errNotLinked = errors.New("WhatsApp Reader isn't linked to a phone yet. Double-click whatsapp-reader.exe and scan the QR code with WhatsApp.")

func readOnly() *mcp.ToolAnnotations { return &mcp.ToolAnnotations{ReadOnlyHint: true} }

func (r *Reader) linked(ctx context.Context) bool {
	if r.loggedOut.Load() {
		return false
	}
	dev, err := r.Device(ctx)
	return err == nil && dev.ID != nil
}

func addTools(s *mcp.Server, r *Reader) {
	var lastGroupsRefresh time.Time

	mcp.AddTool(s, &mcp.Tool{Name: "status", Annotations: readOnly(),
		Description: "Whether WhatsApp Reader is linked and connected, and how much it has saved."},
		func(ctx context.Context, _ *mcp.CallToolRequest, _ noInput) (*mcp.CallToolResult, StatusOut, error) {
			msgs, groups, last := r.store.Counts()
			out := StatusOut{
				Linked: r.linked(ctx), Connected: r.connected.Load(), LoggedOut: r.loggedOut.Load(),
				Phone: r.MyID(), MessagesStored: msgs, GroupsKnown: groups, LastMessageAt: last,
				LastEventAt: r.lastEvent.Load(), Folder: r.dir, Version: version,
			}
			return nil, out, nil
		})

	mcp.AddTool(s, &mcp.Tool{Name: "list_groups", Annotations: readOnly(),
		Description: "The WhatsApp groups the linked phone is in, with how many messages are saved for each."},
		func(ctx context.Context, _ *mcp.CallToolRequest, _ noInput) (*mcp.CallToolResult, GroupsOut, error) {
			if !r.linked(ctx) {
				return nil, GroupsOut{}, errNotLinked
			}
			fresh := false
			if r.connected.Load() && time.Since(lastGroupsRefresh) > time.Minute {
				r.refreshGroups()
				lastGroupsRefresh = time.Now()
				fresh = true
			}
			groups, err := r.store.GroupSummaries()
			if err != nil {
				return nil, GroupsOut{}, err
			}
			return nil, GroupsOut{Groups: groups, Me: r.MyID(), FromCache: !fresh}, nil
		})

	mcp.AddTool(s, &mcp.Tool{Name: "get_group", Annotations: readOnly(),
		Description: "One group's name and current members."},
		func(ctx context.Context, _ *mcp.CallToolRequest, in GroupIn) (*mcp.CallToolResult, GroupOut, error) {
			if !r.linked(ctx) {
				return nil, GroupOut{}, errNotLinked
			}
			jid, err := types.ParseJID(in.GroupID)
			if err != nil || jid.Server != types.GroupServer {
				return nil, GroupOut{}, errors.New("group_id must be a group id ending in @g.us")
			}
			g, fromCache, err := r.groupForTool(jid)
			if err != nil {
				return nil, GroupOut{}, fmt.Errorf("couldn't read this group's members: %w", err)
			}
			return nil, GroupOut{ID: g.ID, Name: g.Name, Me: r.MyID(), Participants: g.Participants, UpdatedAt: g.UpdatedAt, CreatedAt: g.CreatedAt, FromCache: fromCache}, nil
		})

	mcp.AddTool(s, &mcp.Tool{Name: "get_messages", Annotations: readOnly(),
		Description: "Saved messages and reactions from one group, oldest first, starting at a time."},
		func(ctx context.Context, _ *mcp.CallToolRequest, in MessagesIn) (*mcp.CallToolResult, MessagesOut, error) {
			if !r.linked(ctx) {
				return nil, MessagesOut{}, errNotLinked
			}
			limit := in.Limit
			if limit <= 0 || limit > 2000 {
				limit = 1000
			}
			msgs, more, err := r.store.Messages(in.GroupID, in.Since, limit)
			if err != nil {
				return nil, MessagesOut{}, err
			}
			return nil, MessagesOut{Messages: msgs, More: more, Me: r.MyID()}, nil
		})
}
