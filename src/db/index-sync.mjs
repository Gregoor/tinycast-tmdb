// Keeps the provider's local index cache in step with the release manifest.
//
// The manifest is tiny and always re-fetched; an index file is downloaded only when its recorded
// hash differs from what is already on disk. So a launch is normally one small request, a day's
// update costs only that day's delta, and only a base republish pulls the whole index again.
//
// `fs`, `download` and `hash` are injected: the extension runtime backs them with its fs shim, curl
// (a root-search provider may not fetch) and the crypto shim; tests back them with node equivalents.

export function syncIndexes({ manifestURL, cacheDir, fs, download, hash, log = () => {} }) {
  fs.mkdirSync(cacheDir, { recursive: true });
  const manifestPath = `${cacheDir}/manifest.json`;
  download(manifestURL, manifestPath);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));

  const wanted = [manifest.base, ...(manifest.deltas ?? [])].filter(Boolean);
  const dir = manifestURL.slice(0, manifestURL.lastIndexOf("/") + 1);
  const installedPath = `${cacheDir}/installed.json`;
  const installed = fs.existsSync(installedPath)
    ? JSON.parse(fs.readFileSync(installedPath, "utf8"))
    : {};
  const prior = installed.assets ?? {};

  const have = (asset) => {
    const local = `${cacheDir}/${asset.name}`;
    if (prior[asset.name] !== asset.sha256 || !fs.existsSync(local)) return false;
    // A hash mismatch means a truncated or corrupted download; refetch rather than serve it.
    return !hash || hash(local) === asset.sha256;
  };

  const assets = {};
  for (const asset of wanted) {
    const local = `${cacheDir}/${asset.name}`;
    if (!have(asset)) {
      log(`downloading ${asset.name}`);
      download(dir + asset.name, local);
      if (hash && hash(local) !== asset.sha256) {
        throw new Error(`${asset.name} failed its hash check`);
      }
    }
    assets[asset.name] = asset.sha256;
  }

  // Drop anything the manifest no longer references (deltas folded into a fresh base).
  const keep = new Set(["manifest.json", "installed.json", ...wanted.map((a) => a.name)]);
  for (const name of fs.readdirSync(cacheDir)) {
    if (!keep.has(name)) fs.rmSync(`${cacheDir}/${name}`, { force: true });
  }

  fs.writeFileSync(installedPath, JSON.stringify({ version: manifest.version, assets }));
  return wanted.map((a) => `${cacheDir}/${a.name}`);
}