import { configPath, credentialsPath, stateDir, logDir } from "../shared/paths";
import { loadConfig, loadCredentials } from "../shared/config";

export async function cmdConfig(): Promise<void> {
  const cfg = loadConfig();
  const creds = loadCredentials();
  console.log("Paths:");
  console.log(`  config:      ${configPath()}`);
  console.log(`  credentials: ${credentialsPath()} (mode 0600)`);
  console.log(`  state:       ${stateDir()}`);
  console.log(`  logs:        ${logDir()}`);
  console.log("\nConfig:");
  console.log(JSON.stringify(cfg, null, 2));
  if (creds.admin_token) {
    console.log(`\nAdmin token (for the browser approval page and /v1 queries):`);
    console.log(`  ${creds.admin_token}`);
  }
  if (creds.node) {
    console.log(`\nEnrolled node: ${creds.node.node_id} → ${creds.node.server_url}`);
  }
}
