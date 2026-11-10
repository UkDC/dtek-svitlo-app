import { SubsEnv, handleRequest, purgeStale } from './handler';

export default {
  fetch(request: Request, env: SubsEnv): Promise<Response> {
    return handleRequest(request, env);
  },
  // daily cron (see wrangler.toml): drop subscriptions of abandoned installs
  async scheduled(_event: unknown, env: SubsEnv): Promise<void> {
    const removed = await purgeStale(env);
    console.log(`[subs] purged ${removed} stale subscription(s)`);
  },
};
