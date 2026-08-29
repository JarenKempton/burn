import { chmodSync, renameSync, rmSync, statSync } from "node:fs";
import { join, dirname } from "node:path";

async function downloadWithCurl(url: string, dest: string): Promise<boolean> {
  try {
    const proc = Bun.spawn(["curl", "-fL", "--progress-bar", "-o", dest, url], {
      stdout: "inherit",
      stderr: "inherit", // curl draws its progress bar on stderr
    });
    return (await proc.exited) === 0;
  } catch {
    return false; // no curl — caller falls back to fetch
  }
}

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

  console.log(`Updating v${currentVersion} → v${latest} (~80 MB download) ...`);

  // Write beside the current binary, then rename over it — works even while
  // this very process is running (ETXTBSY only bites in-place writes).
  const target = process.execPath;
  const staging = join(dirname(target), `.burn-update-${process.pid}`);

  // Prefer curl: it shows progress and avoids Bun-fetch stalls seen with
  // these large redirected release streams in compiled binaries. Fetch is
  // the fallback for systems without curl.
  if (!(await downloadWithCurl(asset.browser_download_url, staging))) {
    const download = await fetch(asset.browser_download_url, { signal: AbortSignal.timeout(300_000) });
    if (!download.ok) throw new Error(`download failed: HTTP ${download.status}`);
    await Bun.write(staging, await download.arrayBuffer());
  }

  const size = statSync(staging).size;
  if (size < 1_000_000) {
    rmSync(staging, { force: true });
    throw new Error(`download looks truncated (${size} bytes)`);
  }
  console.log(`Downloaded ${(size / 1024 / 1024).toFixed(1)} MB.`);
  chmodSync(staging, 0o755);
  renameSync(staging, target);
  console.log(`✓ Updated to v${latest}. Restart any running burn server/collector to use it.`);
}
