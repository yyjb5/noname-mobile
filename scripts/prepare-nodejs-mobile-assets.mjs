import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { cp, mkdir, rm, stat, lstat, readdir, rename, readFile, writeFile } from 'node:fs/promises';
import { existsSync, createReadStream, createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';
import tarGzFactory from 'tar.gz2';

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
  ),
  ios: join(projectRoot, 'ios', 'App', 'App', 'public', 'nodejs-project')
};

const PLATFORM_POST_STEPS = {
  async android() {
    await ensureAndroidNativeArtifacts();
  },
  async ios() {
    await ensureIosNativeArtifacts();
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
  const pluginProjectRoot = join(projectRoot, 'android', 'capacitor-cordova-android-plugins');
  const pluginNativeRoot = join(
    pluginProjectRoot,
    'src',
    'main',
    'libs',
    'cdvnodejsmobile'
  );
  const pluginLegacyNativeRoot = join(pluginProjectRoot, 'libs', 'cdvnodejsmobile');
  const appLibsRoot = join(projectRoot, 'android', 'app', 'libs');
  const appNativeRoot = join(appLibsRoot, 'cdvnodejsmobile');

  if (!existsSync(pluginNativeRoot)) {
    console.warn(
      `Native assets not found at ${pluginNativeRoot}. The nodejs-mobile plugin may not have been synced.`
    );
    return;
  }

  await ensureLibnodeLayout(pluginNativeRoot);
  await ensureLibnodeUncompressed(pluginNativeRoot);

  await mkdir(join(pluginProjectRoot, 'libs'), { recursive: true });
  await rm(pluginLegacyNativeRoot, { recursive: true, force: true });
  await cp(pluginNativeRoot, pluginLegacyNativeRoot, { recursive: true });

  await mkdir(appLibsRoot, { recursive: true });
  await rm(appNativeRoot, { recursive: true, force: true });
  await cp(pluginNativeRoot, appNativeRoot, { recursive: true });
  await ensureLibnodeLayout(appNativeRoot);
  await ensureLibnodeUncompressed(appNativeRoot);
}

async function ensureIosNativeArtifacts() {
  await patchCapacitorCliDirectoryGuard();
  const pluginFrameworkRoot = join(
    projectRoot,
    'node_modules',
    'nodejs-mobile-cordova',
    'libs',
    'ios',
    'nodemobile'
  );
  await ensureNodeMobileFramework(pluginFrameworkRoot);

  const capacitorPluginSource = join(
    projectRoot,
    'ios',
    'capacitor-cordova-ios-plugins',
    'sources',
    'NodejsMobileCordova'
  );
  if (existsSync(capacitorPluginSource)) {
    await ensureNodeMobileFramework(capacitorPluginSource);
  }

  const capacitorPluginResources = join(
    projectRoot,
    'ios',
    'capacitor-cordova-ios-plugins',
    'resources',
    'NodejsMobileCordova'
  );
  if (existsSync(capacitorPluginResources)) {
    await ensureNodeMobileFramework(capacitorPluginResources);
  }

  await normalizeCordovaPodspec();
}

async function ensureLibnodeLayout(nativeRoot) {
  const libnodeRoot = join(nativeRoot, 'libnode');
  const binSource = join(nativeRoot, 'bin');
  const includeSource = join(nativeRoot, 'include');
  const binDestination = join(libnodeRoot, 'bin');
  const includeDestination = join(libnodeRoot, 'include');

  if (!existsSync(libnodeRoot)) {
    await mkdir(libnodeRoot, { recursive: true });
  }

  if (existsSync(binSource)) {
    await rm(binDestination, { recursive: true, force: true });
    await rename(binSource, binDestination);
  }

  if (existsSync(includeSource)) {
    await rm(includeDestination, { recursive: true, force: true });
    await rename(includeSource, includeDestination);
  }
}

async function ensureLibnodeUncompressed(nativeRoot) {
  const binDirCandidates = [
    join(nativeRoot, 'libnode', 'bin'),
    join(nativeRoot, 'bin')
  ];
  const binDir = binDirCandidates.find((candidate) => existsSync(candidate));
  if (!binDir) {
    return;
  }

  const architectures = await readdir(binDir);
  await Promise.all(
    architectures.map(async (arch) => {
      const archDir = join(binDir, arch);
      const gzPath = join(archDir, 'libnode.so.gz');
      const soPath = join(archDir, 'libnode.so');
      try {
        const gzStats = await stat(gzPath);
        if (gzStats.isFile()) {
          await rm(soPath, { force: true });
          await decompressGzip(gzPath, soPath);
          await rm(gzPath, { force: true });
        }
      } catch (error) {
        if (error.code !== 'ENOENT') {
          throw error;
        }
      }

      try {
        const soStats = await stat(soPath);
        if (!soStats.isFile()) {
          throw new Error();
        }
      } catch {
        throw new Error(`Missing libnode.so for architecture ${arch} at ${soPath}`);
      }
    })
  );
}

async function decompressGzip(source, destination) {
  await pipeline(createReadStream(source), createGunzip(), createWriteStream(destination));
}

async function ensureNodeMobileFramework(baseDir) {
  if (!existsSync(baseDir)) {
    return;
  }

  const nestedDir = join(baseDir, 'nodemobile');
  if (existsSync(nestedDir)) {
    await ensureNodeMobileFramework(nestedDir);
  }

  const archivePath = join(baseDir, 'NodeMobile.framework.tar.zip');
  const frameworkDir = join(baseDir, 'NodeMobile.framework');

  if (existsSync(archivePath)) {
    await extractTarArchive(archivePath, baseDir);
    await rm(archivePath, { force: true });
  }

  if (!existsSync(frameworkDir)) {
    return;
  }
}

async function extractTarArchive(source, destination) {
  await new Promise((resolve, reject) => {
    tarGzFactory()
      .extract(source, destination, (error) => {
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });
  });
}

async function patchCapacitorCliDirectoryGuard() {
  const updateJsPath = join(
    projectRoot,
    'node_modules',
    '@capacitor',
    'cli',
    'dist',
    'ios',
    'update.js'
  );

  if (!existsSync(updateJsPath)) {
    return;
  }

  const marker = 'Skip directories when reading native plugin files';

  let fileContent = await readFile(updateJsPath, 'utf-8');
  if (fileContent.includes(marker)) {
    return;
  }

  const originalSnippet =
    "            await (0, fs_extra_1.copy)(filePath, fileDest);\n" +
    "            if (!codeFile.$.framework) {\n" +
    "                let fileContent = await (0, fs_extra_1.readFile)(fileDest, { encoding: 'utf-8' });\n";

  if (!fileContent.includes(originalSnippet)) {
    console.warn('Unable to apply Capacitor CLI patch: expected snippet not found.');
    return;
  }

  const patchedSnippet =
    "            await (0, fs_extra_1.copy)(filePath, fileDest);\n" +
    "            if (!codeFile.$.framework) {\n" +
    "                // Skip directories when reading native plugin files\n" +
    "                const destStats = await (0, fs_extra_1.stat)(fileDest).catch(() => undefined);\n" +
    "                if (!destStats || !destStats.isFile()) {\n" +
    "                    continue;\n" +
    "                }\n" +
    "                let fileContent = await (0, fs_extra_1.readFile)(fileDest, { encoding: 'utf-8' });\n";

  fileContent = fileContent.replace(originalSnippet, patchedSnippet);
  await writeFile(updateJsPath, fileContent, 'utf-8');
}

async function normalizeCordovaPodspec() {
  const podspecPath = join(
    projectRoot,
    'ios',
    'capacitor-cordova-ios-plugins',
    'CordovaPlugins.podspec'
  );

  if (!existsSync(podspecPath)) {
    return;
  }

  let fileContent = await readFile(podspecPath, 'utf-8');
  const normalized = fileContent
    .replace(/\\/g, '/')
    .replace(/(s\.frameworks\s*=\s*')(.*?)(')/, (_match, prefix, value, suffix) => {
      if (!/[\\/]/.test(value)) {
        return `${prefix}${value}${suffix}`;
      }
      const parts = value.split(/[\\/]/).filter(Boolean);
      const frameworkName = parts.length > 0 ? parts[parts.length - 1] : value;
      return `${prefix}${frameworkName}${suffix}`;
    });

  if (normalized !== fileContent) {
    await writeFile(podspecPath, normalized, 'utf-8');
  }
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
