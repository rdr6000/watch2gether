interface ColumnDefinition {
  name: string;
  ddl: string;
}

const ROOM_META_COLUMNS: ColumnDefinition[] = [
  { name: "locked", ddl: "INTEGER NOT NULL DEFAULT 0" },
  { name: "max_peers", ddl: "INTEGER" },
  { name: "chat_enabled", ddl: "INTEGER NOT NULL DEFAULT 1" },
  { name: "voice_enabled", ddl: "INTEGER NOT NULL DEFAULT 1" },
  { name: "ever_had_second_peer", ddl: "INTEGER NOT NULL DEFAULT 0" },
  { name: "shared_subtitle_name", ddl: "TEXT" },
  { name: "shared_subtitle_content", ddl: "TEXT" }
];

/**
 * `CREATE TABLE IF NOT EXISTS` only helps a room's very first connection —
 * every room already created under an older schema keeps its old columns
 * forever, since SQLite doesn't retroactively apply a new CREATE TABLE to an
 * existing table. Concretely: local dev storage persists across `wrangler
 * dev` restarts, and in production every room that existed before a deploy
 * that adds a column would hit this. Add any column that's missing, with a
 * default matching what a brand-new room would have gotten.
 */
export function migrateRoomMetaTable(sql: SqlStorage): void {
  const existing = new Set(sql.exec<{ name: string }>("PRAGMA table_info(room_meta)").toArray().map((c) => c.name));
  for (const column of ROOM_META_COLUMNS) {
    if (!existing.has(column.name)) {
      sql.exec(`ALTER TABLE room_meta ADD COLUMN ${column.name} ${column.ddl}`);
    }
  }
}
