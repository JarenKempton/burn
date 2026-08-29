import { createHash, createHmac, randomBytes } from "node:crypto";

export function hmacHex(key: string, message: string): string {
  return createHmac("sha256", key).update(message).digest("hex");
}

export const newId = (): string => Bun.randomUUIDv7();

export const nowIso = (): string => new Date().toISOString();

export function newToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

/** short human-matchable code for enrollment approval, e.g. "BXKQ-7M2P" */
export function newUserCode(): string {
  const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // no 0/O/1/I/L
  const pick = () => alphabet[randomBytes(1)[0]! % alphabet.length]!;
  const part = (n: number) => Array.from({ length: n }, pick).join("");
  return `${part(4)}-${part(4)}`;
}

/** best-effort browser open; callers always print the URL too for headless use */
export function openBrowser(url: string): void {
  const cmd = process.platform === "darwin" ? "open" : "xdg-open";
  try {
    Bun.spawn([cmd, url], { stdout: "ignore", stderr: "ignore" });
  } catch {
    // headless is fine
  }
}

export function timingSafeEqualStr(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return ha.equals(hb);
}
