import { describe, expect, it, vi } from 'vitest';
import { TriggerEnv, dispatchWorkflow } from '../cloudflare/trigger/src/dispatch';

const env: TriggerEnv = {
  REPO: 'owner/svitlo',
  WORKFLOW: 'push-check.yml',
  REF: 'main',
  GITHUB_TOKEN: 'test-token',
};

// a 204 response must not carry a body
const res = (status: number, body = '') =>
  new Response(status === 204 ? null : body, { status });

describe('cloudflare trigger', () => {
  it('POSTs workflow_dispatch with auth, user-agent and ref', async () => {
    const f = vi.fn().mockResolvedValue(res(204));
    await dispatchWorkflow(env, f as unknown as typeof fetch);
    expect(f).toHaveBeenCalledTimes(1);
    const [url, init] = f.mock.calls[0];
    expect(url).toBe('https://api.github.com/repos/owner/svitlo/actions/workflows/push-check.yml/dispatches');
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Bearer test-token');
    expect(init.headers['User-Agent']).toBeTruthy();
    expect(JSON.parse(init.body)).toEqual({ ref: 'main' });
  });

  it('retries once on 5xx and then succeeds', async () => {
    const f = vi.fn().mockResolvedValueOnce(res(502)).mockResolvedValueOnce(res(204));
    await dispatchWorkflow(env, f as unknown as typeof fetch);
    expect(f).toHaveBeenCalledTimes(2);
  });

  it('does not retry configuration errors and surfaces them', async () => {
    const f = vi.fn().mockResolvedValue(res(403, 'Resource not accessible'));
    await expect(dispatchWorkflow(env, f as unknown as typeof fetch)).rejects.toThrow(/HTTP 403/);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('fails after two server errors', async () => {
    const f = vi.fn().mockResolvedValue(res(500));
    await expect(dispatchWorkflow(env, f as unknown as typeof fetch)).rejects.toThrow(/HTTP 500/);
    expect(f).toHaveBeenCalledTimes(2);
  });
});
