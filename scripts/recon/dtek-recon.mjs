// TEMPORARY reconnaissance (plan step 2). Run only from a GitHub Actions runner.
// Prints STRUCTURE ONLY (status, sizes, key names, counts). Never prints response bodies.
// Neutral test address: first entries of DTEK's own lists, never a real user's address.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SITE = process.env.RECON_SITE || 'https://www.dtek-krem.com.ua';
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15';
const dir = mkdtempSync(join(tmpdir(), 'recon-'));
const jar = join(dir, 'jar.txt');

function curl(args, outFile) {
  const out = execFileSync(
    'curl',
    ['-sS', '--max-time', '40', '-A', UA, '-c', jar, '-b', jar, '-o', outFile, '-w', '%{http_code} %{size_download} %{time_total}', ...args],
    { encoding: 'utf8' },
  );
  const [code, size, time] = out.trim().split(' ');
  return { code: Number(code), size: Number(size), time: Number(time) };
}

const shape = (v, depth = 0) => {
  if (Array.isArray(v)) return `array(${v.length})` + (v.length && depth < 1 ? `<${shape(v[0], depth + 1)}>` : '');
  if (v && typeof v === 'object') {
    const keys = Object.keys(v);
    return `object(${keys.length}keys:${keys.slice(0, 8).join(',')}${keys.length > 8 ? ',…' : ''})`;
  }
  return typeof v;
};

console.log(`[recon] site=${SITE} runner=${process.env.RUNNER_NAME ? 'actions' : 'local'} at=${new Date().toISOString()}`);

const pageFile = join(dir, 'page.html');
const page = curl(
  ['-H', 'Accept: text/html,application/xhtml+xml', '-H', 'Accept-Language: uk-UA,uk;q=0.9', `${SITE}/ua/shutdowns`],
  pageFile,
);
console.log(`[recon] page status=${page.code} bytes=${page.size} time=${page.time}s`);
if (page.code !== 200 || page.size < 20000) {
  console.log('[recon] RESULT=BLOCKED_OR_STUB (page too small / non-200)');
  process.exit(0);
}
const html = readFileSync(pageFile, 'utf8');
const csrf = html.match(/<meta[^>]+name="csrf-token"[^>]+content="([^"]+)"/i)?.[1];
console.log(`[recon] csrf-meta=${csrf ? 'present(len ' + csrf.length + ')' : 'ABSENT'}`);

// Embedded data: DisconSchedule.<name> = <json|literal>;
const assigns = [...html.matchAll(/DisconSchedule\.([A-Za-z_]+)\s*=\s*/g)].map((m) => ({ name: m[1], idx: m.index + m[0].length }));
const data = {};
for (const a of assigns) {
  const start = html[a.idx];
  if (start !== '{' && start !== '[') {
    console.log(`[recon] DisconSchedule.${a.name} = <${/^["']/.test(start) ? 'string' : 'literal'}>`);
    continue;
  }
  // Balanced-bracket JSON extraction.
  let depth = 0, inStr = false, esc = false, end = -1;
  for (let i = a.idx; i < html.length; i++) {
    const c = html[i];
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') { depth--; if (depth === 0) { end = i + 1; break; } }
  }
  if (end < 0) { console.log(`[recon] DisconSchedule.${a.name}: unterminated`); continue; }
  try {
    const parsed = JSON.parse(html.slice(a.idx, end));
    data[a.name] = parsed;
    console.log(`[recon] DisconSchedule.${a.name}: ${shape(parsed)} bytes=${end - a.idx}`);
  } catch {
    console.log(`[recon] DisconSchedule.${a.name}: not JSON (${end - a.idx} bytes)`);
  }
}

// AJAX protocol probe on a NEUTRAL address taken from DTEK's own city list.
const cities = Array.isArray(data.cities) ? data.cities : data.cities ? Object.values(data.cities) : [];
const cityName = typeof cities[0] === 'string' ? cities[0] : cities[0]?.name ?? cities[0]?.title;
console.log(`[recon] cities available=${cities.length} firstCityKnown=${Boolean(cityName)}`);

async function ajax(method, fields) {
  const body = new URLSearchParams();
  body.set('method', method);
  fields.forEach(([name, value], i) => {
    body.set(`data[${i}][name]`, name);
    body.set(`data[${i}][value]`, value);
  });
  const out = join(dir, `ajax-${method}.json`);
  writeFileSync(join(dir, 'body.txt'), body.toString());
  const r = curl(
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
    out,
  );
  let parsed;
  try { parsed = JSON.parse(readFileSync(out, 'utf8')); } catch { /* not JSON */ }
  console.log(`[recon] ajax ${method}: status=${r.code} bytes=${r.size} json=${parsed !== undefined} shape=${parsed !== undefined ? shape(parsed) : 'n/a'}`);
  return parsed;
}

if (csrf && cityName) {
  const streets = await ajax('getStreets', [['city', cityName]]);
  const streetList = streets?.data ?? streets;
  const street = Array.isArray(streetList) ? streetList[0] : streetList && typeof streetList === 'object' ? Object.values(streetList)[0] : undefined;
  const streetName = typeof street === 'string' ? street : street?.name;
  console.log(`[recon] streets sample available=${Boolean(streetName)}`);
  if (streetName) {
    const homes = await ajax('getHomeNum', [['city', cityName], ['street', streetName]]);
    const dataObj = homes?.data;
    if (dataObj && typeof dataObj === 'object') {
      const first = Object.entries(dataObj)[0];
      if (first) console.log(`[recon] getHomeNum entry shape: key=<house> value=${shape(first[1])} sub_type_reason=${JSON.stringify(first[1]?.sub_type_reason ?? null)}`);
    }
    for (const k of ['result', 'updateTimestamp', 'showCurOutageParam', 'showCurSchedule', 'showTableSchedule'])
      if (homes && k in homes) console.log(`[recon] getHomeNum top.${k}: ${shape(homes[k])}`);
  }
} else {
  console.log('[recon] skipped ajax (no csrf or no city list found); page-structure discovery only');
}
console.log('[recon] DONE');
