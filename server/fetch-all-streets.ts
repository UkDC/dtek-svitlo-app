import fs from 'node:fs';
import path from 'node:path';

const YASNO_STREETS_URL =
  'https://app.yasno.ua/api/blackout-service/public/shutdowns/addresses/v2/streets';

const ALPHABET = 'абвгґдеєжзиіїйклмнопрстуфхцчшщьюя0123456789'.split('');

const KIND_PREFIXES = [
  'вул. ',
  'пров. ',
  'просп. ',
  'бул. ',
  'шосе ',
  'наб. ',
  'узвіз ',
  'тупик ',
  'пл. ',
  'майдан ',
  'алея ',
  'садова ',
  'лінія ',
  'дорога ',
];

interface YasnoStreet {
  id: number;
  value: string;
}

async function queryStreets(q: string): Promise<YasnoStreet[]> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const url = `${YASNO_STREETS_URL}?regionId=25&dsoId=902&query=${encodeURIComponent(
        q
      )}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
      if (res.status === 404) return [];
      if (!res.ok) continue;
      const data = await res.json();
      if (Array.isArray(data)) return data as YasnoStreet[];
    } catch {
      await new Promise((r) => setTimeout(r, 300));
    }
  }
  return [];
}

async function main() {
  console.log('[StreetHarvester] Starting full Kyiv street index crawl...');
  const byId = new Map<number, string>();

  // Build initial queue of queries
  const queue: string[] = [];
  for (const kind of KIND_PREFIXES) {
    if (kind === 'вул. ' || kind === 'пров. ') {
      for (const ch of ALPHABET) {
        queue.push(`${kind}${ch}`);
      }
    } else {
      queue.push(kind.trim());
    }
  }

  let processed = 0;
  const CONCURRENCY = 12;

  async function worker() {
    while (queue.length > 0) {
      const q = queue.shift();
      if (!q) break;
      processed++;
      const list = await queryStreets(q);
      for (const item of list) {
        if (item && typeof item.id === 'number' && item.value) {
          byId.set(item.id, item.value);
        }
      }
      // If capped at 20, expand with next character (up to depth)
      if (list.length >= 20 && q.length < 11) {
        for (const ch of ALPHABET) {
          queue.push(`${q}${ch}`);
        }
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

  const sorted = Array.from(byId.entries())
    .map(([id, name]) => ({ id, name }))
    .sort((a, b) => a.name.localeCompare(b.name, 'uk'));

  console.log(
    `[StreetHarvester] Harvested ${sorted.length} unique Kyiv streets in ${processed} queries.`
  );

  const outState = path.resolve(process.cwd(), 'state/kyiv-streets.json');
  const outPub = path.resolve(process.cwd(), 'public/state/kyiv-streets.json');
  fs.mkdirSync(path.dirname(outState), { recursive: true });
  fs.mkdirSync(path.dirname(outPub), { recursive: true });

  const json = JSON.stringify(sorted);
  fs.writeFileSync(outState, json);
  fs.writeFileSync(outPub, json);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
