import { chmodSync, renameSync } from "node:fs";
import { join, dirname } from "node:path";

// `burn update` — self-update from the latest GitHub release. Only works for
// the compiled binary; source checkouts update with git pull.

const REPO = "JarenKempton/burn";

export async function cmdUpdate(currentVersion: string): Promise<void> {
  if (process.execPath.endsWith("/bun")) {
    console.log("Running from source — update with: git pull && bun run build");
    return;
  }

  console.log("Checking for updates...");
  const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
    headers: { accept: "application/vnd.github+json" },
    signal: AbortSignal.timeout(15_000),
  });
  if (res.status === 404) {
    console.log("No releases published yet.");
    return;
  }
  if (!res.ok) throw new Error(`GitHub API returned HTTP ${res.status}`);
  const release = (await res.json()) as { tag_name: string; assets: { name: string; browser_download_url: string }[] };

  const latest = release.tag_name.replace(/^v/, "");
  if (latest === currentVersion) {
    console.log(`Already up to date (v${currentVersion}).`);
    return;
  }

  const os = process.platform === "darwin" ? "darwin" : "linux";
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  const asset = release.assets.find((a) => a.name === `burn-${os}-${arch}`);
  if (!asset) {
    console.error(`Release ${release.tag_name} has no build for ${os}-${arch}.`);
    process.exit(1);
  }

  console.log(`Updating v${currentVersion} → v${latest} ...`);
  const download = await fetch(asset.browser_download_url, { signal: AbortSignal.timeout(120_000) });
  if (!download.ok) throw new Error(`download failed: HTTP ${download.status}`);
  // Buffer explicitly: Bun.write(path, response) hangs forever on these
  // large redirected release streams (observed in compiled binaries, where
  // the eventual abort then exits silently with code 0).
  const bytes = await download.arrayBuffer();
  if (bytes.byteLength < 1_000_000)
    throw new Error(`download looks truncated (${bytes.byteLength} bytes)`);
  console.log(`Downloaded ${(bytes.byteLength / 1024 / 1024).toFixed(1)} MB.`);

  // Write beside the current binary, then rename over it — works even while
  // this very process is running (ETXTBSY only bites in-place writes).
  const target = process.execPath;
  const staging = join(dirname(target), `.burn-update-${process.pid}`);
  await Bun.write(staging, bytes);
  chmodSync(staging, 0o755);
  renameSync(staging, target);
  console.log(`✓ Updated to v${latest}. Restart any running burn server/collector to use it.`);
}
