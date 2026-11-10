import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

describe('Version and build consistency', () => {
  const rootDir = path.resolve(__dirname, '..');
  const versionJsonPath = path.join(rootDir, 'public', 'version.json');
  const swJsPath = path.join(rootDir, 'public', 'sw.js');
  const appTsxPath = path.join(rootDir, 'src', 'App.tsx');

  it('keeps version and buildTime synchronized across version.json, sw.js, and App.tsx', () => {
    const versionData = JSON.parse(fs.readFileSync(versionJsonPath, 'utf-8'));
    expect(versionData.version).toBeTruthy();
    expect(versionData.buildTime).toBeTruthy();

    const swContent = fs.readFileSync(swJsPath, 'utf-8');
    const expectedCacheSuffix = versionData.version.replace(/\./g, '-');
    expect(swContent).toContain(`const CACHE_NAME = 'svitlo-pwa-v${expectedCacheSuffix}';`);

    const appContent = fs.readFileSync(appTsxPath, 'utf-8');
    expect(appContent).toContain(`const CURRENT_BUILD_TIMESTAMP = '${versionData.buildTime}';`);
  });
});
