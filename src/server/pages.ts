// Minimal server-rendered pages for browser enrollment approval.

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const shell = (title: string, body: string) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<style>
  body { font-family: system-ui, sans-serif; max-width: 32rem; margin: 4rem auto; padding: 0 1rem; color: #1a1a1a; }
  .card { border: 1px solid #ddd; border-radius: 8px; padding: 1.5rem; }
  .code { font-family: ui-monospace, monospace; font-size: 1.6rem; letter-spacing: 0.1em; }
  dt { color: #666; font-size: 0.85rem; } dd { margin: 0 0 0.75rem; }
  input[type=password] { width: 100%; padding: 0.5rem; margin: 0.5rem 0 1rem; box-sizing: border-box; }
  button { padding: 0.5rem 1.25rem; border-radius: 6px; border: 1px solid #999; cursor: pointer; background: #f5f5f5; }
  button.approve { background: #166534; color: white; border-color: #166534; }
</style></head><body><h1>burn</h1>${body}</body></html>`;

export function approvalPage(
  code: string,
  req: { request_id: string; user_code: string; node_name: string; platform: string; requested_at: string; status: string } | null
): string {
  if (!req)
    return shell(
      "Enrollment",
      `<div class="card"><p>No pending enrollment request matches code <span class="code">${esc(code)}</span>.</p>
       <p>It may have expired — run <code>burn enroll</code> again on the node.</p></div>`
    );
  if (req.status !== "pending")
    return shell("Enrollment", `<div class="card"><p>This request is already <strong>${esc(req.status)}</strong>.</p></div>`);
  return shell(
    "Approve enrollment",
    `<div class="card">
      <p>A node is requesting to join this Burn server. Confirm the code matches the one shown in the node's terminal:</p>
      <p class="code">${esc(req.user_code)}</p>
      <dl>
        <dt>Node name</dt><dd>${esc(req.node_name)}</dd>
        <dt>Platform</dt><dd>${esc(req.platform)}</dd>
        <dt>Requested</dt><dd>${esc(req.requested_at)}</dd>
      </dl>
      <form method="post" action="/enroll/action">
        <input type="hidden" name="request_id" value="${esc(req.request_id)}">
        <label>Admin token<br><input type="password" name="admin_token" autofocus required></label><br>
        <button class="approve" name="action" value="approve">Approve</button>
        <button name="action" value="deny">Deny</button>
      </form>
    </div>`
  );
}

export function approvalResultPage(message: string, ok: boolean): string {
  return shell("Enrollment", `<div class="card"><p>${ok ? "✅" : "⚠️"} ${esc(message)}</p></div>`);
}
