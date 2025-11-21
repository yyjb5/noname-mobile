import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { cp, mkdir, rm, stat, lstat } from 'node:fs/promises';
import { existsSync } from 'node:fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = resolve(__dirname, '..');
const nodeProjectSource = join(projectRoot, 'nodejs-assets', 'nodejs-project');

const SUPPORTED_PLATFORMS = {
  android: join(
    projectRoot,
    'android',
    'capacitor-cordova-android-plugins',
    'src',
    'main',
    'assets',
    'www',
    'nodejs-project'
  )
};

const PLATFORM_POST_STEPS = {
  async android() {
    await ensureAndroidNativeArtifacts();
  }
};

function parseTargets() {
  const raw = process.argv.slice(2);
  if (raw.length === 0) {
    return Object.keys(SUPPORTED_PLATFORMS);
  }
  const targets = new Set();
  for (const entry of raw) {
    const key = entry.toLowerCase();
    if (!(key in SUPPORTED_PLATFORMS)) {
      console.warn(`Skipping unsupported platform "${entry}".`);
      continue;
    }
    targets.add(key);
  }
  return Array.from(targets);
}

async function ensureNodeProjectExists() {
  try {
    const stats = await stat(nodeProjectSource);
    if (!stats.isDirectory()) {
      throw new Error('Expected a directory at nodejs-assets/nodejs-project');
    }
  } catch (error) {
    throw new Error(
      'Node.js mobile project missing. Run "npm run node:install" first to install dependencies.',
      { cause: error }
    );
  }
}

async function copyNodeProject(destination) {
  await pruneWorkspaceSymlink();
  await rm(destination, { recursive: true, force: true });
  await mkdir(destination, { recursive: true });
  await cp(nodeProjectSource, destination, {
    recursive: true,
    filter: (source) => !source.replace(/\\/g, '/').includes('node_modules/noname-mobile')
  });
}

async function pruneWorkspaceSymlink() {
  const candidate = join(nodeProjectSource, 'node_modules', 'noname-mobile');
  try {
    const info = await lstat(candidate);
    if (info.isSymbolicLink() || info.isDirectory()) {
      await rm(candidate, { recursive: true, force: true });
    }
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw error;
    }
  }
}

async function ensureAndroidNativeArtifacts() {
  const pluginNativeRoot = join(
    projectRoot,
    'android',
    'capacitor-cordova-android-plugins',
    'src',
    'main',
    'libs',
    'cdvnodejsmobile'
  );
  const appLibsRoot = join(projectRoot, 'android', 'app', 'libs');
  const appNativeRoot = join(appLibsRoot, 'cdvnodejsmobile');

  if (!existsSync(pluginNativeRoot)) {
    console.warn(
      `Native assets not found at ${pluginNativeRoot}. The nodejs-mobile plugin may not have been synced.`
    );
    return;
  }

  await mkdir(appLibsRoot, { recursive: true });
  await rm(appNativeRoot, { recursive: true, force: true });
  await cp(pluginNativeRoot, appNativeRoot, { recursive: true });
}

async function main() {
  const targets = parseTargets();
  if (targets.length === 0) {
    console.log('No supported platforms requested. Nothing to do.');
    return;
  }

  if (!existsSync(nodeProjectSource)) {
    throw new Error('Node.js mobile project missing. Run "npm run node:install" first.');
  }

  await ensureNodeProjectExists();

  for (const target of targets) {
    const destination = SUPPORTED_PLATFORMS[target];
    console.log(`Copying Node.js mobile project to ${destination}`);
    await copyNodeProject(destination);
    const postStep = PLATFORM_POST_STEPS[target];
    if (typeof postStep === 'function') {
      await postStep();
    }
  }

  console.log('Node.js mobile assets prepared successfully.');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
