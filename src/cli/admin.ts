import type { Database } from "bun:sqlite";
import { openServerDb } from "../server/db";
import { createUser, hasUsers } from "../server/auth";
import { promptText, promptHidden } from "./prompts";

export async function createAdminInteractive(db: Database): Promise<void> {
  console.log("Create your admin account — you'll use it in the browser to approve");
  console.log("machines that want to join this server.");
  for (let attempt = 0; attempt < 3; attempt++) {
    const username = promptText("Username:");
    const password = await promptHidden("Password (min 8 chars):");
    const confirm = await promptHidden("Confirm password:");
    if (password !== confirm) {
      console.log("Passwords don't match — try again.\n");
      continue;
    }
    try {
      await createUser(db, username, password);
      console.log(`✓ Admin account "${username}" created.`);
      return;
    } catch (err) {
      console.log(`${err instanceof Error ? err.message : err} — try again.\n`);
    }
  }
  console.error("Giving up after 3 attempts. Run `burn admin create` to try again.");
}

export async function cmdAdmin(sub: string | undefined): Promise<void> {
  if (sub === "create") {
    const db = openServerDb();
    try {
      await createAdminInteractive(db);
    } finally {
      db.close();
    }
    return;
  }
  const db = openServerDb();
  console.log(hasUsers(db) ? "Admin accounts exist." : "No admin account yet — run: burn admin create");
  db.close();
}
