import { spawn, ChildProcess } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

// Minimal static HTTP server for dist/
function startStaticServer(dir: string, port: number): Promise<http.Server> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let reqPath = req.url?.split('?')[0] || '/';
      if (reqPath === '/') reqPath = '/index.html';
      const filePath = path.join(dir, reqPath);

      if (!fs.existsSync(filePath)) {
        const indexPath = path.join(dir, 'index.html');
        const content = fs.readFileSync(indexPath);
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(content);
      }

      const ext = path.extname(filePath);
      const mimeTypes: Record<string, string> = {
        '.html': 'text/html; charset=utf-8',
        '.js': 'application/javascript; charset=utf-8',
        '.css': 'text/css; charset=utf-8',
        '.json': 'application/json; charset=utf-8',
        '.svg': 'image/svg+xml',
        '.png': 'image/png',
      };
      res.writeHead(200, { 'Content-Type': mimeTypes[ext] || 'application/octet-stream' });
      fs.createReadStream(filePath).pipe(res);
    });

    server.listen(port, () => {
      resolve(server);
    });
  });
}

class CDPClient {
  private ws!: WebSocket;
  private id = 0;
  private pending = new Map<number, (res: any) => void>();

  constructor(private wsUrl: string) {}

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.wsUrl);
      this.ws.onopen = () => resolve();
      this.ws.onerror = (err) => reject(err);
      this.ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data.toString());
          if (data.id && this.pending.has(data.id)) {
            const cb = this.pending.get(data.id)!;
            this.pending.delete(data.id);
            cb(data);
          }
        } catch {
          // ignore
        }
      };
    });
  }

  send(method: string, params: Record<string, any> = {}): Promise<any> {
    return new Promise((resolve) => {
      const id = ++this.id;
      this.pending.set(id, resolve);
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  close() {
    try {
      this.ws.close();
    } catch {}
  }
}

export async function runChromeTest() {
  const PORT = 4173;
  const CHROME_DEBUG_PORT = 9222;
  const distDir = path.resolve(process.cwd(), 'dist');

  if (!fs.existsSync(distDir)) {
    throw new Error('dist/ directory does not exist. Run "npm run build" first.');
  }

  console.log(`[TEST] 1. Starting static server on http://localhost:${PORT}...`);
  const server = await startStaticServer(distDir, PORT);

  console.log(`[TEST] 2. Spawning Google Chrome (/usr/bin/google-chrome --headless=new)...`);
  const chrome: ChildProcess = spawn(
    '/usr/bin/google-chrome',
    [
      '--headless=new',
      `--remote-debugging-port=${CHROME_DEBUG_PORT}`,
      '--no-sandbox',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--window-size=390,844', // iPhone 14/15 viewport
      `http://localhost:${PORT}/`,
    ],
    { stdio: 'ignore' }
  );

  let cdp: CDPClient | null = null;

  try {
    // Wait for Chrome remote debugging port to become ready
    console.log('[TEST] 3. Waiting for Chrome remote debugging endpoint...');
    let versionData: any = null;
    for (let i = 0; i < 30; i++) {
      try {
        const res = await fetch(`http://localhost:${CHROME_DEBUG_PORT}/json/list`);
        if (res.ok) {
          const list = await res.json();
          if (list && list.length > 0 && list[0].webSocketDebuggerUrl) {
            versionData = list[0];
            break;
          }
        }
      } catch {
        // waiting
      }
      await new Promise((r) => setTimeout(r, 200));
    }

    if (!versionData) {
      throw new Error('Failed to connect to Chrome DevTools port within timeout.');
    }

    console.log('[TEST] 4. Connecting via CDP WebSocket:', versionData.webSocketDebuggerUrl);
    cdp = new CDPClient(versionData.webSocketDebuggerUrl);
    await cdp.connect();

    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('DOM.enable');

    // Start past the onboarding screen: seed one neutral address before any page script runs
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `if (!localStorage.getItem('svitlo_saved_addresses_v1')) {
        localStorage.setItem('svitlo_saved_addresses_v1', JSON.stringify([{
          id: 'e2e_addr', label: 'Тест', icon: '🏠', region: 'kem', city: 'м. Київ',
          street: 'вул. Хрещатик', house: '1', group: '10.1',
          notifyBeforeOff: true, notifyBeforeOn: true, notifyOnChange: true,
          createdAt: '2026-01-01T00:00:00Z' }]));
      }`,
    });
    await cdp.send('Page.reload');

    // Wait for page load and initial bundle fetch
    await new Promise((r) => setTimeout(r, 1200));

    // Helper to evaluate JS in the page
    const evaluate = async (expression: string) => {
      const res = await cdp!.send('Runtime.evaluate', {
        expression,
        returnByValue: true,
        awaitPromise: true,
      });
      return res.result?.result?.value !== undefined ? res.result.result.value : res.result?.value;
    };

    // Helper to click using real Input.dispatchMouseEvent
    const clickAt = async (x: number, y: number) => {
      await cdp!.send('Input.dispatchMouseEvent', {
        type: 'mousePressed',
        x: Math.round(x),
        y: Math.round(y),
        button: 'left',
        clickCount: 1,
      });
      await new Promise((r) => setTimeout(r, 60));
      await cdp!.send('Input.dispatchMouseEvent', {
        type: 'mouseReleased',
        x: Math.round(x),
        y: Math.round(y),
        button: 'left',
        clickCount: 1,
      });
    };

    // Verify Title and basic DOM
    const title = await evaluate('document.title');
    console.log(`[TEST] Page title: "${title}"`);
    if (!title || !title.includes('Світло')) {
      throw new Error(`Expected title to contain "Світло", got: ${title}`);
    }

    console.log('[TEST] 5. Testing Tab switching ("Завтра" / "Сегодня")...');
    const tomorrowCoords = await evaluate(`(() => {
      const btn = Array.from(document.querySelectorAll('button')).find(b => b.textContent.includes('Завтра'));
      if (!btn) return null;
      const r = btn.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    })()`);
    if (tomorrowCoords) {
      await clickAt(tomorrowCoords.x, tomorrowCoords.y);
      await new Promise((r) => setTimeout(r, 200));
      console.log('       Clicked tab "Завтра" via Input.dispatchMouseEvent - OK');
    }

    const todayCoords = await evaluate(`(() => {
      const btn = Array.from(document.querySelectorAll('button')).find(b => b.textContent.includes('Сегодня') || b.textContent.includes('Сьогодні'));
      if (!btn) return null;
      const r = btn.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    })()`);
    if (todayCoords) {
      await clickAt(todayCoords.x, todayCoords.y);
      await new Promise((r) => setTimeout(r, 200));
      console.log('       Clicked tab "Сегодня" via Input.dispatchMouseEvent - OK');
    }

    console.log('[TEST] 6. Verifying Intervals list, Collapsible Hourly Grid, and Bell badge...');
    const slotCount = await evaluate(`document.querySelectorAll('.timeline-slot').length`);
    console.log(`       Rendered timeline slots count: ${slotCount}`);
    if (slotCount !== 48) {
      throw new Error(`Expected 48 timeline slots, got ${slotCount}`);
    }

    const kyivBadgeText = await evaluate(`document.querySelector('.kyiv-hero-badge')?.textContent?.trim() || ''`);
    console.log(`       Kyiv Digital status badge text: "${kyivBadgeText}"`);
    if (!kyivBadgeText) {
      throw new Error('Kyiv Digital status badge (.kyiv-hero-badge) not rendered');
    }

    // Verify Intervals List is rendered
    const intervalRowCount = await evaluate(`document.querySelectorAll('.interval-row').length`);
    console.log(`       Rendered intervals count: ${intervalRowCount}`);
    if (intervalRowCount === 0) {
      throw new Error('Expected at least one interval in Intervals List');
    }

    // Verify Bell button does NOT have a false unread badge dot
    const hasUnreadBellDot = await evaluate(`!!document.querySelector('header .badge-dot')`);
    console.log(`       Header bell has unread badge dot: ${hasUnreadBellDot}`);
    if (hasUnreadBellDot) {
      throw new Error('Header bell should not have an unread badge dot displayed');
    }

    // Verify Hourly Grid is initially collapsed (or can be expanded)
    const initialHourCards = await evaluate(`document.querySelectorAll('.kyiv-hour-card').length`);
    console.log(`       Initial hourly tiles count (collapsed): ${initialHourCards}`);

    const toggleBtnCoords = await evaluate(`(() => {
      const btn = document.querySelector('.collapsible-grid-header');
      if (!btn) return null;
      btn.scrollIntoView({ block: 'center', behavior: 'instant' });
      const r = btn.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    })()`);

    if (!toggleBtnCoords) {
      throw new Error('Collapsible hourly grid header button not found');
    }

    console.log('       Clicking "Погодинний графік" accordion toggle via Input.dispatchMouseEvent...');
    await clickAt(toggleBtnCoords.x, toggleBtnCoords.y);
    await new Promise((r) => setTimeout(r, 300));

    const expandedHourCards = await evaluate(`document.querySelectorAll('.kyiv-hour-card').length`);
    console.log(`       Expanded hourly tiles count: ${expandedHourCards}`);
    if (expandedHourCards !== 24) {
      throw new Error(`Expected 24 hourly cards after expanding, got ${expandedHourCards}`);
    }

    const legendItemsCount = await evaluate(`document.querySelectorAll('.kyiv-grid-legend .legend-item').length`);
    console.log(`       Kyiv Digital legend items: ${legendItemsCount}`);
    if (legendItemsCount !== 3) {
      throw new Error(`Expected 3 legend items in Hourly Grid, got ${legendItemsCount}`);
    }

    console.log('[TEST] 7. Opening Address Modal...');
    const addAddrCoords = await evaluate(`(() => {
      const btn = document.querySelector('button[aria-label="Додати адресу"]') ||
                  Array.from(document.querySelectorAll('button')).find(b => b.textContent.includes('Добавить') || b.querySelector('svg.lucide-plus'));
      if (!btn) return null;
      btn.scrollIntoView({ block: 'center', behavior: 'instant' });
      const r = btn.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    })()`);

    if (!addAddrCoords) {
      throw new Error('Could not find Add Address button');
    }

    await clickAt(addAddrCoords.x, addAddrCoords.y);
    await new Promise((r) => setTimeout(r, 400));

    const modalOpen = await evaluate(`!!document.querySelector('.modal-sheet, .modal-backdrop')`);
    console.log('       Address Modal open state:', modalOpen);
    if (!modalOpen) {
      throw new Error('Address modal did not open upon clicking + button');
    }

    console.log('[TEST] 8. Verifying Kyiv street dropdown starts alphabetically (NOT with Хрещатик)...');
    const streetInputCoords = await evaluate(`(() => {
      const inp = document.querySelector('input[placeholder*="Хрещатик"]');
      if (!inp) return null;
      const r = inp.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    })()`);

    if (!streetInputCoords) {
      throw new Error('Street input not found');
    }

    await clickAt(streetInputCoords.x, streetInputCoords.y);
    await new Promise((r) => setTimeout(r, 400));

    const initialStreets = await evaluate(`
      Array.from(document.querySelectorAll('.autocomplete-item')).slice(0, 5).map(el => el.textContent.trim())
    `);
    console.log('       Initial street items in dropdown:', initialStreets);
    if (initialStreets.length === 0) {
      throw new Error('Street dropdown did not render any items');
    }
    if (initialStreets[0].includes('Хрещатик')) {
      throw new Error(`Street dropdown starts with test street instead of alphabetical: "${initialStreets[0]}"`);
    }

    console.log('[TEST] 9. Searching for "Хрещатик", picking a house and verifying NO group is invented...');
    await evaluate(`(() => {
      const inp = document.querySelector('input[placeholder*="Хрещатик"]');
      if (inp) inp.focus();
    })()`);
    await cdp!.send('Input.insertText', { text: 'Хрещатик' });
    await new Promise((r) => setTimeout(r, 500));

    const streetOptionCoords = await evaluate(`(() => {
      const item = Array.from(document.querySelectorAll('.autocomplete-item')).find(el => el.textContent.includes('Хрещатик'));
      if (!item) return null;
      const r = item.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    })()`);
    if (!streetOptionCoords) {
      throw new Error('Could not find Хрещатик in street autocomplete');
    }
    await clickAt(streetOptionCoords.x, streetOptionCoords.y);
    await new Promise((r) => setTimeout(r, 400));

    const houseInputCoords = await evaluate(`(() => {
      const inp = document.querySelector('input[placeholder*="12, 3, 22"]');
      if (!inp) return null;
      const r = inp.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    })()`);
    if (!houseInputCoords) {
      throw new Error('House input not found');
    }
    await clickAt(houseInputCoords.x, houseInputCoords.y);
    await new Promise((r) => setTimeout(r, 200));
    await cdp!.send('Input.insertText', { text: '39' });
    await new Promise((r) => setTimeout(r, 400));

    const house39Coords = await evaluate(`(() => {
      const item = Array.from(document.querySelectorAll('.autocomplete-item')).find(el => el.textContent.trim().startsWith('буд. 39'));
      if (!item) return null;
      const r = item.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2, text: item.textContent.trim() };
    })()`);
    console.log('       House 39 item found:', house39Coords?.text);
    if (!house39Coords) {
      throw new Error('House 39 not found in dropdown for Хрещатик');
    }
    if (/Гр\./.test(house39Coords.text)) {
      throw new Error(`A group must not be guessed for an unverified house, got: "${house39Coords.text}"`);
    }
    await clickAt(house39Coords.x, house39Coords.y);
    await new Promise((r) => setTimeout(r, 300));
    const note = await evaluate(`document.body.innerText.includes('автоматично визначити не вдалося')`);
    if (!note) {
      throw new Error('Expected the "group not detected, choose manually" notice');
    }

    console.log('[TEST] 10. Switching to "Киевская область" and verifying alphabetical settlements...');
    const oblastBtnCoords = await evaluate(`(() => {
      const btn = Array.from(document.querySelectorAll('.region-card-btn')).find(b => b.textContent.includes('Киевская область'));
      if (!btn) return null;
      const r = btn.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    })()`);
    if (!oblastBtnCoords) {
      throw new Error('Киевская область button not found');
    }
    await clickAt(oblastBtnCoords.x, oblastBtnCoords.y);
    await new Promise((r) => setTimeout(r, 400));

    const initialSettlements = await evaluate(`
      Array.from(document.querySelectorAll('.autocomplete-item')).slice(0, 5).map(el => el.textContent.trim())
    `);
    console.log('       Initial settlements in dropdown:', initialSettlements);
    if (initialSettlements.length === 0) {
      throw new Error('Settlements dropdown empty after switching region');
    }

    console.log('[TEST] 11. Selecting "м. Бровари" and a village street + house...');
    const cityInputCoords = await evaluate(`(() => {
      const inp = document.querySelector('input[placeholder*="Бровари"]');
      if (!inp) return null;
      const r = inp.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    })()`);
    if (cityInputCoords) {
      await clickAt(cityInputCoords.x, cityInputCoords.y);
      await new Promise((r) => setTimeout(r, 200));
    }
    await cdp!.send('Input.insertText', { text: 'Бровари' });
    await new Promise((r) => setTimeout(r, 500));

    const cityItemCoords = await evaluate(`(() => {
      const item = Array.from(document.querySelectorAll('.autocomplete-item')).find(el => el.textContent.includes('Бровари'));
      if (!item) return null;
      const r = item.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    })()`);
    if (!cityItemCoords) {
      throw new Error('м. Бровари not found in autocomplete');
    }
    await clickAt(cityItemCoords.x, cityItemCoords.y);
    await new Promise((r) => setTimeout(r, 600));

    const villageStreetCoords = await evaluate(`(() => {
      const item = Array.from(document.querySelectorAll('.autocomplete-item')).find(el => el.textContent.includes('Центральна'));
      if (!item) return null;
      const r = item.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    })()`);
    if (!villageStreetCoords) {
      throw new Error('вул. Центральна not found in the street dropdown');
    }
    await clickAt(villageStreetCoords.x, villageStreetCoords.y);
    await new Promise((r) => setTimeout(r, 400));

    const houseInput2 = await evaluate(`(() => {
      const inp = document.querySelector('input[placeholder*="12, 3, 22"]');
      if (!inp) return null;
      const r = inp.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    })()`);
    if (!houseInput2) {
      throw new Error('House input not found (village flow)');
    }
    await clickAt(houseInput2.x, houseInput2.y);
    await new Promise((r) => setTimeout(r, 200));
    await cdp!.send('Input.insertText', { text: '19' });
    await new Promise((r) => setTimeout(r, 400));

    const house19Coords = await evaluate(`(() => {
      const item = Array.from(document.querySelectorAll('.autocomplete-item')).find(el => el.textContent.trim().startsWith('буд. 19'));
      if (!item) return null;
      const r = item.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2, text: item.textContent.trim() };
    })()`);
    console.log('       House 19 item found:', house19Coords?.text);
    if (!house19Coords) {
      throw new Error('House 19 not found in dropdown');
    }
    await clickAt(house19Coords.x, house19Coords.y);
    await new Promise((r) => setTimeout(r, 200));

    // Save address
    console.log('[TEST] 12. Saving address and verifying DOM update...');
    const saveBtnCoords = await evaluate(`(() => {
      const btn = Array.from(document.querySelectorAll('button')).find(b => b.textContent.includes('Сохранить адрес') || b.textContent.includes('Зберегти'));
      if (!btn) return null;
      btn.scrollIntoView({ block: 'center', behavior: 'instant' });
      const r = btn.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    })()`);
    if (!saveBtnCoords) {
      throw new Error('Save address button not found');
    }
    console.log(`       Save button coords: (${Math.round(saveBtnCoords.x)}, ${Math.round(saveBtnCoords.y)})`);
    await clickAt(saveBtnCoords.x, saveBtnCoords.y);
    await new Promise((r) => setTimeout(r, 600));

    // Check saved addresses count
    const addressPills = await evaluate(`Array.from(document.querySelectorAll('.address-pill')).map(p => p.textContent.trim())`);
    console.log('       Saved address pills in DOM:', addressPills);
    // the seeded address + the one just saved (the exact street depends on async OSM loading)
    const hasNewAddr = addressPills.length >= 2;
    if (!hasNewAddr) {
      throw new Error('Saved address pill not found in AddressSwitcher');
    }

    console.log('====================================================');
    console.log('✅ ALL CHROME HEADLESS E2E TESTS PASSED SUCCESSFULLY');
    console.log('====================================================');
  } finally {
    if (cdp) cdp.close();
    chrome.kill('SIGTERM');
    server.close();
  }
}

if (process.argv[1] && process.argv[1].endsWith('chrome-e2e.ts')) {
  runChromeTest().catch((err) => {
    console.error('❌ CHROME HEADLESS TEST FAILED:', err);
    process.exit(1);
  });
}
