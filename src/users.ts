import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import type { Identity } from "./auth.ts";
import { ensureSchema, getDatabase, LOCAL_USER, type Database } from "./database/database.ts";

/** Someone who signed in with Google. Everything they create is stored under their ID. */
export interface User {
  id: string;
  email: string;
  name: string;
}

const UserSchema = z.object({ id: z.string(), email: z.string(), name: z.string() });
const SESSION_DAYS = 30;
export const SESSION_SECONDS = SESSION_DAYS * 86_400;

const hash = (token: string) => createHash("sha256").update(token).digest("hex");

/**
 * Finds or creates the user for a Google account. The first time the owner
 * signs in they become the local user, so they keep the bots, jobs and plugins
 * created before sign-in was turned on.
 */
export async function signIn(identity: Identity, ownerEmail: string | undefined, database: Database = getDatabase()): Promise<User> {
  await ensureSchema(database);
  const find = async () => {
    const [row] = await database.query("SELECT id, email, name FROM users WHERE google_sub = ?", [identity.sub]);
    return row ? UserSchema.parse(row) : undefined;
  };
  const existing = await find();
  if (existing) {
    if (existing.email !== identity.email || existing.name !== identity.name) {
      await database.run("UPDATE users SET email = ?, name = ? WHERE id = ?", [identity.email, identity.name, existing.id]);
    }
    return { ...existing, email: identity.email, name: identity.name };
  }
  const insert = (id: string) => database.run(
    "INSERT INTO users (id, google_sub, email, name, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING",
    [id, identity.sub, identity.email, identity.name, new Date().toISOString()],
  );
  // If another Google account already took over the local user, the owner gets a fresh account.
  const claimed = identity.email === ownerEmail && (await insert(LOCAL_USER)).changes === 1;
  if (!claimed) await insert(randomBytes(12).toString("hex"));
  // A simultaneous first sign-in by the same account may have won the insert.
  const user = await find();
  if (!user) throw new Error("Could not create the user.");
  return user;
}

/** Starts a session and returns its token. Only the token's hash is stored. */
export async function createSession(userId: string, database: Database = getDatabase()): Promise<string> {
  await ensureSchema(database);
  const token = randomBytes(32).toString("base64url");
  const now = Date.now();
  await database.run("DELETE FROM sessions WHERE expires_at < ?", [new Date(now).toISOString()]);
  await database.run("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)", [
    hash(token), userId, new Date(now + SESSION_SECONDS * 1000).toISOString(),
  ]);
  return token;
}

/** The user a session token belongs to, or undefined if it is unknown or expired. */
export async function sessionUser(token: string, database: Database = getDatabase()): Promise<User | undefined> {
  await ensureSchema(database);
  const [row] = await database.query(
    "SELECT users.id AS id, users.email AS email, users.name AS name FROM sessions JOIN users ON users.id = sessions.user_id WHERE sessions.token_hash = ? AND sessions.expires_at > ?",
    [hash(token), new Date().toISOString()],
  );
  return row ? UserSchema.parse(row) : undefined;
}

export async function endSession(token: string, database: Database = getDatabase()): Promise<void> {
  await ensureSchema(database);
  await database.run("DELETE FROM sessions WHERE token_hash = ?", [hash(token)]);
}
