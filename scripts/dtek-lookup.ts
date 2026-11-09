/**
 * Runs on a GitHub Actions runner (Cloudflare Workers are blocked by DTEK's Imperva, runners are not).
 *
 *   1. fetch the one-time job from the Worker   (GET  /internal/job?id=…)
 *   2. look the address up on dtek-krem.com.ua  (plain curl + cookie jar)
 *   3. hand the result back to the Worker       (POST /internal/result?id=…)
 *
 * The repository is public, so this script NEVER prints the address, DTEK responses or the secret.
 * Plain `node scripts/dtek-lookup.ts` (Node >= 23.6 strips types); no dependencies.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseJob, runLookup } from './dtek/lookupRun.ts';
import type { AjaxResponse, DtekTransport, PageResponse } from './dtek/lookupRun.ts';
import type { LookupResult } from './dtek/lookupCore.ts';

const SITE = 'https://www.dtek-krem.com.ua';
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15';

const log = (msg: string) => console.log(`[lookup] ${msg}`);
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

function curlTransport(dir: string): DtekTransport {
  const jar = join(dir, 'jar.txt');
  const run = (args: string[], outFile: string) => {
    const out = execFileSync(
      'curl',
      ['-sS', '--max-time', '40', '-A', UA, '-c', jar, '-b', jar, '-o', outFile, '-w', '%{http_code} %{size_download}', ...args],
      { encoding: 'utf8' }
    );
    const [code, size] = out.trim().split(' ');
    return { status: Number(code), bytes: Number(size) };
  };
  return {
    async page(): Promise<PageResponse> {
      const file = join(dir, 'page.html');
      let last: PageResponse = { status: 0, bytes: 0, html: '' };
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          const r = run(
            ['-H', 'Accept: text/html,application/xhtml+xml', '-H', 'Accept-Language: uk-UA,uk;q=0.9', `${SITE}/ua/shutdowns`],
            file
          );
          last = { ...r, html: r.bytes > 0 ? readFileSync(file, 'utf8') : '' };
          if (r.status === 200 && r.bytes >= 20000) return last;
        } catch {
          // curl failure (timeout, DNS): retried once below
        }
        if (attempt < 2) await wait(3000);
      }
      return last;
    },
    async homes(csrf: string, city: string, street: string): Promise<AjaxResponse> {
      const body = new URLSearchParams();
      body.set('method', 'getHomeNum');
      body.set('data[0][name]', 'city');
      body.set('data[0][value]', city);
      body.set('data[1][name]', 'street');
      body.set('data[1][value]', street);
      writeFileSync(join(dir, 'body.txt'), body.toString());
      const out = join(dir, 'ajax.json');
      try {
        const r = run(
          [
            '-X', 'POST', `${SITE}/ua/ajax`,
            '-H', `X-CSRF-Token: ${csrf}`,
            '-H', 'X-Requested-With: XMLHttpRequest',
            '-H', 'Content-Type: application/x-www-form-urlencoded; charset=UTF-8',
            '-H', 'Accept: application/json, text/javascript, */*; q=0.01',
            '-H', `Origin: ${SITE}`,
            '-H', `Referer: ${SITE}/ua/shutdowns`,
            '--data-binary', `@${join(dir, 'body.txt')}`,
          ],
          out
        );
        let json: unknown;
        try {
          json = JSON.parse(readFileSync(out, 'utf8'));
        } catch {
          // not JSON
        }
        return { ...r, json };
      } catch {
        return { status: 0, bytes: 0 };
      }
    },
  };
}

async function api(base: string, secret: string, method: string, path: string, body?: unknown) {
  return fetch(`${base}${path}`, {
    method,
    headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

/** The job is written to KV a moment before the dispatch, but KV is eventually consistent. */
async function fetchJob(base: string, secret: string, id: string) {
  const deadline = Date.now() + 90_000;
  for (let n = 0; Date.now() < deadline; n++) {
    try {
      const res = await api(base, secret, 'GET', `/internal/job?id=${id}`);
      if (res.status === 200) return parseJob(await res.json());
      if (res.status === 401 || res.status === 403) {
        log('worker rejected the secret');
        return undefined;
      }
      log(`job not available yet (HTTP ${res.status})`);
    } catch {
      log('worker unreachable, retrying');
    }
    await wait(Math.min(2000 * (n + 1), 10_000));
  }
  return undefined;
}

async function postResult(base: string, secret: string, id: string, result: LookupResult) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await api(base, secret, 'POST', `/internal/result?id=${id}`, result);
      if (res.ok) return true;
      log(`result rejected: HTTP ${res.status}`);
      if (res.status < 500) return false;
    } catch {
      log('posting result failed, retrying');
    }
    await wait(2000 * attempt);
  }
  return false;
}

async function main() {
  const id = process.env.JOB_ID ?? '';
  const base = (process.env.LOOKUP_API_URL ?? '').replace(/\/+$/, '');
  const secret = process.env.LOOKUP_SECRET ?? '';
  if (!/^[0-9a-f]{32}$/.test(id) || !base.startsWith('https://') || !secret) {
    log('missing or invalid configuration');
    process.exit(1);
  }

  const job = await fetchJob(base, secret, id);
  if (!job) {
    log('no usable job');
    process.exit(1);
  }

  const dir = mkdtempSync(join(tmpdir(), 'lookup-'));
  let result: LookupResult;
  try {
    result = await runLookup(job, curlTransport(dir));
  } catch {
    result = { ok: false, reason: 'parse' };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  // outcome only: no address, no DTEK content
  log(result.ok ? 'result: ok' : `result: ${result.reason}`);
  if (!(await postResult(base, secret, id, result))) process.exit(1);
}

await main();
