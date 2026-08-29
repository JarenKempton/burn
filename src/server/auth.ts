import type { Database } from "bun:sqlite";
import { nowIso } from "../shared/util";

// Admin accounts. Passwords are hashed with argon2id (Bun.password default)
// and verified server-side only; the browser approval page and HTTP Basic
// auth use these. The generated admin token remains the API credential for
// CLI/scripts.

export async function createUser(db: Database, username: string, password: string): Promise<void> {
  if (!username.trim()) throw new Error("Username cannot be empty");
  if (password.length < 8) throw new Error("Password must be at least 8 characters");
  const hash = await Bun.password.hash(password);
  try {
    db.run("INSERT INTO users (username, password_hash, created_at) VALUES (?, ?, ?)", [
      username.trim(),
      hash,
      nowIso(),
    ]);
  } catch (err) {
    if (String(err).includes("UNIQUE")) throw new Error(`User "${username.trim()}" already exists`);
    throw err;
  }
}

export function hasUsers(db: Database): boolean {
  return db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM users").get()!.n > 0;
}

export async function verifyUser(db: Database, username: string, password: string): Promise<boolean> {
  const row = db
    .query<{ password_hash: string }, [string]>("SELECT password_hash FROM users WHERE username = ?")
    .get(username.trim());
  if (!row) return false;
  return Bun.password.verify(password, row.password_hash);
}
