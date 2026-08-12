/** Thin wrapper over the room's SQLite storage for bans — keyed by IP, since there are no accounts to key on. */
export class BanStore {
  constructor(private readonly sql: SqlStorage) {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS bans (
        ip TEXT PRIMARY KEY,
        banned_name TEXT NOT NULL,
        banned_at INTEGER NOT NULL
      )
    `);
  }

  isBanned(ip: string): boolean {
    return this.sql.exec("SELECT 1 FROM bans WHERE ip = ?", ip).toArray().length > 0;
  }

  ban(ip: string, name: string): void {
    this.sql.exec(
      "INSERT INTO bans (ip, banned_name, banned_at) VALUES (?, ?, ?) ON CONFLICT(ip) DO NOTHING",
      ip,
      name,
      Date.now()
    );
  }
}
