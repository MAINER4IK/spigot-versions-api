import https from 'node:https';
import { execSync } from 'node:child_process';
import {
  existsSync, mkdirSync, readFileSync, writeFileSync, statSync,
  createWriteStream, unlinkSync, readdirSync, renameSync
} from 'node:fs';
import { join, dirname } from 'node:path';

const BUILDS_ROOT = join(process.cwd(), 'builds');
const VERSIONS_FILE = join(process.cwd(), 'versions.json');
const BUILDTOOLS_PATH = join(process.cwd(), 'tools', 'BuildTools.jar');
const BUILDTOOLS_URL = 'https://hub.spigotmc.org/jenkins/job/BuildTools/lastSuccessfulBuild/artifact/target/BuildTools.jar';

interface VersionEntry {
  version: string;
  javaVersion: number;
  buildToolsVersion: string;
  size: number;
  filename: string;
  timestamp: string;
}

interface VersionsJson {
  lastUpdated: string;
  versions: Record<string, VersionEntry>;
}

function log(msg: string) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

function fetchJson<T = unknown>(url: string): Promise<T> {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'spigot-releases/1.0', 'Accept': 'application/json' } }, res => {
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        return;
      }
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data) as T); }
        catch (e) { reject(new Error(`JSON parse error: ${(e as Error).message}`)); }
      });
    }).on('error', reject);
  });
}

function downloadFile(url: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const file = createWriteStream(dest);
    https.get(url, { headers: { 'User-Agent': 'spigot-releases/1.0' } }, res => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        file.close();
        unlinkSync(dest);
        downloadFile(res.headers.location, dest).then(resolve).catch(reject);
        return;
      }
      if (res.statusCode !== 200) {
        file.close();
        unlinkSync(dest);
        reject(new Error(`HTTP ${res.statusCode} downloading ${url}`));
        return;
      }
      res.pipe(file);
      file.on('finish', () => { file.close(); resolve(); });
    }).on('error', e => {
      try { unlinkSync(dest); } catch {}
      reject(e);
    });
  });
}

function getAllVersions(): Promise<string[]> {
  return new Promise((resolve, reject) => {
    https.get('https://hub.spigotmc.org/versions/', { headers: { 'User-Agent': 'spigot-releases/1.0' } }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        const all = [...d.matchAll(/href="(\d+\.\d+(?:\.\d+)?)\.json"/g)].map(m => m[1]);
        const unique = [...new Set(all)].sort((a, b) => {
          const pa = a.split('.').map(Number), pb = b.split('.').map(Number);
          for (let i = 0; i < 3; i++) {
            const aa = pa[i] || 0, bb = pb[i] || 0;
            if (aa !== bb) return aa - bb;
          }
          return 0;
        });
        resolve(unique);
      });
    }).on('error', reject);
  });
}

function findJava(requiredMajor: number): string | null {
  // In GitHub Actions, JAVA_HOME is set
  const javaHome = process.env.JAVA_HOME;
  if (javaHome) {
    const javaExe = join(javaHome, 'bin', 'java.exe');
    if (existsSync(javaExe)) return javaExe;
    // Try without .exe for Linux
    const javaBin = join(javaHome, 'bin', 'java');
    if (existsSync(javaBin)) return javaBin;
  }

  // Try common paths
  const paths = [
    'C:\\Program Files\\Java',
    'C:\\Program Files\\Eclipse Adoptium',
    'C:\\Program Files\\Microsoft',
    '/usr/lib/jvm',
    '/usr/local/lib/jvm',
  ];

  for (const root of paths) {
    try {
      for (const dir of readdirSync(root)) {
        if (dir.toLowerCase().includes('jdk') || dir.toLowerCase().includes('jre')) {
          const ver = parseInt(dir.match(/(\d+)/)?.[1] ?? '0');
          if (ver >= requiredMajor) {
            for (const exe of ['java.exe', 'java']) {
              const p = join(root, dir, 'bin', exe);
              if (existsSync(p)) return p;
            }
          }
        }
      }
    } catch {}
  }

  // Try PATH
  try {
    const cmd = process.platform === 'win32' ? 'where java' : 'which java';
    const pathJava = execSync(cmd, { encoding: 'utf-8' }).trim().split('\n')[0]?.trim();
    if (pathJava) {
      const v = execSync(`"${pathJava}" -version 2>&1`, { encoding: 'utf-8' });
      const m = v.match(/version "(\d+)/);
      if (m && parseInt(m[1]) >= requiredMajor) return pathJava;
    }
  } catch {}

  return null;
}

function getRequiredJava(versionData: { javaVersions?: number[] }): number {
  if (versionData.javaVersions && versionData.javaVersions.length > 0) {
    return Math.min(...versionData.javaVersions.map(v => v - 44));
  }
  return 8;
}

async function buildVersion(mcVersion: string): Promise<VersionEntry | null> {
  const folder = join(BUILDS_ROOT, mcVersion);
  const jarName = `spigot-${mcVersion}.jar`;
  const jarFile = join(folder, jarName);

  mkdirSync(folder, { recursive: true });

  // Get required Java version
  let minJava = 8;
  let buildDataHash = '';
  try {
    const info = await fetchJson<{ javaVersions?: number[]; buildData?: { ref?: string } }>(
      `https://hub.spigotmc.org/versions/${mcVersion}.json`
    );
    minJava = getRequiredJava(info);
    buildDataHash = info.buildData?.ref?.substring(0, 7) || '';
  } catch {}

  const javaPath = findJava(minJava);
  if (!javaPath) {
    log(`  [SKIP] No Java ${minJava}+ found`);
    return null;
  }

  log(`  Using Java ${minJava}+ (${javaPath})`);

  // Verify BuildTools.jar exists and is valid
  if (!existsSync(BUILDTOOLS_PATH) || statSync(BUILDTOOLS_PATH).size < 1_000_000) {
    log(`  [SKIP] BuildTools.jar missing or too small`);
    return null;
  }

  try {
    const javaHome = dirname(dirname(javaPath));
    log(`  Building with BuildTools...`);
    execSync(`"${javaPath}" -jar "${BUILDTOOLS_PATH}" --rev ${mcVersion} 2>&1`, {
      cwd: folder,
      stdio: 'pipe',
      timeout: 900_000, // 15 min
      env: {
        ...process.env,
        JAVA_HOME: javaHome,
        GIT_TERMINAL_PROMPT: '0'
      }
    });

    // Find the built JAR
    if (existsSync(jarFile)) {
      const size = statSync(jarFile).size;
      log(`  [OK] ${jarName} (${(size / 1024 / 1024).toFixed(1)} MB)`);
      return {
        version: mcVersion,
        javaVersion: minJava,
        buildToolsVersion: buildDataHash,
        size,
        filename: jarName,
        timestamp: new Date().toISOString(),
      };
    }

    // Sometimes the jar is named differently
    const possibleJars = readdirSync(folder)
      .filter((f: string) => f.startsWith('spigot') && f.endsWith('.jar') && !f.includes('BuildTools'));

    if (possibleJars.length > 0) {
      const altJar = possibleJars[0] as string;
      const altPath = join(folder, altJar);
      if (altJar !== jarName) {
        const targetPath = join(folder, jarName);
        renameSync(altPath, targetPath);
      }
      const size = statSync(join(folder, jarName)).size;
      log(`  [OK] ${jarName} (${(size / 1024 / 1024).toFixed(1)} MB)`);
      return {
        version: mcVersion,
        javaVersion: minJava,
        buildToolsVersion: buildDataHash,
        size,
        filename: jarName,
        timestamp: new Date().toISOString(),
      };
    }

    log(`  [FAIL] JAR not found after build`);
    return null;
  } catch (err) {
    const e = err as { message?: string; stderr?: Buffer | string; stdout?: Buffer | string };
    const stderr = e.stderr ? (Buffer.isBuffer(e.stderr) ? e.stderr.toString() : e.stderr) : '';
    const stdout = e.stdout ? (Buffer.isBuffer(e.stdout) ? e.stdout.toString() : e.stdout) : '';
    const msg = (e.message || '').substring(0, 500);
    log(`  [FAIL] ${msg}`);
    if (stderr) log(`  STDERR: ${stderr.substring(0, 500)}`);
    if (stdout) log(`  STDOUT: ${stdout.substring(0, 500)}`);
    return null;
  }
}

async function main() {
  mkdirSync(BUILDS_ROOT, { recursive: true });

  log('=== Spigot Version Checker ===');

  // Load existing versions
  let versionsData: VersionsJson = { lastUpdated: '', versions: {} };
  if (existsSync(VERSIONS_FILE)) {
    try {
      versionsData = JSON.parse(readFileSync(VERSIONS_FILE, 'utf-8'));
    } catch {}
  }

  // Get all available versions from SpigotMC
  log('Fetching available versions...');
  const allVersions = await getAllVersions();
  log(`Found ${allVersions.length} versions on SpigotMC`);

  // Find which ones need building
  const toBuild = allVersions.filter(v => !versionsData.versions[v]);
  log(`Already built: ${allVersions.length - toBuild.length}`);
  log(`Need to build: ${toBuild.length}`);

  if (toBuild.length === 0) {
    log('Nothing to build, exiting');
    versionsData.lastUpdated = new Date().toISOString();
    writeFileSync(VERSIONS_FILE, JSON.stringify(versionsData, null, 2));
    return;
  }

  let success = 0, fail = 0;

  for (const ver of toBuild) {
    log(`\n[${ver}] Starting build...`);
    const entry = await buildVersion(ver);
    if (entry) {
      versionsData.versions[ver] = entry;
      success++;
    } else {
      fail++;
    }

    // Save progress after each build
    versionsData.lastUpdated = new Date().toISOString();
    writeFileSync(VERSIONS_FILE, JSON.stringify(versionsData, null, 2));
  }

  log(`\n=== Complete ===`);
  log(`Success: ${success} | Failed: ${fail} | Total: ${toBuild.length}`);
  log(`Total built versions: ${Object.keys(versionsData.versions).length}`);
}

main().catch(e => { log(`FATAL: ${e.message}`); process.exit(1); });
