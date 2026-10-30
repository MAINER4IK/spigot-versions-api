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

// The Releases page sorts tag names lexically; padding each component makes
// that order match numeric Minecraft versions without changing display names.
function releaseTag(version: string, prefix: string): string {
  const parts = version.split('.');
  if (parts.some(part => Number(part) >= 1000)) throw new Error(`Version component too large: ${version}`);
  return `${prefix}-${parts.map(part => part.padStart(3, '0')).join('.')}`;
}

async function main() {
  if (process.argv[2] === 'list' || process.argv[2] === 'plan') {
    const html = await fetchText('https://hub.spigotmc.org/versions/');
    const versions = [...new Set([...html.matchAll(/href="(\d+\.\d+(?:\.\d+)?)\.json"/g)].map(m => m[1]))];
    if (!versions.length) throw new Error('No Spigot versions found');
    if (process.argv[2] === 'list') { console.log(JSON.stringify(versions)); return; }
    const serverType = process.env.SERVER_TYPE || 'spigot';
    if (!['spigot', 'craftbukkit'].includes(serverType)) throw new Error(`Invalid server type: ${serverType}`);
    const prefix = serverType === 'craftbukkit' ? 'bukkit' : 'spigot';
    const indexFile = serverType === 'craftbukkit' ? 'bukkit-versions.json' : 'versions.json';
    const index = JSON.parse(readFileSync(indexFile, 'utf8')).versions;
    const blocked: Record<string, { fingerprint: string }> = serverType === 'spigot'
      ? JSON.parse(readFileSync('spigot-blocked-builds.json', 'utf8')) : {};
    const repo = process.env.GITHUB_REPOSITORY;
    if (!repo) throw new Error('GITHUB_REPOSITORY is required');
    const pages = JSON.parse(execFileSync('gh', ['api', `repos/${repo}/releases?per_page=100`, '--paginate', '--slurp'], { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 }));
    const releases = new Map<string, { body?: string; assets: { name: string }[] }>(pages.flat().map((r: { tag_name: string; body?: string; assets: { name: string }[] }) => [r.tag_name, r]));
    const pending: string[] = [];
    for (let start = 0; start < versions.length; start += 8) {
      await Promise.all(versions.slice(start, start + 8).map(async version => {
        if (process.env.FORCE_REBUILD === 'true') { pending.push(version); return; }
        const data = JSON.parse(await fetchText(`https://hub.spigotmc.org/versions/${version}.json`));
        if (!data.refs || !Object.keys(data.refs).length) throw new Error(`Missing refs for ${version}`);
        const fingerprint = createHash('sha256').update(JSON.stringify(data)).digest('hex');
        const tag = releaseTag(version, prefix);
        const release = releases.get(tag);
        const filename = `${serverType}-${version}.jar`;
        if (serverType === 'spigot' && !release && blocked[version]?.fingerprint === fingerprint) return;
        if (!release?.body?.includes(`spigot-source-sha256: ${fingerprint}`) ||
            !release.assets.some(asset => asset.name === filename) ||
            index[version]?.sourceFingerprint !== fingerprint || index[version]?.releaseTag !== tag) pending.push(version);
      }));
    }
    pending.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    console.log(JSON.stringify(pending));
    return;
  }
  const version = process.env.MC_VERSION;
  if (!version || !/^\d+\.\d+(?:\.\d+)?$/.test(version)) throw new Error('Invalid MC_VERSION');
  const serverType = process.env.SERVER_TYPE || 'spigot';
  if (!['spigot', 'craftbukkit'].includes(serverType)) throw new Error(`Invalid server type: ${serverType}`);
  const label = serverType === 'craftbukkit' ? 'CraftBukkit' : 'Spigot';
  const prefix = serverType === 'craftbukkit' ? 'bukkit' : 'spigot';
  const indexFile = serverType === 'craftbukkit' ? 'bukkit-versions.json' : 'versions.json';
  const data = JSON.parse(await fetchText(`https://hub.spigotmc.org/versions/${version}.json`));
  if (!data.refs || !Object.keys(data.refs).length) throw new Error(`Missing refs for ${version}`);
  const fingerprint = createHash('sha256').update(JSON.stringify(data)).digest('hex');
  const tag = releaseTag(version, prefix);
  const marker = `spigot-source-sha256: ${fingerprint}`;
  let release: { body?: string; assets?: { name: string; size: number; createdAt: string }[] } | undefined;
  try { release = JSON.parse(execFileSync('gh', ['release', 'view', tag, '--json', 'body,assets'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })); }
  catch (e) {
    // Only treat a genuine missing release as absent; authentication and API errors must fail.
    const error = e as { stderr?: Buffer };
    if (!error.stderr?.toString().includes('release not found')) throw e;
  }
  const filename = `${serverType}-${version}.jar`;
  const asset = release?.assets?.find(a => a.name === filename);
  if (process.env.FORCE_REBUILD !== 'true' && release?.body?.includes(marker) && asset) {
    const index = JSON.parse(readFileSync(indexFile, 'utf8'));
    if (!index.versions[version] || index.versions[version].sourceFingerprint !== fingerprint || index.versions[version].releaseTag !== tag) {
      const entry = {
        version, filename, size: asset.size, timestamp: asset.createdAt,
        javaVersion: data.javaVersions?.length ? Math.min(...data.javaVersions.map((v: number) => v - 44)) : 8,
        buildToolsVersion: data.refs.BuildData || '', sourceFingerprint: fingerprint,
        releaseTag: tag, downloadUrl: `https://github.com/${process.env.GITHUB_REPOSITORY || 'MAINER4IK/spigot-versions-api'}/releases/download/${tag}/${filename}`,
      };
      mkdirSync('result', { recursive: true });
      writeFileSync(`result/${version}.json`, JSON.stringify(entry));
    }
    console.log(`${version}: up to date`); return;
  }
  execFileSync(process.execPath, ['--loader', 'ts-node/esm', 'src/check.ts'], { stdio: 'inherit', env: { ...process.env, MC_VERSION: version } });
  const entries = JSON.parse(readFileSync(indexFile, 'utf8'));
  const entry = entries.versions[version];
  if (!entry) throw new Error(`Build failed for ${version}`);
  entry.sourceFingerprint = fingerprint;
  entry.releaseTag = tag;
  entry.downloadUrl = `https://github.com/${process.env.GITHUB_REPOSITORY || 'MAINER4IK/spigot-versions-api'}/releases/download/${tag}/${filename}`;
  const jar = `builds/${version}/${filename}`;
  const notes = `${label} BuildTools build for Minecraft ${version}\n\n${marker}`;
  if (release) {
    execFileSync('gh', ['release', 'upload', tag, jar, '--clobber'], { stdio: 'inherit' });
    execFileSync('gh', ['release', 'edit', tag, '--notes', notes], { stdio: 'inherit' });
  } else {
    execFileSync('gh', ['release', 'create', tag, jar, '--title', `${label} ${version}`, '--notes', notes, '--latest=false'], { stdio: 'inherit' });
  }
  mkdirSync('result', { recursive: true });
  writeFileSync(`result/${version}.json`, JSON.stringify(entry));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
