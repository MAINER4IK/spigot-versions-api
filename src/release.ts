import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import https from 'node:https';

function fetchText(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'spigot-releases' } }, res => {
      if (res.statusCode !== 200) { res.resume(); reject(new Error(`${url}: HTTP ${res.statusCode}`)); return; }
      let data = ''; res.setEncoding('utf8'); res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data)); res.on('error', reject);
    }).on('error', reject);
  });
}

// GitHub orders releases by their target commit's date. Give each version a
// deterministic date so parallel builds and late releases remain ordered.
function prepareReleaseTag(version: string, tag: string): void {
  const parts = version.split('.').map(Number);
  if (parts.some(n => n >= 1000)) throw new Error(`Version component too large: ${version}`);
  const [major, minor, patch = 0] = parts;
  const date = new Date(Date.UTC(2024, 0, 1) + (major * 1_000_000 + minor * 1_000 + patch) * 1000).toISOString();
  const tree = execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { encoding: 'utf8' }).trim();
  const commit = execFileSync('git', ['commit-tree', tree, '-p', 'HEAD'], {
    input: `Release ordering for Spigot ${version}\n`, encoding: 'utf8',
    env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
  }).trim();
  execFileSync('git', ['tag', '-f', tag, commit], { stdio: 'inherit' });
  execFileSync('git', ['push', '--force', 'origin', `refs/tags/${tag}`], { stdio: 'inherit' });
}

async function main() {
  if (process.argv[2] === 'list') {
    const html = await fetchText('https://hub.spigotmc.org/versions/');
    const versions = [...new Set([...html.matchAll(/href="(\d+\.\d+(?:\.\d+)?)\.json"/g)].map(m => m[1]))];
    if (!versions.length) throw new Error('No Spigot versions found');
    console.log(JSON.stringify(versions));
    return;
  }
  const version = process.env.MC_VERSION;
  if (!version || !/^\d+\.\d+(?:\.\d+)?$/.test(version)) throw new Error('Invalid MC_VERSION');
  const data = JSON.parse(await fetchText(`https://hub.spigotmc.org/versions/${version}.json`));
  if (!data.refs || !Object.keys(data.refs).length) throw new Error(`Missing refs for ${version}`);
  const fingerprint = createHash('sha256').update(JSON.stringify(data)).digest('hex');
  const tag = `spigot-${version}`;
  const marker = `spigot-source-sha256: ${fingerprint}`;
  let release: { body?: string; assets?: { name: string; size: number; createdAt: string }[] } | undefined;
  try { release = JSON.parse(execFileSync('gh', ['release', 'view', tag, '--json', 'body,assets'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })); }
  catch (e) {
    // Only treat a genuine missing release as absent; authentication and API errors must fail.
    const error = e as { stderr?: Buffer };
    if (!error.stderr?.toString().includes('release not found')) throw e;
  }
  const filename = `spigot-${version}.jar`;
  const asset = release?.assets?.find(a => a.name === filename);
  if (process.env.FORCE_REBUILD !== 'true' && release?.body?.includes(marker) && asset) {
    const index = JSON.parse(readFileSync('versions.json', 'utf8'));
    if (!index.versions[version] || index.versions[version].sourceFingerprint !== fingerprint) {
      const entry = {
        version, filename, size: asset.size, timestamp: asset.createdAt,
        javaVersion: data.javaVersions?.length ? Math.min(...data.javaVersions.map((v: number) => v - 44)) : 8,
        buildToolsVersion: data.refs.BuildData || '', sourceFingerprint: fingerprint,
      };
      mkdirSync('result', { recursive: true });
      writeFileSync(`result/${version}.json`, JSON.stringify(entry));
    }
    console.log(`${version}: up to date`); return;
  }
  execFileSync(process.execPath, ['--loader', 'ts-node/esm', 'src/check.ts'], { stdio: 'inherit', env: { ...process.env, MC_VERSION: version } });
  const entries = JSON.parse(readFileSync('versions.json', 'utf8'));
  const entry = entries.versions[version];
  if (!entry) throw new Error(`Build failed for ${version}`);
  entry.sourceFingerprint = fingerprint;
  const jar = `builds/${version}/${filename}`;
  const notes = `SpigotMC BuildTools build for Minecraft ${version}\n\n${marker}`;
  if (release) {
    execFileSync('gh', ['release', 'upload', tag, jar, '--clobber'], { stdio: 'inherit' });
    execFileSync('gh', ['release', 'edit', tag, '--notes', notes], { stdio: 'inherit' });
  } else {
    prepareReleaseTag(version, tag);
    execFileSync('gh', ['release', 'create', tag, jar, '--title', `Spigot ${version}`, '--notes', notes, '--latest=false'], { stdio: 'inherit' });
  }
  mkdirSync('result', { recursive: true });
  writeFileSync(`result/${version}.json`, JSON.stringify(entry));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
