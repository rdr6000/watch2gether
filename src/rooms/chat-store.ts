import type { ChatMessageRecord } from "./types";

/** Rooms are ephemeral and unauthenticated — a bounded window of recent chatter is what matters, not a full log. */
const HISTORY_LIMIT = 300;

interface ChatMessageRow extends Record<string, SqlStorageValue> {
  id: string;
  sender_id: string;
  sender_name: string;
  body: string;
  sent_at: number;
}

/** Thin wrapper over the room's SQLite storage for chat history — kept out of room-durable-object.ts to keep that file wiring-only. */
export class ChatStore {
  constructor(private readonly sql: SqlStorage) {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS chat_messages (
        id TEXT PRIMARY KEY,
        sender_id TEXT NOT NULL,
        sender_name TEXT NOT NULL,
        body TEXT NOT NULL,
        sent_at INTEGER NOT NULL
      )
    `);
  }

  append(message: ChatMessageRecord): void {
    this.sql.exec(
      "INSERT INTO chat_messages (id, sender_id, sender_name, body, sent_at) VALUES (?, ?, ?, ?, ?)",
      message.id,
      message.senderId,
      message.senderName,
      message.body,
      message.sentAt
    );
    this.sql.exec(
      "DELETE FROM chat_messages WHERE id NOT IN (SELECT id FROM chat_messages ORDER BY sent_at DESC LIMIT ?)",
      HISTORY_LIMIT
    );
  }

  recent(): ChatMessageRecord[] {
    return this.sql
      .exec<ChatMessageRow>(
        "SELECT id, sender_id, sender_name, body, sent_at FROM chat_messages ORDER BY sent_at ASC LIMIT ?",
        HISTORY_LIMIT
      )
      .toArray()
      .map((row) => ({
        id: row.id,
        senderId: row.sender_id,
        senderName: row.sender_name,
        body: row.body,
        sentAt: row.sent_at
      }));
  }
}
