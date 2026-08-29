import { hostname } from "node:os";
import { BurnClient } from "./client";
import { loadCredentials, saveCredentials } from "../shared/config";
import { openBrowser } from "../shared/util";

import { VERSION as COLLECTOR_VERSION } from "../shared/version";

/** After re-enrollment the server may be missing this machine's history
 * (e.g. it was reset). Resetting collection cursors makes the collector
 * re-read all provider logs and deliver everything again — idempotent for
 * anything the server already has. */
async function offerHistoryRebuild(): Promise<void> {
  const answer = (globalThis.prompt("Rebuild full usage history from this machine's local logs? [Y/n]") ?? "")
    .trim()
    .toLowerCase();
  if (answer.startsWith("n")) return;
  const { openCollectorDb } = await import("./db");
  const db = openCollectorDb();
  db.run("DELETE FROM cursors");
  db.close();
  console.log("   ✓ History will re-deliver on the next collection cycle.");
}

async function reachable(baseUrl: string): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl}/healthz`, { signal: AbortSignal.timeout(4000) });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * One-command enrollment (issue #7): create a device-authorization request,
 * open the browser approval page, poll, then exchange the private device code
 * for a node credential. No second terminal command.
 */
/**
 * `burn enroll` with no URL: verify the stored credential still works and
 * offer to repair it when it doesn't (e.g. the server was reset or this
 * node was revoked) — no dead ends.
 */
export async function enrollDefault(): Promise<void> {
  const node = loadCredentials().node;
  if (!node) {
    console.error("Usage: burn enroll <server-url>   (e.g. burn enroll https://yourserver.ts.net)");
    process.exit(1);
  }
  const client = new BurnClient(node.server_url, node.node_token);
  try {
    await client.whoami();
    console.log(`✓ Enrolled to ${node.server_url} (node ${node.node_id}) — credential works.`);
    console.log("To join a different server: burn enroll <server-url>");
    return;
  } catch (err) {
    if (!String(err).includes("401")) {
      console.error(`Can't verify enrollment: ${err instanceof Error ? err.message : err}`);
      process.exit(1);
    }
  }
  console.log(`⚠ ${node.server_url} rejected this machine's credential`);
  console.log("  (the server may have been reset, or this node was revoked).");
  const answer = (globalThis.prompt("Re-enroll with the same server now? [Y/n]") ?? "").trim().toLowerCase();
  if (answer.startsWith("n")) return;
  await enroll(node.server_url, { skipExistingConfirm: true });
}

export async function enroll(serverUrl: string, opts?: { skipExistingConfirm?: boolean }): Promise<void> {
  const existing = loadCredentials().node;
  if (existing && !opts?.skipExistingConfirm) {
    console.log(`This machine is already enrolled to ${existing.server_url} (node ${existing.node_id}).`);
    console.log("Re-enrolling creates a new node identity; the old one keeps its history");
    console.log("and can be revoked by an admin.");
    const answer = (globalThis.prompt("Re-enroll anyway? [y/N]") ?? "").trim().toLowerCase();
    if (!answer.startsWith("y")) {
      console.log("Keeping the existing enrollment.");
      return;
    }
  }

  const client = new BurnClient(serverUrl);

  const wk = await client.wellKnown();
  if (wk.product !== "burn") throw new Error(`${serverUrl} is not a Burn server`);
  console.log(`Found Burn server "${wk.server_name}" (protocol v${wk.protocol_version})`);
  if (!wk.enrollment_enabled) throw new Error("Server has enrollment disabled");

  const created = await client.createEnrollment({
    node_name: hostname(),
    platform: `${process.platform}/${process.arch}`,
    collector_version: COLLECTOR_VERSION,
  });

  console.log("");
  console.log("Approve this machine in your browser (sign in as the Burn admin):");
  console.log(`  ${created.verification_url}`);
  console.log("");
  console.log("Waiting for approval...");
  openBrowser(created.verification_url);

  const expires = Date.parse(created.expires_at);
  while (Date.now() < expires) {
    await Bun.sleep(created.poll_interval_seconds * 1000);
    const { status } = await client.pollEnrollment(created.request_id);
    if (status === "approved") {
      const issued = await client.exchangeToken(created.request_id, created.device_code);
      // Trust the server's canonical URL only if this machine can actually
      // reach it — a misconfigured proxy must not break the enrollment the
      // user just watched succeed over the URL they typed.
      let saveUrl = issued.canonical_url.replace(/\/+$/, "");
      if (saveUrl !== client.baseUrl && !(await reachable(saveUrl))) {
        console.log(`(server suggested ${saveUrl}, but it isn't reachable from here — keeping ${client.baseUrl})`);
        saveUrl = client.baseUrl;
      }
      const creds = loadCredentials();
      creds.node = {
        node_id: issued.node_id,
        node_token: issued.node_token,
        server_url: saveUrl,
      };
      saveCredentials(creds);
      console.log(`✅ Enrolled as node ${issued.node_id}`);
      console.log(`   Server: ${saveUrl}`);
      if (existing) await offerHistoryRebuild();
      console.log(`   Start reporting with: burn collector run`);
      return;
    }
    if (status === "denied") throw new Error("Enrollment was denied by the administrator");
    if (status === "expired") break;
  }
  throw new Error("Enrollment request expired before approval");
}
