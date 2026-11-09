/**
 * Fires the GitHub Actions "push-check" workflow via workflow_dispatch.
 *
 * Why this exists: GitHub's own `schedule:` cron is best-effort and is routinely delayed or skipped
 * (this repo saw ONE scheduled run in several hours). A Cloudflare Cron Trigger is reliable to the
 * minute, so it only has to knock on GitHub's door; the actual work still runs in Actions.
 */
export interface TriggerEnv {
  /** "owner/repo" that hosts the workflow */
  REPO: string;
  /** workflow file name, e.g. "push-check.yml" */
  WORKFLOW: string;
  /** branch to run on */
  REF: string;
  /** fine-grained PAT with ONLY "Actions: Read and write" on REPO (set via `wrangler secret put`) */
  GITHUB_TOKEN: string;
}

export async function dispatchWorkflow(
  env: TriggerEnv,
  fetchImpl: typeof fetch = fetch
): Promise<void> {
  const url = `https://api.github.com/repos/${env.REPO}/actions/workflows/${env.WORKFLOW}/dispatches`;
  const init: RequestInit = {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      // GitHub rejects API requests without a User-Agent
      'User-Agent': 'svitlo-cron-trigger',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ ref: env.REF }),
  };

  let lastStatus = 0;
  let lastBody = '';
  for (let attempt = 1; attempt <= 2; attempt++) {
    const res = await fetchImpl(url, init);
    if (res.status === 204) return; // dispatched
    lastStatus = res.status;
    lastBody = (await res.text().catch(() => '')).slice(0, 200);
    // Retry once on server-side hiccups only; 401/403/404/422 are configuration errors
    if (res.status < 500) break;
  }
  throw new Error(`workflow_dispatch failed: HTTP ${lastStatus} ${lastBody}`);
}
