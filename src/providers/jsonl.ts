import { statSync, openSync, readSync, closeSync } from "node:fs";
import type { Database } from "bun:sqlite";
import { getCursor, setCursor } from "../collector/db";

// Incremental JSONL log collection shared by the Claude Code and Codex
// adapters. Both providers stream multiple lines per request into active
// session files, so we only consume a file once it has quiesced (mtime older
// than QUIESCE_MS); per-file byte cursors make each region read exactly once,
// which keeps ingestion idempotent across restarts.

export const QUIESCE_MS = 120_000;

export interface JsonlRegion {
  file: string;
  lines: unknown[];
  newOffset: number;
}

/** Read new complete lines past the stored cursor for a quiesced file. */
export function readNewRegion(db: Database, providerId: string, file: string): JsonlRegion | null {
  let st;
  try {
    st = statSync(file);
  } catch {
    return null;
  }
  if (Date.now() - st.mtimeMs < QUIESCE_MS) return null;

  const cursorKey = `offset:${file}`;
  const offset = Number(getCursor(db, providerId, cursorKey) ?? 0);
  if (st.size <= offset) return null;

  const fd = openSync(file, "r");
  let text: string;
  try {
    const buf = Buffer.alloc(st.size - offset);
    const read = readSync(fd, buf, 0, buf.length, offset);
    text = buf.subarray(0, read).toString("utf8");
  } finally {
    closeSync(fd);
  }

  // Only consume up to the last newline; a torn final line stays for later.
  const lastNewline = text.lastIndexOf("\n");
  if (lastNewline < 0) return null;
  const consumed = text.slice(0, lastNewline + 1);
  const newOffset = offset + Buffer.byteLength(consumed, "utf8");

  const lines: unknown[] = [];
  for (const line of consumed.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      lines.push(JSON.parse(trimmed));
    } catch {
      // Skip malformed lines rather than failing the whole region.
    }
  }
  return { file, lines, newOffset };
}

export function commitRegion(db: Database, providerId: string, region: JsonlRegion): void {
  setCursor(db, providerId, `offset:${region.file}`, String(region.newOffset));
}
