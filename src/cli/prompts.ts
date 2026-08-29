// Interactive prompt helpers for the CLI.

export function promptText(question: string): string {
  return (globalThis.prompt(question) ?? "").trim();
}

/** Read a line without echoing it (passwords). Falls back to visible input
 * when stdin isn't a TTY (pipes, tests). */
export async function promptHidden(question: string): Promise<string> {
  const stdin = process.stdin;
  if (!stdin.isTTY) return promptText(question);

  process.stdout.write(question + " ");
  stdin.setRawMode(true);
  stdin.resume();
  let value = "";
  return await new Promise<string>((resolve) => {
    const onData = (buf: Buffer) => {
      for (const ch of buf.toString("utf8")) {
        if (ch === "\r" || ch === "\n" || ch === "\u0004") {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off("data", onData);
          process.stdout.write("\n");
          resolve(value.trim());
          return;
        }
        if (ch === "\u0003") {
          // Ctrl-C
          stdin.setRawMode(false);
          process.stdout.write("\n");
          process.exit(130);
        }
        if (ch === "\u007f" || ch === "\b") value = value.slice(0, -1);
        else value += ch;
      }
    };
    stdin.on("data", onData);
  });
}
