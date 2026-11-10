import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');
const VERSION_JSON_PATH = path.join(ROOT_DIR, 'public', 'version.json');
const SW_JS_PATH = path.join(ROOT_DIR, 'public', 'sw.js');
const APP_TSX_PATH = path.join(ROOT_DIR, 'src', 'App.tsx');

function parseSemver(v: string): [number, number, number] {
  const parts = v.trim().split('.').map(Number);
  if (parts.length !== 3 || parts.some(isNaN)) {
    throw new Error(`Invalid semver version: "${v}"`);
  }
  return [parts[0], parts[1], parts[2]];
}

function calculateNextVersion(currentVersion: string, bumpType?: string): string {
  const [major, minor, patch] = parseSemver(currentVersion);

  if (!bumpType || bumpType === 'patch') {
    return `${major}.${minor}.${patch + 1}`;
  }
  if (bumpType === 'minor') {
    return `${major}.${minor + 1}.0`;
  }
  if (bumpType === 'major') {
    return `${major + 1}.0.0`;
  }
  // Explicit version provided (e.g. "18.8.0")
  parseSemver(bumpType);
  return bumpType;
}

export function bumpVersion(bumpType?: string, customTimestamp?: string): { version: string; buildTime: string } {
  if (!fs.existsSync(VERSION_JSON_PATH)) {
    throw new Error(`File not found: ${VERSION_JSON_PATH}`);
  }
  if (!fs.existsSync(SW_JS_PATH)) {
    throw new Error(`File not found: ${SW_JS_PATH}`);
  }
  if (!fs.existsSync(APP_TSX_PATH)) {
    throw new Error(`File not found: ${APP_TSX_PATH}`);
  }

  const versionData = JSON.parse(fs.readFileSync(VERSION_JSON_PATH, 'utf-8'));
  const currentVersion = versionData.version;
  const newVersion = calculateNextVersion(currentVersion, bumpType);
  const newBuildTime = customTimestamp || new Date().toISOString();

  // 1. Update public/version.json
  versionData.version = newVersion;
  versionData.buildTime = newBuildTime;
  fs.writeFileSync(VERSION_JSON_PATH, JSON.stringify(versionData, null, 2) + '\n', 'utf-8');

  // 2. Update public/sw.js
  const swContent = fs.readFileSync(SW_JS_PATH, 'utf-8');
  const cacheNameRegex = /const CACHE_NAME = 'svitlo-pwa-v[^']+';/;
  if (!cacheNameRegex.test(swContent)) {
    throw new Error(`Could not find CACHE_NAME declaration in ${SW_JS_PATH}`);
  }
  const newCacheName = `const CACHE_NAME = 'svitlo-pwa-v${newVersion.replace(/\./g, '-')}';`;
  const updatedSwContent = swContent.replace(cacheNameRegex, newCacheName);
  fs.writeFileSync(SW_JS_PATH, updatedSwContent, 'utf-8');

  // 3. Update src/App.tsx
  const appContent = fs.readFileSync(APP_TSX_PATH, 'utf-8');
  const timestampRegex = /const CURRENT_BUILD_TIMESTAMP = '[^']+';/;
  if (!timestampRegex.test(appContent)) {
    throw new Error(`Could not find CURRENT_BUILD_TIMESTAMP declaration in ${APP_TSX_PATH}`);
  }
  const newTimestampLine = `const CURRENT_BUILD_TIMESTAMP = '${newBuildTime}';`;
  const updatedAppContent = appContent.replace(timestampRegex, newTimestampLine);
  fs.writeFileSync(APP_TSX_PATH, updatedAppContent, 'utf-8');

  return { version: newVersion, buildTime: newBuildTime };
}

if (process.argv[1] && process.argv[1].includes('bump-version')) {
  const arg = process.argv[2];
  try {
    const result = bumpVersion(arg);
    console.log(`✓ Version updated to ${result.version} (${result.buildTime})`);
    console.log(`  - public/version.json`);
    console.log(`  - public/sw.js (CACHE_NAME: svitlo-pwa-v${result.version.replace(/\./g, '-')})`);
    console.log(`  - src/App.tsx (CURRENT_BUILD_TIMESTAMP: ${result.buildTime})`);
  } catch (err: any) {
    console.error(`✗ Failed to bump version:`, err.message);
    process.exit(1);
  }
}
