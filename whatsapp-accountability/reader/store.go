package main

import (
	"database/sql"
	"encoding/json"
	"path/filepath"
	"strings"
	"sync"
	"time"

	_ "modernc.org/sqlite"
)

// Store keeps group messages and group details on this computer only.
type Store struct {
	db *sql.DB
	mu sync.Mutex
}

// Message is one stored group message. Reactions are stored as their own
// rows with Kind "reaction", ReactionTo set and the emoji in Text.
type Message struct {
	ID         string   `json:"id"`
	At         int64    `json:"at"` // unix milliseconds
	SenderID   string   `json:"sender_id"`
	SenderName string   `json:"sender_name"`
	FromMe     bool     `json:"from_me"`
	Kind       string   `json:"kind"` // text, image, video, document, audio, sticker, location, contact, poll, reaction, other
	Text       string   `json:"text"`
	QuotedID   string   `json:"quoted_id,omitempty"`
	ReactionTo string   `json:"reaction_to,omitempty"`
	Mentions   []string `json:"mentions,omitempty"`
	Edited     bool     `json:"edited,omitempty"`
	Deleted    bool     `json:"deleted,omitempty"`
	chat       string
}

type Participant struct {
	ID    string `json:"id"`
	Name  string `json:"name"`
	Phone string `json:"phone"`
	Admin bool   `json:"admin"`
}

type GroupRecord struct {
	ID           string        `json:"id"`
	Name         string        `json:"name"`
	Participants []Participant `json:"participants"`
	UpdatedAt    int64         `json:"updated_at"`
	CreatedAt    int64         `json:"created_at"` // when the group was created on WhatsApp; 0 if unknown
}

func sqlitePath(dir, name string) string {
	return filepath.ToSlash(filepath.Join(dir, name)) +
		"?_pragma=foreign_keys(1)&_pragma=busy_timeout(10000)&_pragma=journal_mode(WAL)"
}

func OpenStore(dir string) (*Store, error) {
	db, err := sql.Open("sqlite", sqlitePath(dir, "messages.db"))
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	_, err = db.Exec(`
		CREATE TABLE IF NOT EXISTS messages (
			chat TEXT NOT NULL, id TEXT NOT NULL,
			sender TEXT, sender_name TEXT, ts INTEGER, from_me INTEGER,
			kind TEXT, text TEXT, quoted_id TEXT, reaction_to TEXT, mentions TEXT,
			edited INTEGER NOT NULL DEFAULT 0, deleted INTEGER NOT NULL DEFAULT 0,
			PRIMARY KEY (chat, id));
		CREATE INDEX IF NOT EXISTS messages_chat_ts ON messages (chat, ts);
		CREATE TABLE IF NOT EXISTS groups (
			id TEXT PRIMARY KEY, name TEXT, participants TEXT, updated INTEGER);`)
	if err != nil {
		db.Close()
		return nil, err
	}
	// 1.0.2 keeps each group's creation date. Older files get the column
	// added; it fills in on the next group list read.
	if _, err := db.Exec(`ALTER TABLE groups ADD COLUMN created INTEGER NOT NULL DEFAULT 0`); err != nil &&
		!strings.Contains(err.Error(), "duplicate column") {
		db.Close()
		return nil, err
	}
	return &Store{db: db}, nil
}

func (s *Store) Close() error { return s.db.Close() }

func (s *Store) SaveMessage(m Message) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	mentions, _ := json.Marshal(m.Mentions)
	// A message seen twice (live and in history sync) keeps its first copy.
	_, err := s.db.Exec(`INSERT OR IGNORE INTO messages
		(chat, id, sender, sender_name, ts, from_me, kind, text, quoted_id, reaction_to, mentions)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		m.chat, m.ID, m.SenderID, m.SenderName, m.At, m.FromMe, m.Kind, m.Text, m.QuotedID, m.ReactionTo, string(mentions))
	return err
}

// SaveReaction replaces the sender's earlier reaction to the same message.
// An empty emoji means the reaction was taken back.
func (s *Store) SaveReaction(m Message) error {
	s.mu.Lock()
	_, err := s.db.Exec(`DELETE FROM messages WHERE chat = ? AND kind = 'reaction' AND sender = ? AND reaction_to = ?`,
		m.chat, m.SenderID, m.ReactionTo)
	s.mu.Unlock()
	if err != nil || m.Text == "" {
		return err
	}
	return s.SaveMessage(m)
}

func (s *Store) MarkEdited(chat, id, text string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	_, err := s.db.Exec(`UPDATE messages SET text = ?, edited = 1 WHERE chat = ? AND id = ?`, text, chat, id)
	return err
}

func (s *Store) MarkDeleted(chat, id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	_, err := s.db.Exec(`UPDATE messages SET deleted = 1 WHERE chat = ? AND id = ?`, chat, id)
	return err
}

func (s *Store) Messages(chat string, since int64, limit int) ([]Message, bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	rows, err := s.db.Query(`SELECT id, sender, sender_name, ts, from_me, kind, text, quoted_id, reaction_to, mentions, edited, deleted
		FROM messages WHERE chat = ? AND ts >= ? ORDER BY ts, id LIMIT ?`, chat, since, limit+1)
	if err != nil {
		return nil, false, err
	}
	defer rows.Close()
	out := []Message{}
	for rows.Next() {
		var m Message
		var mentions sql.NullString
		var quoted, reactTo, name, text sql.NullString
		if err := rows.Scan(&m.ID, &m.SenderID, &name, &m.At, &m.FromMe, &m.Kind, &text, &quoted, &reactTo, &mentions, &m.Edited, &m.Deleted); err != nil {
			return nil, false, err
		}
		m.SenderName, m.Text, m.QuotedID, m.ReactionTo = name.String, text.String, quoted.String, reactTo.String
		if mentions.Valid && mentions.String != "" && mentions.String != "null" {
			_ = json.Unmarshal([]byte(mentions.String), &m.Mentions)
		}
		out = append(out, m)
	}
	more := len(out) > limit
	if more {
		out = out[:limit]
	}
	return out, more, rows.Err()
}

// LastSenderName returns the most recent WhatsApp profile name a sender used.
func (s *Store) LastSenderName(sender string) string {
	s.mu.Lock()
	defer s.mu.Unlock()
	var name sql.NullString
	_ = s.db.QueryRow(`SELECT sender_name FROM messages WHERE sender = ? AND sender_name <> '' ORDER BY ts DESC LIMIT 1`, sender).Scan(&name)
	return name.String
}

func (s *Store) SaveGroup(g GroupRecord) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	parts, _ := json.Marshal(g.Participants)
	_, err := s.db.Exec(`INSERT INTO groups (id, name, participants, updated, created) VALUES (?, ?, ?, ?, ?)
		ON CONFLICT(id) DO UPDATE SET name = excluded.name, participants = excluded.participants, updated = excluded.updated,
			created = CASE WHEN excluded.created > 0 THEN excluded.created ELSE groups.created END`,
		g.ID, g.Name, string(parts), g.UpdatedAt, g.CreatedAt)
	return err
}

// SaveGroupName records a name learned from history sync without touching members.
func (s *Store) SaveGroupName(id, name string) error {
	if strings.TrimSpace(name) == "" {
		return nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	_, err := s.db.Exec(`INSERT INTO groups (id, name, participants, updated) VALUES (?, ?, '[]', 0)
		ON CONFLICT(id) DO UPDATE SET name = excluded.name`, id, name)
	return err
}

func (s *Store) Group(id string) (GroupRecord, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	var g GroupRecord
	var parts sql.NullString
	var name sql.NullString
	err := s.db.QueryRow(`SELECT id, name, participants, updated, created FROM groups WHERE id = ?`, id).Scan(&g.ID, &name, &parts, &g.UpdatedAt, &g.CreatedAt)
	if err != nil {
		return g, false
	}
	g.Name = name.String
	_ = json.Unmarshal([]byte(parts.String), &g.Participants)
	if g.Participants == nil {
		g.Participants = []Participant{}
	}
	return g, true
}

type GroupSummary struct {
	ID            string `json:"id"`
	Name          string `json:"name"`
	Members       int    `json:"members"`
	MessageCount  int    `json:"message_count"`
	LastMessageAt int64  `json:"last_message_at"`
	CreatedAt     int64  `json:"created_at"` // 0 if unknown
}

func (s *Store) GroupSummaries() ([]GroupSummary, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	rows, err := s.db.Query(`
		SELECT g.id, g.name, g.participants,
		       (SELECT COUNT(*) FROM messages m WHERE m.chat = g.id AND m.kind <> 'reaction'),
		       (SELECT COALESCE(MAX(ts), 0) FROM messages m WHERE m.chat = g.id),
		       g.created
		FROM groups g`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []GroupSummary{}
	for rows.Next() {
		var g GroupSummary
		var name, parts sql.NullString
		if err := rows.Scan(&g.ID, &name, &parts, &g.MessageCount, &g.LastMessageAt, &g.CreatedAt); err != nil {
			return nil, err
		}
		g.Name = name.String
		var ps []Participant
		_ = json.Unmarshal([]byte(parts.String), &ps)
		g.Members = len(ps)
		out = append(out, g)
	}
	return out, rows.Err()
}

func (s *Store) Counts() (messages int, groups int, last int64) {
	s.mu.Lock()
	defer s.mu.Unlock()
	_ = s.db.QueryRow(`SELECT COUNT(*), COALESCE(MAX(ts), 0) FROM messages`).Scan(&messages, &last)
	_ = s.db.QueryRow(`SELECT COUNT(*) FROM groups`).Scan(&groups)
	return
}

func nowMs() int64 { return time.Now().UnixMilli() }
