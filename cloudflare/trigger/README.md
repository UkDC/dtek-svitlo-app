# Cloudflare cron trigger

Calls GitHub's `workflow_dispatch` for `push-check.yml` every 5 minutes, because GitHub's built-in
`schedule:` cron is unreliable. Free Cloudflare plan is enough.

## One-time setup
1. Create a **fine-grained token** on GitHub: only the `UkDC/dtek-svitlo-app` repository, permission **Actions: Read and write**
   (nothing else). This token can start workflows, it cannot read or change code or secrets.
2. `wrangler.toml` already has `REPO = "UkDC/dtek-svitlo-app"` (change it only for a fork).
3. From this folder:
   ```bash
   npx wrangler login
   npx wrangler secret put GITHUB_TOKEN     # paste the token from step 1
   npx wrangler deploy
   ```
4. Check: Cloudflare dashboard → Workers → `svitlo-trigger` → Logs/Triggers; GitHub → Actions should show
   `workflow_dispatch` runs of "DTEK Schedule Sync & iOS Web Push Worker" every ~5 minutes.

## Notes
- The workflow keeps its own `schedule:` as a fallback; the dedup ledger makes double runs harmless.
- To stop everything: `npx wrangler delete`, and revoke the token on GitHub.
