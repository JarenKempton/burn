import { hostname } from "node:os";
import { BurnClient } from "./client";
import { loadCredentials, saveCredentials } from "../shared/config";
import { openBrowser } from "../shared/util";

const COLLECTOR_VERSION = "0.1.0";

/**
 * One-command enrollment (issue #7): create a device-authorization request,
 * open the browser approval page, poll, then exchange the private device code
 * for a node credential. No second terminal command.
 */
export async function enroll(serverUrl: string): Promise<void> {
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
  console.log(`  Confirmation code:  ${created.user_code}`);
  console.log(`  Approve at:         ${created.verification_url}`);
  console.log("");
  console.log("Waiting for an administrator to approve this node in the browser...");
  openBrowser(created.verification_url);

  const expires = Date.parse(created.expires_at);
  while (Date.now() < expires) {
    await Bun.sleep(created.poll_interval_seconds * 1000);
    const { status } = await client.pollEnrollment(created.request_id);
    if (status === "approved") {
      const issued = await client.exchangeToken(created.request_id, created.device_code);
      const creds = loadCredentials();
      creds.node = {
        node_id: issued.node_id,
        node_token: issued.node_token,
        server_url: issued.canonical_url,
      };
      saveCredentials(creds);
      console.log(`✅ Enrolled as node ${issued.node_id}`);
      console.log(`   Server: ${issued.canonical_url}`);
      console.log(`   Start reporting with: burn collector run`);
      return;
    }
    if (status === "denied") throw new Error("Enrollment was denied by the administrator");
    if (status === "expired") break;
  }
  throw new Error("Enrollment request expired before approval");
}
