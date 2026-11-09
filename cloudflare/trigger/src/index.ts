import { TriggerEnv, dispatchWorkflow } from './dispatch';

export default {
  // Runs on the cron schedule from wrangler.toml
  async scheduled(_event: unknown, env: TriggerEnv): Promise<void> {
    await dispatchWorkflow(env); // a thrown error shows up in the Worker's logs / "Errors" metric
  },
};
