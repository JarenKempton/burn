// Server-rendered pages for the browser approval flow: login first, then
// request details. Nothing about a pending request is shown before login.

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const shell = (title: string, body: string) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · burn</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: system-ui, -apple-system, sans-serif; display: grid; place-items: center;
         min-height: 92vh; margin: 0; background: light-dark(#fafafa, #111);
         color: light-dark(#1a1a1a, #eee); }
  .card { width: min(24rem, 92vw); border: 1px solid light-dark(#e2e2e2, #333); border-radius: 12px;
          padding: 2rem; background: light-dark(#fff, #1b1b1b); box-shadow: 0 1px 8px rgb(0 0 0 / 0.06); }
  h1 { font-size: 1rem; letter-spacing: 0.08em; text-transform: lowercase; margin: 0 0 1.25rem; opacity: 0.6; }
  h2 { font-size: 1.15rem; margin: 0 0 1rem; }
  label { display: block; font-size: 0.85rem; opacity: 0.75; margin-bottom: 1rem; }
  input { width: 100%; padding: 0.6rem 0.7rem; margin-top: 0.35rem; box-sizing: border-box;
          border: 1px solid light-dark(#ccc, #444); border-radius: 8px; font-size: 1rem;
          background: transparent; color: inherit; }
  button { padding: 0.55rem 1.4rem; border-radius: 8px; border: 1px solid light-dark(#bbb, #555);
           cursor: pointer; background: transparent; color: inherit; font-size: 0.95rem; }
  button.primary { background: #166534; color: #fff; border-color: #166534; }
  .row { display: flex; gap: 0.6rem; margin-top: 1.25rem; }
  dl { margin: 1rem 0 0; } dt { font-size: 0.75rem; opacity: 0.55; margin-top: 0.7rem; }
  dd { margin: 0.1rem 0 0; font-size: 0.95rem; }
  .err { color: #b91c1c; font-size: 0.9rem; margin-bottom: 1rem; }
  .muted { font-size: 0.78rem; opacity: 0.5; margin-top: 1.5rem; }
  .who { font-size: 0.78rem; opacity: 0.5; float: right; }
</style></head><body><main class="card"><h1>burn</h1>${body}</main></body></html>`;

export function loginPage(next: string, error: string | null, usersExist: boolean): string {
  if (!usersExist)
    return shell(
      "Sign in",
      `<h2>No admin account yet</h2>
       <p>Create one on the server machine first — it's part of setup:</p>
       <p><code>burn server install</code> (or run <code>burn server run</code> in a terminal once)</p>`
    );
  return shell(
    "Sign in",
    `<h2>Sign in</h2>
     ${error ? `<p class="err">${esc(error)}</p>` : ""}
     <form method="post" action="/login">
       <input type="hidden" name="next" value="${esc(next)}">
       <label>Username<input name="username" autocomplete="username" autofocus required></label>
       <label>Password<input type="password" name="password" autocomplete="current-password" required></label>
       <button class="primary">Sign in</button>
     </form>`
  );
}

export function approvalPage(
  username: string,
  code: string,
  req: { request_id: string; user_code: string; node_name: string; platform: string; requested_at: string; status: string } | null
): string {
  if (!req)
    return shell(
      "Enrollment",
      `<span class="who">${esc(username)}</span><h2>No matching request</h2>
       <p>Nothing pending matches this link — it may have expired.</p>
       <p>Run <code>burn collector run</code> on the machine again.</p>`
    );
  if (req.status !== "pending")
    return shell(
      "Enrollment",
      `<span class="who">${esc(username)}</span><h2>Already ${esc(req.status)}</h2>
       <p>This request has already been decided.</p>`
    );
  return shell(
    "Approve machine",
    `<span class="who">${esc(username)}</span>
     <h2>A machine wants to join</h2>
     <dl>
       <dt>Machine</dt><dd>${esc(req.node_name)}</dd>
       <dt>Platform</dt><dd>${esc(req.platform)}</dd>
       <dt>Requested</dt><dd>${esc(req.requested_at)}</dd>
     </dl>
     <form method="post" action="/enroll/action" class="row">
       <input type="hidden" name="request_id" value="${esc(req.request_id)}">
       <button class="primary" name="action" value="approve">Approve</button>
       <button name="action" value="deny">Deny</button>
     </form>
     <p class="muted">Request ${esc(req.user_code)} — only approve if you just ran enrollment on this machine.</p>`
  );
}

export function approvalResultPage(message: string, ok: boolean): string {
  return shell("Enrollment", `<h2>${ok ? "Approved" : "Not approved"}</h2><p>${esc(message)}</p>`);
}
