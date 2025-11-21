const nodejs = require("nodejs-mobile-cordova");
const fs = require("fs");
const path = require("path");
const https = require("https");
const http = require("http");
const AdmZip = require("adm-zip");
const nodeStatic = require("node-static");
const vm = require("vm");
const Module = require("module");

const DEFAULT_REPO = "https://github.com/libnoname/noname.git";
const resourcesRoot = path.join(process.cwd(), "resources");
const downloadsRoot = path.join(process.cwd(), "downloads");
const metadataPath = path.join(resourcesRoot, "metadata.json");

function debugLog(...args) {
  try {
    console.log("[Node]", ...args);
  } catch (err) {
    // ignore console errors to avoid crashing the runtime
  }
}

let currentConfig = {
  resourceUrl: DEFAULT_REPO,
  branch: "main",
  version: null,
};
let wssController = null;
let staticServer = null;
let staticServerPort = null;

ensureDirectories();
loadMetadata();
debugLog("Startup config", currentConfig);

nodejs.channel.on("message", async (raw) => {
  debugLog("Received raw message", raw);
  const data = normalizeMessage(raw);
  debugLog("Normalized message", data);
  try {
    if (!data || typeof data !== "object") {
      return;
    }
    switch (data.type) {
      case "get-state":
        debugLog("Handling get-state");
        sendState();
        break;
      case "set-resource-url":
        if (data.payload && data.payload.url) {
          debugLog("Handling set-resource-url", data.payload);
          currentConfig.resourceUrl = data.payload.url;
          if (data.payload.branch) {
            currentConfig.branch = data.payload.branch;
          }
          saveMetadata();
          sendState();
        }
        break;
      case "download-resources":
        debugLog("Handling download-resources");
        await handleDownload();
        break;
      case "start-server":
        debugLog("Handling start-server");
        await startWsServer();
        break;
      case "stop-server":
        debugLog("Handling stop-server");
        stopWsServer();
        break;
      case "start-web":
        debugLog("Handling start-web");
        await startStaticServer();
        break;
      case "stop-web":
        debugLog("Handling stop-web");
        stopStaticServer();
        break;
      case "shutdown":
        debugLog("Handling shutdown");
        stopStaticServer();
        stopWsServer();
        process.exit(0);
        break;
      default:
        debugLog("Unhandled message type", data.type);
        break;
    }
  } catch (err) {
    debugLog("Error handling message", err);
    sendError(err, data?.type);
  }
});

nodejs.channel.send({ type: "ready", payload: stateSnapshot() });
debugLog("Runtime ready", stateSnapshot());

function ensureDirectories() {
  if (!fs.existsSync(resourcesRoot)) {
    fs.mkdirSync(resourcesRoot, { recursive: true });
  }
  if (!fs.existsSync(downloadsRoot)) {
    fs.mkdirSync(downloadsRoot, { recursive: true });
  }
}

function loadMetadata() {
  try {
    if (fs.existsSync(metadataPath)) {
      const raw = JSON.parse(fs.readFileSync(metadataPath, "utf8"));
      currentConfig = { ...currentConfig, ...raw };
    }
  } catch (err) {
    console.error("Failed to load metadata", err);
  }
}

function saveMetadata() {
  try {
    fs.writeFileSync(
      metadataPath,
      JSON.stringify(currentConfig, null, 2),
      "utf8"
    );
    debugLog("Metadata saved", currentConfig);
  } catch (err) {
    console.error("Failed to save metadata", err);
  }
}

function stateSnapshot() {
  const resourcePath = getResourcePath();
  return {
    resourceUrl: currentConfig.resourceUrl,
    branch: currentConfig.branch,
    version: currentConfig.version,
    hasResources: fs.existsSync(resourcePath),
    serverRunning: Boolean(wssController),
    webServerPort: staticServerPort,
  };
}

function sendState() {
  debugLog("Sending state", stateSnapshot());
  nodejs.channel.send({ type: "state", payload: stateSnapshot() });
}

function sendError(err, context) {
  debugLog("Sending error", { context, message: err?.message || String(err) });
  nodejs.channel.send({
    type: "error",
    payload: {
      context,
      message: err?.message || String(err),
    },
  });
}

function normalizeMessage(raw) {
  if (!raw) {
    return null;
  }
  if (typeof raw === "object" && !Array.isArray(raw)) {
    if (raw.event === "message") {
      return extractEnvelopePayload(raw.payload ?? null);
    }
    return raw;
  }
  if (Array.isArray(raw)) {
    const [first] = raw;
    if (first && typeof first === "object") {
      return first;
    }
    if (typeof first === "string") {
      return safeParse(first);
    }
    return null;
  }
  if (typeof raw === "string") {
    const parsed = safeParse(raw);
    if (parsed && typeof parsed === "object") {
      if (parsed.event === "message") {
        const envelopePayload = extractEnvelopePayload(parsed.payload);
        if (envelopePayload) {
          return envelopePayload;
        }
      }
      return parsed;
    }
  }
  return null;
}

function safeParse(candidate) {
  if (typeof candidate !== "string") {
    return null;
  }
  try {
    return JSON.parse(candidate);
  } catch (error) {
    return null;
  }
}

function extractEnvelopePayload(payload) {
  if (!payload) {
    return null;
  }
  const values = Array.isArray(payload)
    ? payload
    : typeof payload === "string"
    ? safeParse(payload)
    : null;

  if (!values || !Array.isArray(values) || values.length === 0) {
    return null;
  }

  const [first] = values;
  if (first && typeof first === "object") {
    return first;
  }
  if (typeof first === "string") {
    return safeParse(first);
  }
  return null;
}

async function handleDownload() {
  debugLog("Download initiated", currentConfig);
  nodejs.channel.send({ type: "download-started" });
  const { downloadUrl, branch, version } = await resolveSource(
    currentConfig.resourceUrl,
    currentConfig.branch
  );
  currentConfig.branch = branch;
  debugLog("Resolved source", { downloadUrl, branch, version });

  const archivePath = path.join(downloadsRoot, "resource.zip");
  await downloadToFile(downloadUrl, archivePath);
  await unpackResource(archivePath);

  currentConfig.version = version || new Date().toISOString();
  saveMetadata();
  debugLog("Download complete", stateSnapshot());
  nodejs.channel.send({ type: "download-complete", payload: stateSnapshot() });
}

function resolveSource(url, branchFallback) {
  if (url.endsWith(".git")) {
    return resolveGitHub(url, branchFallback);
  }
  return Promise.resolve({
    downloadUrl: url,
    branch: branchFallback || "main",
    version: null,
  });
}

function resolveGitHub(repoUrl, branchFallback) {
  const matches = repoUrl.match(/github.com\/(.+?)\/(.+?)(?:\.git)?$/);
  if (!matches) {
    return Promise.resolve({
      downloadUrl: repoUrl,
      branch: branchFallback || "main",
      version: null,
    });
  }
  const owner = matches[1];
  const repo = matches[2];
  return resolveBranch(owner, repo, branchFallback).then((branch) => {
    const apiUrl = `https://api.github.com/repos/${owner}/${repo}/commits/${branch}`;
    const downloadUrl = `https://codeload.github.com/${owner}/${repo}/zip/refs/heads/${branch}`;
    return fetchJson(apiUrl)
      .then((json) => ({
        downloadUrl,
        branch,
        version: json && json.sha ? json.sha : null,
      }))
      .catch(() => ({
        downloadUrl,
        branch,
        version: null,
      }));
  });
}

function resolveBranch(owner, repo, branchFallback) {
  if (branchFallback) {
    return Promise.resolve(branchFallback);
  }
  return fetchJson(`https://api.github.com/repos/${owner}/${repo}`)
    .then((json) => {
      if (json && typeof json.default_branch === "string") {
        return json.default_branch;
      }
      return "main";
    })
    .catch(() => "main");
}

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const options = new URL(url);
    options.headers = { "User-Agent": "noname-mobile" };
    const client = options.protocol === "http:" ? http : https;
    client
      .get(options, (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          body += chunk;
        });
        res.on("end", () => {
          try {
            resolve(JSON.parse(body));
          } catch (err) {
            reject(err);
          }
        });
      })
      .on("error", reject);
  });
}

function downloadToFile(url, destinationPath) {
  return new Promise((resolve, reject) => {
    const options = new URL(url);
    options.headers = { "User-Agent": "noname-mobile" };
    const client = options.protocol === "http:" ? http : https;
    debugLog("Downloading", options.toString());
    const fileStream = fs.createWriteStream(destinationPath);
    client
      .get(options, (res) => {
        if (
          res.statusCode &&
          res.statusCode >= 300 &&
          res.statusCode < 400 &&
          res.headers.location
        ) {
          debugLog("Redirect detected", res.headers.location);
          fileStream.close();
          fs.rmSync(destinationPath, { force: true });
          downloadToFile(res.headers.location, destinationPath)
            .then(resolve)
            .catch(reject);
          return;
        }
        if (res.statusCode && res.statusCode >= 400) {
          debugLog("Download failed", res.statusCode);
          reject(new Error(`Download failed with status ${res.statusCode}`));
          return;
        }
        const total = Number(res.headers["content-length"] || 0);
        let downloaded = 0;
        res.on("data", (chunk) => {
          downloaded += chunk.length;
          debugLog("Download progress", { downloaded, total });
          nodejs.channel.send({
            type: "download-progress",
            payload: {
              downloaded,
              total,
            },
          });
        });
        res.pipe(fileStream);
        fileStream.on("finish", () => {
          debugLog("Download stream finished");
          fileStream.close(resolve);
        });
      })
      .on("error", (err) => {
        fs.rmSync(destinationPath, { force: true });
        debugLog("Download error", err);
        reject(err);
      });
  });
}

async function unpackResource(archivePath) {
  const tempDir = path.join(downloadsRoot, "extracted");
  if (fs.existsSync(tempDir)) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
  fs.mkdirSync(tempDir, { recursive: true });

  const zip = new AdmZip(archivePath);
  zip.extractAllTo(tempDir, true);

  const entries = fs.readdirSync(tempDir);
  if (!entries.length) {
    throw new Error("Archive did not contain any files");
  }
  const rootFolderName =
    entries.find((entry) =>
      fs.statSync(path.join(tempDir, entry)).isDirectory()
    ) ?? entries[0];
  const extractedRoot = path.join(tempDir, rootFolderName);
  const resourcePath = getResourcePath();
  if (fs.existsSync(resourcePath)) {
    fs.rmSync(resourcePath, { recursive: true, force: true });
  }
  fs.mkdirSync(resourcesRoot, { recursive: true });
  fs.renameSync(extractedRoot, resourcePath);
  fs.rmSync(archivePath, { force: true });
  fs.rmSync(tempDir, { recursive: true, force: true });
}

function getResourcePath() {
  return path.join(resourcesRoot, "noname");
}

async function startWsServer() {
  if (wssController) {
    return;
  }
  const resourcePath = getResourcePath();
  const serverScriptPath = path.join(resourcePath, "game", "server.js");
  if (!fs.existsSync(serverScriptPath)) {
    debugLog("WebSocket server script missing", serverScriptPath);
    throw new Error("server.js not found in resources");
  }

  const scriptContent = fs.readFileSync(serverScriptPath, "utf8");
  const wsModule = require("ws");
  let capturedServer = null;

  const contextRequire = createModuleRequire(serverScriptPath);
  const wrappedRequire = (specifier) => {
    if (specifier === "ws") {
      return new Proxy(wsModule, {
        get(target, prop) {
          if (prop === "Server") {
            const OriginalServer = target.Server;
            return class WrappedServer extends OriginalServer {
              constructor(opts) {
                super(opts);
                capturedServer = this;
              }
            };
          }
          return target[prop];
        },
      });
    }
    return contextRequire(specifier);
  };

  const sandbox = {
    require: wrappedRequire,
    module: { exports: {} },
    exports: {},
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    Buffer,
    process,
  };
  vm.createContext(sandbox);
  vm.runInContext(scriptContent, sandbox, { filename: serverScriptPath });

  if (!capturedServer) {
    throw new Error("Failed to start WebSocket server");
  }

  wssController = {
    instance: capturedServer,
    close() {
      try {
        capturedServer.close();
      } catch (err) {
        console.error("Error closing ws server", err);
      } finally {
        capturedServer = null;
        wssController = null;
      }
    },
  };

  nodejs.channel.send({ type: "server-started" });
  sendState();
}

function stopWsServer() {
  if (!wssController) {
    return;
  }
  wssController.close();
  nodejs.channel.send({ type: "server-stopped" });
  sendState();
}

function createModuleRequire(basePath) {
  if (Module.createRequire) {
    return Module.createRequire(basePath);
  }
  return (specifier) => require(specifier);
}

async function startStaticServer() {
  if (staticServer) {
    debugLog("Static server already running", staticServerPort);
    nodejs.channel.send({
      type: "web-started",
      payload: { port: staticServerPort },
    });
    return;
  }
  const resourcePath = getResourcePath();
  if (!fs.existsSync(resourcePath)) {
    debugLog("Resources not downloaded for static server");
    throw new Error("Resources not downloaded");
  }
  const webRoot = resourcePath;
  const fileServer = new nodeStatic.Server(webRoot);
  staticServerPort = 8321;

  staticServer = http.createServer((req, res) => {
    req
      .on("end", () => {
        fileServer.serve(req, res, (err) => {
          if (err) {
            res.writeHead(err.status, err.headers);
            res.end(err.message);
          }
        });
      })
      .resume();
  });

  await new Promise((resolve, reject) => {
    staticServer.on("error", reject);
    staticServer.listen(staticServerPort, "127.0.0.1", resolve);
  });
  debugLog("Static server started", staticServerPort);
  nodejs.channel.send({
    type: "web-started",
    payload: { port: staticServerPort },
  });
}

function stopStaticServer() {
  if (!staticServer) {
    return;
  }
  try {
    staticServer.close();
  } catch (err) {
    console.error("Error closing static server", err);
  }
  staticServer = null;
  staticServerPort = null;
  debugLog("Static server stopped");
  nodejs.channel.send({ type: "web-stopped" });
}
