const {
  console,
  core,
  event,
  file,
  menu,
  mpv,
  standaloneWindow,
  utils,
} = iina;

const STREAM_SESSION_ID = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
const STREAM_PATH_PREFIX = `/tmp/iina-torrent-stream-${STREAM_SESSION_ID}`;
const STREAM_LOG_PATH = `${STREAM_PATH_PREFIX}.log`;
const STREAM_PID_PATH = `${STREAM_PATH_PREFIX}.pid`;
const STREAM_DATA_DIR = `${STREAM_PATH_PREFIX}-data`;
const STREAM_HELPER_VIRTUAL_PATH = "@tmp/stream-server.mjs";
const STREAM_HELPER_SOURCE = require("../lib/stream-server-source.js");
file.write(STREAM_HELPER_VIRTUAL_PATH, STREAM_HELPER_SOURCE);
const STREAM_HELPER_PATH = utils.resolvePath(STREAM_HELPER_VIRTUAL_PATH);
const STARTUP_TIMEOUT_MS = 180000;
const POLL_INTERVAL_MS = 500;
const STREAM_READINESS_TIMEOUT_MS = 45000;
const STREAM_READINESS_EXTRA_TIMEOUT_MS = 90000;
const STREAM_PROBE_TIMEOUT_SEC = 4;
const MIN_FREE_SPACE_MB = 512;
const FILE_SIZE_HEADROOM_MB = 1024;
const DIRECT_SELECT_LIMIT = 20;
const WEBTORRENT_CANDIDATES = [
  "/opt/homebrew/bin/webtorrent",
  "/usr/local/bin/webtorrent",
  "webtorrent",
];
const NODE_CANDIDATES = [
  "/opt/homebrew/bin/node",
  "/usr/local/bin/node",
  "node",
];
const EXTRA_MAGNET_TRACKERS = [
  "udp://tracker.opentrackr.org:1337/announce",
  "udp://open.stealth.si:80/announce",
  "udp://exodus.desync.com:6969/announce",
  "udp://tracker.torrent.eu.org:451/announce",
  "udp://open.demonii.com:1337/announce",
  "udp://open.dstud.io:6969/announce",
  "udp://tracker-udp.gbitt.info:80/announce",
  "udp://explodie.org:6969/announce",
  "udp://tracker.cyberia.is:6969/announce",
];

let loadInProgress = false;
let menuInitialized = false;
let webtorrentBin = "";
let nodeBin = "";
let currentTorrentSource = "";
let currentVideoFiles = [];
let selectedVideoIndex = null;
let currentStreamURL = "";
let streamSessionActive = false;
let autoCleanupToken = 0;
let autoCleanupInProgress = false;
let lastDiskFullAutoCleanupAt = 0;
let startupStatusText = "";
let startupPulseIndex = 0;
let startupTimer = null;
let panelInitialized = false;
let initialSelectionPending = false;
let initialSelectionResolver = null;

console.log("[torrent-stream] plugin loaded");

setupPanel();
setupHooks();
setupAutoCleanupHooks();
event.on("iina.window-loaded", () => {
  setupMenu();
});

function setupMenu() {
  if (menuInitialized) {
    return;
  }

  menuInitialized = true;
  renderMenu();
}

function renderMenu() {
  if (!menuInitialized) {
    return;
  }

  try {
    menu.removeAllItems();

    menu.addItem(
      menu.item("Stop Torrent Stream", async () => {
        await stopCurrentStream(true);
        resetStreamSessionState(true);
        core.osd("Torrent stream stopped");
      }),
    );

    menu.addItem(
      menu.item("Install WebTorrent CLI", () => {
        utils.open("https://github.com/webtorrent/webtorrent-cli#install");
      }),
    );
    menu.addItem(
      menu.item("Open Torrent Panel", () => {
        openPanel();
      }),
    );
    menu.addItem(
      menu.item("Refresh Torrent File List", async () => {
        if (!currentTorrentSource) {
          core.osd("Open a torrent first");
          return;
        }
        try {
          await refreshTorrentFileList(currentTorrentSource);
          if (currentVideoFiles.length > 1) {
            core.osd(`Torrent files: ${currentVideoFiles.length}`);
          } else if (currentVideoFiles.length === 1) {
            core.osd("Only one video file detected");
          } else {
            core.osd("No video files detected yet");
          }
        } catch (error) {
          showError(`Failed to refresh file list:\n${formatError(error)}`);
        }
      }),
    );

    if (currentVideoFiles.length > 1) {
      menu.addItem(menu.separator());
      menu.addItem(
        menu.item("Play Previous Video File", async () => {
          await switchToNeighborVideo(-1);
        }),
      );
      menu.addItem(
        menu.item("Play Next Video File", async () => {
          await switchToNeighborVideo(1);
        }),
      );

      menu.addItem(menu.separator());
      const directCount = Math.min(currentVideoFiles.length, DIRECT_SELECT_LIMIT);
      for (let i = 0; i < directCount; i++) {
        const file = currentVideoFiles[i];
        const order = twoDigits(i + 1);
        menu.addItem(
          menu.item(
            `Play ${order}: ${shortName(baseName(file.name), 40)}`,
            async () => {
              await switchToVideoFile(file.index);
            },
            { selected: file.index === selectedVideoIndex },
          ),
        );
      }

      if (currentVideoFiles.length > DIRECT_SELECT_LIMIT) {
        menu.addItem(
          menu.item(
            `Only first ${DIRECT_SELECT_LIMIT} shown directly (${currentVideoFiles.length} total)`,
            () => {
              core.osd("Use Previous/Next to move beyond first files");
            },
          ),
        );
      }

      menu.addItem(menu.separator());
      const selectItem = menu.item("Select Torrent Video File");

      for (const file of currentVideoFiles) {
        selectItem.addSubMenuItem(
          menu.item(
            formatFileMenuLabel(file),
            async () => {
              await switchToVideoFile(file.index);
            },
            { selected: file.index === selectedVideoIndex },
          ),
        );
      }

      menu.addItem(selectItem);
    }

    postPanelState();
  } catch (error) {
    console.error(`[torrent-stream] menu init failed: ${error}`);
  }
}

function setupPanel() {
  if (!standaloneWindow || typeof standaloneWindow.loadFile !== "function") {
    return;
  }

  try {
    standaloneWindow.loadFile("src/panel.html");
    standaloneWindow.setProperty({ title: "Torrent Stream Panel" });
    panelInitialized = true;
  } catch (error) {
    console.error(`[torrent-stream] panel init failed: ${formatError(error)}`);
    return;
  }

  standaloneWindow.onMessage("panel-ready", () => {
    postPanelState();
  });

  standaloneWindow.onMessage("panel-request-state", () => {
    postPanelState();
  });

  standaloneWindow.onMessage("panel-refresh", async () => {
    if (!currentTorrentSource) {
      core.osd("Open a torrent first");
      postPanelState();
      return;
    }
    try {
      await refreshTorrentFileList(currentTorrentSource);
    } catch (error) {
      showError(`Failed to refresh file list:\n${formatError(error)}`);
    }
    postPanelState();
  });

  standaloneWindow.onMessage("panel-next", async () => {
    await switchToNeighborVideo(1);
    postPanelState();
  });

  standaloneWindow.onMessage("panel-prev", async () => {
    await switchToNeighborVideo(-1);
    postPanelState();
  });

  standaloneWindow.onMessage("panel-select-file", async (payload) => {
    const index = Number(payload && payload.index);
    if (!Number.isInteger(index)) {
      return;
    }
    if (initialSelectionPending) {
      finishInitialSelection(index);
      return;
    }
    await switchToVideoFile(index);
    postPanelState();
  });
}

function openPanel() {
  if (!standaloneWindow || typeof standaloneWindow.open !== "function") {
    return;
  }
  standaloneWindow.open();
  postPanelState();
}

function postPanelState() {
  if (!standaloneWindow || typeof standaloneWindow.postMessage !== "function") {
    return;
  }

  const files = currentVideoFiles.map((file) => ({
    index: file.index,
    name: baseName(file.name),
    fullName: file.name,
    sizeLabel: file.sizeLabel,
    selected: file.index === selectedVideoIndex,
  }));

  standaloneWindow.postMessage("panel-state", {
    hasSource: Boolean(currentTorrentSource),
    selectedIndex: selectedVideoIndex,
    loading: loadInProgress,
    selectionPending: initialSelectionPending,
    files,
  });
}

async function requestInitialVideoSelection() {
  if (currentVideoFiles.length <= 1 || !panelInitialized) {
    return selectedVideoIndex;
  }

  selectedVideoIndex = null;
  initialSelectionPending = true;
  const selection = new Promise((resolve) => {
    initialSelectionResolver = resolve;
  });
  renderMenu();
  openPanel();
  core.osd("Torrent: select an episode to start");
  return await selection;
}

function finishInitialSelection(fileIndex = null) {
  const validIndex = Number.isInteger(fileIndex) &&
    currentVideoFiles.some((file) => file.index === fileIndex)
    ? fileIndex
    : null;
  selectedVideoIndex = validIndex;
  initialSelectionPending = false;
  const resolve = initialSelectionResolver;
  initialSelectionResolver = null;
  renderMenu();
  postPanelState();
  if (validIndex !== null && standaloneWindow && typeof standaloneWindow.close === "function") {
    standaloneWindow.close();
  }
  if (resolve) {
    resolve(validIndex);
  }
}

function setupHooks() {
  mpv.addHook("on_load", 10, async (next) => {
    try {
      core.osd("Torrent: detecting input...");
      await tryHandleTorrentInput({ rewriteCurrentLoad: true });
    } catch (error) {
      console.error(`[torrent-stream] on_load error: ${error}`);
    } finally {
      next();
    }
  });

  mpv.addHook("on_load_fail", 10, async (next) => {
    try {
      await tryHandleTorrentInput({ rewriteCurrentLoad: false });
    } catch (error) {
      console.error(`[torrent-stream] on_load_fail error: ${error}`);
    } finally {
      next();
    }
  });
}

function setupAutoCleanupHooks() {
  safeEventOn("iina.file-loaded", () => {
    void maybeScheduleAutoCleanup("iina.file-loaded");
  });

  safeEventOn("iina.window-will-close", () => {
    void maybeScheduleAutoCleanup("iina.window-will-close", { immediate: true, force: true });
  });

  safeEventOn("mpv.end-file", () => {
    void maybeScheduleAutoCleanup("mpv.end-file");
  });

  safeEventOn("mpv.shutdown", () => {
    void maybeScheduleAutoCleanup("mpv.shutdown", { immediate: true, force: true });
  });
}

function safeEventOn(name, callback) {
  try {
    event.on(name, callback);
  } catch (error) {
    console.error(`[torrent-stream] failed to subscribe ${name}: ${formatError(error)}`);
  }
}

async function maybeScheduleAutoCleanup(reason, options = {}) {
  const { immediate = false, force = false } = options;
  if (!streamSessionActive && !currentStreamURL) {
    return;
  }

  const token = ++autoCleanupToken;
  if (!immediate) {
    await sleep(1200);
  }
  if (token !== autoCleanupToken) {
    return;
  }
  if (loadInProgress || autoCleanupInProgress) {
    return;
  }

  const source = getCurrentSource();
  if (!force && isManagedStreamURL(source)) {
    return;
  }

  autoCleanupInProgress = true;
  try {
    await stopCurrentStream(true);
    resetStreamSessionState(true);
    console.log(`[torrent-stream] auto-cleanup completed (${reason})`);
  } catch (error) {
    console.error(`[torrent-stream] auto-cleanup failed (${reason}): ${formatError(error)}`);
  } finally {
    autoCleanupInProgress = false;
  }
}

function getCurrentSource() {
  try {
    const value = mpv.getString("stream-open-filename");
    if (value) {
      return value;
    }
  } catch (_) {
    // ignore
  }
  try {
    return mpv.getString("path") || "";
  } catch (_) {
    return "";
  }
}

function isManagedStreamURL(source) {
  return /^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):\d+\/webtorrent\//i.test(String(source || ""));
}

function markStreamSessionConnected(streamURL) {
  currentStreamURL = String(streamURL || "");
  streamSessionActive = true;
  autoCleanupToken++;
}

function resetStreamSessionState(clearContext = false) {
  currentStreamURL = "";
  streamSessionActive = false;
  autoCleanupToken++;
  if (!clearContext) {
    return;
  }
  currentTorrentSource = "";
  currentVideoFiles = [];
  finishInitialSelection();
  renderMenu();
  postPanelState();
}

async function maybeAutoCleanupDiskFull(errorText = "") {
  const text = String(errorText || "");
  let matches = /ENOSPC|no space left on device/i.test(text);
  if (!matches) {
    const logText = await readStreamLog(220);
    matches = /ENOSPC|no space left on device/i.test(logText);
  }
  if (!matches) {
    return false;
  }

  const now = Date.now();
  if (now - lastDiskFullAutoCleanupAt < 2000) {
    return true;
  }
  lastDiskFullAutoCleanupAt = now;

  try {
    await stopCurrentStream(true);
    currentStreamURL = "";
    streamSessionActive = false;
    autoCleanupToken++;
    core.osd("Torrent cache cleared (disk full)");
    console.log("[torrent-stream] auto-cleanup: cache cleared after ENOSPC");
    return true;
  } catch (error) {
    console.error(`[torrent-stream] auto-cleanup after ENOSPC failed: ${formatError(error)}`);
    return false;
  }
}

async function tryHandleTorrentInput({ rewriteCurrentLoad = false } = {}) {
  if (loadInProgress) {
    return;
  }

  const source = mpv.getString("stream-open-filename") || "";
  if (!isTorrentSource(source)) {
    return;
  }
  const torrentSource = normalizeTorrentSource(source);
  currentTorrentSource = torrentSource;
  setupMenu();

  loadInProgress = true;
  startStartupOSD("Metadata: searching...");
  let connected = false;

  try {
    webtorrentBin = await resolveWebTorrentBinary();
    if (!webtorrentBin) {
      stopStartupOSD();
      showError("webtorrent is not installed.\nInstall: npm i -g webtorrent-cli");
      return;
    }
    nodeBin = await resolveNodeBinary();
    if (!nodeBin) {
      stopStartupOSD();
      showError("node is not available for IINA plugin process.\nInstall Node.js and restart IINA.");
      return;
    }

    await refreshTorrentFileList(torrentSource);
    if (currentVideoFiles.length > 1) {
      const initialSelection = await requestInitialVideoSelection();
      if (!Number.isInteger(initialSelection)) {
        return;
      }
    }
    setStartupOSDStatus("Torrent: starting stream...");
    const streamURL = await startCurrentSelectionWithRecovery();
    if (!streamURL) {
      stopStartupOSD();
      const message = await buildStreamStartupFailureMessage("Cannot start torrent stream.");
      showError(message);
      return;
    }
    setStartupOSDStatus("Torrent: waiting for media...");
    const streamReady = await waitForStreamReadiness(streamURL, STREAM_READINESS_TIMEOUT_MS);
    if (!streamReady) {
      setStartupOSDStatus("Torrent: waiting (first bytes)...");
      const lateReady = await waitForStreamReadiness(streamURL, STREAM_READINESS_EXTRA_TIMEOUT_MS);
      if (!lateReady) {
        stopStartupOSD();
        const message = await buildStreamStartupFailureMessage(
          "Torrent stream URL is up, but first media bytes are still unavailable.",
        );
        showError(message);
        return;
      }
    }

    const selectedFile = getSelectedVideoFile();
    console.log(`[torrent-stream] using stream URL: ${streamURL}`);
    configurePreferredTracks();
    if (rewriteCurrentLoad) {
      // on_load is still paused here. Rewriting its source avoids starting a
      // nested loadfile command that races with the original .torrent load.
      mpv.set("stream-open-filename", streamURL);
    } else {
      mpv.command("loadfile", [streamURL, "replace"]);
    }
    mpv.set("pause", "no");
    mpv.set("vid", "auto");
    mpv.set("hwdec", "no");
    mpv.set("force-window", "yes");
    mpv.set("file-local-options/force-media-title", buildTitle(torrentSource, selectedFile));
    markStreamSessionConnected(streamURL);
    connected = true;
    stopStartupOSD();
    core.osd("Torrent stream connected");
  } catch (error) {
    stopStartupOSD();
    const msg = formatError(error);
    console.error(`[torrent-stream] handle error: ${msg}`);
    await maybeAutoCleanupDiskFull(msg);
    const message = await buildStreamStartupFailureMessage(`Torrent plugin error: ${msg}`);
    showError(message);
  } finally {
    if (!connected) {
      await stopCurrentStream(true);
      resetStreamSessionState(false);
    }
    loadInProgress = false;
    stopStartupOSD();
  }
}

function isTorrentSource(source) {
  if (!source) {
    return false;
  }
  const lower = source.toLowerCase();
  return lower.startsWith("magnet:") || lower.endsWith(".torrent") || lower.includes(".torrent?");
}

function normalizeTorrentSource(source) {
  if (source.startsWith("file://")) {
    try {
      return decodeURIComponent(source.replace(/^file:\/\//, ""));
    } catch (_) {
      return source.replace(/^file:\/\//, "");
    }
  }
  return source;
}

async function resolveWebTorrentBinary() {
  for (const candidate of WEBTORRENT_CANDIDATES) {
    if (candidate.includes("/")) {
      const res = await utils.exec("/bin/bash", ["-lc", `[ -x ${sh(candidate)} ]`]);
      if (res.status === 0) {
        return candidate;
      }
      continue;
    }

    const res = await utils.exec("/bin/bash", ["-lc", `command -v ${candidate}`]);
    if (res.status === 0 && res.stdout) {
      return res.stdout.trim();
    }
  }
  return "";
}

async function resolveNodeBinary() {
  for (const candidate of NODE_CANDIDATES) {
    if (candidate.includes("/")) {
      const res = await utils.exec("/bin/bash", ["-lc", `[ -x ${sh(candidate)} ]`]);
      if (res.status === 0) {
        return candidate;
      }
      continue;
    }

    const res = await utils.exec("/bin/bash", ["-lc", `command -v ${candidate}`]);
    if (res.status === 0 && res.stdout) {
      return res.stdout.trim();
    }
  }
  return "";
}

async function startWebTorrentProcess(source, fileIndex = null) {
  const bin = webtorrentBin || WEBTORRENT_CANDIDATES[0];
  const node = nodeBin || NODE_CANDIDATES[0];
  const launchSource = enrichMagnetSource(source);
  if (!STREAM_HELPER_PATH) {
    throw new Error("torrent stream helper is missing");
  }

  await stopCurrentStream(true);
  const prepareCmd =
    `rm -f ${sh(STREAM_LOG_PATH)} ${sh(STREAM_PID_PATH)}; ` +
    `mkdir -p ${sh(STREAM_DATA_DIR)}`;
  await utils.exec("/bin/bash", ["-lc", prepareCmd]);

  const requiredMB = getRequiredFreeSpaceMB(fileIndex);
  const freeMB = await getFreeDiskMB();
  if (freeMB > 0 && freeMB < requiredMB) {
    throw new Error(`not enough free disk space (${Math.floor(freeMB)} MB free, need about ${requiredMB} MB)`);
  }

  const selectedIndex = Number.isInteger(fileIndex) ? fileIndex : -1;
  const cmd =
    `nohup ${sh(node)} ${sh(STREAM_HELPER_PATH)} ` +
    `${sh(bin)} ${sh(launchSource)} ${selectedIndex} ${sh(STREAM_DATA_DIR)} ${MIN_FREE_SPACE_MB} ` +
    `> ${sh(STREAM_LOG_PATH)} 2>&1 & ` +
    `echo $! > ${sh(STREAM_PID_PATH)}`;

  const res = await utils.exec("/bin/bash", ["-lc", cmd]);
  if (res.status !== 0) {
    throw new Error(`failed to start webtorrent: ${res.stderr || res.stdout}`);
  }
}

function enrichMagnetSource(source) {
  const value = String(source || "");
  if (!value.toLowerCase().startsWith("magnet:?")) {
    return value;
  }

  const qIndex = value.indexOf("?");
  if (qIndex < 0) {
    return value;
  }

  const base = value.slice(0, qIndex);
  const query = value.slice(qIndex + 1);
  const parts = query ? query.split("&").filter(Boolean) : [];
  const trackerSet = new Set();

  for (const p of parts) {
    if (!/^tr=/i.test(p)) continue;
    const raw = p.slice(3);
    try {
      trackerSet.add(decodeURIComponent(raw));
    } catch (_) {
      trackerSet.add(raw);
    }
  }

  for (const tr of EXTRA_MAGNET_TRACKERS) {
    trackerSet.add(tr);
  }

  const noTrackerParts = parts.filter((p) => !/^tr=/i.test(p));
  const trackerParts = Array.from(trackerSet).map((tr) => `tr=${encodeURIComponent(tr)}`);
  return `${base}?${noTrackerParts.concat(trackerParts).join("&")}`;
}

async function stopCurrentStream(clearData = false) {
  const helperPath = STREAM_HELPER_PATH || "stream-server.mjs";
  const cmd =
    `if [ -f ${sh(STREAM_PID_PATH)} ]; then ` +
    `pid=$(tr -cd '0-9' < ${sh(STREAM_PID_PATH)}); ` +
    `command=$(ps -p "$pid" -o command= 2>/dev/null || true); ` +
    `if [ -n "$pid" ] && (` +
    `printf '%s' "$command" | grep -F -- ${sh(helperPath)} >/dev/null || ` +
    `(printf '%s' "$command" | grep -F -- ${sh("webtorrent")} >/dev/null && ` +
    `printf '%s' "$command" | grep -F -- ${sh(STREAM_DATA_DIR)} >/dev/null)` +
    `); then ` +
    `kill "$pid" 2>/dev/null || true; ` +
    `for i in {1..30}; do kill -0 "$pid" 2>/dev/null || break; sleep 0.1; done; ` +
    `kill -KILL "$pid" 2>/dev/null || true; ` +
    `fi; ` +
    `rm -f ${sh(STREAM_PID_PATH)}; ` +
    `fi; ` +
    (clearData ? `rm -rf ${sh(STREAM_DATA_DIR)}; ` : "");
  await utils.exec("/bin/bash", ["-lc", cmd]);
}

async function waitForStreamURL(timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const directURL = await readStreamURL();
    if (directURL) {
      const log = await readStreamLog();
      applyStreamMetadata(log);
      return directURL;
    }

    const log = await readStreamLog();
    const url = extractLocalURL(log);
    if (url) {
      applyStreamMetadata(log);
      return url;
    }

    const isVerifying = /verifying existing torrent data/i.test(log);
    if (isVerifying) {
      setStartupOSDStatus("Verifying data...");
    } else {
      setStartupOSDStatus("Connecting to peers...");
    }
    await sleep(POLL_INTERVAL_MS);
  }
  return "";
}

async function readStreamURL() {
  const cmd =
    `if [ -f ${sh(STREAM_LOG_PATH)} ]; then ` +
    `grep -F -- '[torrent-stream] URL: ' ${sh(STREAM_LOG_PATH)} | ` +
    `tail -n 1 | cut -d' ' -f3-; fi`;
  const res = await utils.exec("/bin/bash", ["-lc", cmd]);
  if (res.status !== 0) {
    return "";
  }
  return extractLocalURL(res.stdout || "");
}

function startStartupOSD(status) {
  stopStartupOSD();
  startupStatusText = status || "Loading...";
  startupPulseIndex = 0;

  function pulse() {
    if (!startupStatusText) return;
    const pChar = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"][startupPulseIndex % 10];
    const bar = "=".repeat(startupPulseIndex % 11).padEnd(10, " ");
    core.osd(`Torrent: ${pChar} [${bar}] ${startupStatusText}`);
    startupPulseIndex++;
    startupTimer = setTimeout(pulse, 500);
  }
  pulse();
}

function stopStartupOSD() {
  if (startupTimer) {
    clearTimeout(startupTimer);
    startupTimer = null;
  }
}

function setStartupOSDStatus(status) {
  startupStatusText = status || "";
}

async function waitForStreamReadiness(streamURL, timeoutMs) {
  if (!streamURL) {
    return false;
  }

  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await probeStreamReadable(streamURL)) {
      return true;
    }

    const log = await readStreamLog(120);
    const peers = parsePeersFromLog(log);
    if (peers && peers.connected > 0) {
      await sleep(500);
    } else {
      await sleep(POLL_INTERVAL_MS);
    }
  }
  return false;
}

async function probeStreamReadable(streamURL) {
  const cmd =
    `curl -r 0-65535 --max-time ${STREAM_PROBE_TIMEOUT_SEC} ` +
    `-o /dev/null -s -w '%{http_code}:%{size_download}' ${sh(streamURL)}`;
  const res = await utils.exec("/bin/bash", ["-lc", cmd]);
  if (res.status !== 0) {
    return false;
  }

  const raw = String(res.stdout || "").trim();
  const [codeText, sizeText] = raw.split(":");
  const httpCode = Number(codeText);
  const size = Number(sizeText);
  if (!Number.isFinite(httpCode) || !Number.isFinite(size)) {
    return false;
  }
  if (httpCode < 200 || httpCode >= 300) {
    return false;
  }
  return size > 0;
}

async function startCurrentSelection() {
  currentStreamURL = "";
  streamSessionActive = false;
  autoCleanupToken++;
  await stopCurrentStream();
  await startWebTorrentProcess(currentTorrentSource, selectedVideoIndex);
  return await waitForStreamURL(STARTUP_TIMEOUT_MS);
}

async function startCurrentSelectionWithRecovery() {
  return await startCurrentSelection();
}

async function switchToVideoFile(fileIndex) {
  if (!currentTorrentSource || loadInProgress) {
    return;
  }
  if (!Number.isInteger(fileIndex) || fileIndex === selectedVideoIndex) {
    return;
  }

  selectedVideoIndex = fileIndex;
  renderMenu();

  loadInProgress = true;
  core.osd("Torrent: switching file...");
  let switched = false;
  try {
    const streamURL = await startCurrentSelectionWithRecovery();
    if (!streamURL) {
      const message = await buildStreamStartupFailureMessage("Cannot switch to selected torrent file.");
      showError(message);
      return;
    }

    const selectedFile = getSelectedVideoFile();
    // During playback, stream-open-filename alone may not reload current media.
    // Force replacement so selected torrent file is actually switched.
    configurePreferredTracks();
    mpv.command("loadfile", [streamURL, "replace"]);
    mpv.set("pause", "no");
    mpv.set("vid", "auto");
    mpv.set("hwdec", "no");
    mpv.set("force-window", "yes");
    mpv.set("file-local-options/force-media-title", buildTitle(currentTorrentSource, selectedFile));
    markStreamSessionConnected(streamURL);
    switched = true;
    core.osd(selectedFile ? `Playing: ${shortName(selectedFile.name, 56)}` : "Torrent stream connected");
  } catch (error) {
    await maybeAutoCleanupDiskFull(formatError(error));
    const message = await buildStreamStartupFailureMessage(`Failed to switch torrent file: ${formatError(error)}`);
    showError(message);
  } finally {
    if (!switched) {
      await stopCurrentStream(true);
      resetStreamSessionState(false);
    }
    loadInProgress = false;
  }
}

async function switchToNeighborVideo(step) {
  if (!currentVideoFiles.length || !Number.isInteger(step) || step === 0) {
    return;
  }

  const currentPos = currentVideoFiles.findIndex((f) => f.index === selectedVideoIndex);
  const startPos = currentPos >= 0 ? currentPos : 0;
  const nextPos = (startPos + step + currentVideoFiles.length) % currentVideoFiles.length;
  await switchToVideoFile(currentVideoFiles[nextPos].index);
}

async function refreshTorrentFileList(source) {
  const files = await listTorrentFiles(source);
  if (source !== currentTorrentSource) {
    return;
  }
  const videoFiles = files.filter((f) => isVideoFileName(f.name));
  currentVideoFiles = sortVideoFiles(videoFiles);
  console.log(`[torrent-stream] detected video files: ${currentVideoFiles.length}`);

  if (currentVideoFiles.length > 0) {
    const selectedExists = currentVideoFiles.some((f) => f.index === selectedVideoIndex);
    if (!selectedExists) {
      selectedVideoIndex = await pickDefaultVideoIndex(currentVideoFiles);
    }
  } else {
    selectedVideoIndex = null;
  }

  renderMenu();
}

async function listTorrentFiles(source) {
  const localTorrentFiles = await listTorrentFilesFromLocalTorrent(source);
  if (localTorrentFiles.length > 0) {
    return localTorrentFiles;
  }

  const bin = webtorrentBin || WEBTORRENT_CANDIDATES[0];
  const node = nodeBin || NODE_CANDIDATES[0];
  const tempInfoPath = `/tmp/iina-torrent-info-${Date.now()}-${Math.random().toString(36).slice(2)}.json`;
  const extractorScript =
    "const fs=require('fs');const p=process.argv[1];try{const raw=fs.readFileSync(p,'utf8');" +
    "const parsed=JSON.parse(raw);const files=Array.isArray(parsed)?parsed:(Array.isArray(parsed.files)?parsed.files:[]);" +
    "process.stdout.write(JSON.stringify(files));}catch(_){process.stdout.write('[]');}";
  const cmd =
    `${sh(node)} ${sh(bin)} info ${sh(source)} > ${sh(tempInfoPath)} 2>/dev/null; ` +
    `${sh(node)} -e ${sh(extractorScript)} ${sh(tempInfoPath)}; ` +
    `rm -f ${sh(tempInfoPath)}`;
  const res = await utils.exec("/bin/bash", ["-lc", cmd]);
  const output = `${res.stdout || ""}`;
  return parseInfoFiles(output);
}

async function listTorrentFilesFromLocalTorrent(source) {
  if (!isLocalTorrentPath(source)) {
    return [];
  }

  const node = nodeBin || NODE_CANDIDATES[0];
  const parserScript = [
    "const fs=require('fs');",
    "function s(v){if(Buffer.isBuffer(v))return v.toString('utf8');if(v==null)return '';return String(v);}",
    "function parseBencode(buf){let i=0;function p(){const b=buf[i];",
    "if(b===0x69){i++;const st=i;while(i<buf.length&&buf[i]!==0x65)i++;const n=Number(buf.slice(st,i).toString());i++;return Number.isFinite(n)?n:0;}",
    "if(b===0x6c){i++;const a=[];while(i<buf.length&&buf[i]!==0x65)a.push(p());i++;return a;}",
    "if(b===0x64){i++;const o={};while(i<buf.length&&buf[i]!==0x65){const k=s(p());o[k]=p();}i++;return o;}",
    "if(b>=0x30&&b<=0x39){let len=0;while(i<buf.length&&buf[i]!==0x3a){len=len*10+(buf[i]-0x30);i++;}i++;const out=buf.slice(i,i+len);i+=len;return out;}",
    "throw new Error('bad bencode');}return p();}",
    "function toFileList(root){const info=(root&&root.info)||{};",
    "const many=Array.isArray(info.files)?info.files:[];",
    "if(many.length){return many.map((f,idx)=>{const p1=Array.isArray(f['path.utf-8'])?f['path.utf-8']:(Array.isArray(f.path)?f.path:[]);",
    "const parts=p1.map(s).filter(Boolean);const name=(parts.join('/')||s(f['name.utf-8']||f.name)||('file-'+idx));",
    "return {index:idx,name,length:Number(f.length)||0};});}",
    "const single=s(info['name.utf-8']||info.name)||'file-0';",
    "return [{index:0,name:single,length:Number(info.length)||0}];}",
    "try{const path=process.argv[1];const buf=fs.readFileSync(path);const root=parseBencode(buf);const out=toFileList(root);process.stdout.write(JSON.stringify(out));}",
    "catch(_){process.stdout.write('[]');}",
  ].join("");

  const cmd = `${sh(node)} -e ${sh(parserScript)} ${sh(source)}`;
  const res = await utils.exec("/bin/bash", ["-lc", cmd]);
  if (res.status !== 0 || !res.stdout) {
    return [];
  }

  return parseInfoFiles(res.stdout);
}

function isLocalTorrentPath(source) {
  if (!source || typeof source !== "string") {
    return false;
  }
  if (!source.startsWith("/")) {
    return false;
  }
  return /\.torrent(?:\?.*)?$/i.test(source);
}

function parseInfoFiles(output) {
  const text = String(output || "").trim();
  if (!text) {
    return [];
  }

  try {
    const parsed = JSON.parse(text);
    const files = Array.isArray(parsed)
      ? parsed
      : (Array.isArray(parsed.files) ? parsed.files : []);

    return files.map((file, index) => {
      const length = Number(file.length) || 0;
      const parsedIndex = Number(file.index);
      return {
        index: Number.isInteger(parsedIndex) ? parsedIndex : index,
        name: file.path || file.name || `file-${index}`,
        sizeBytes: length,
        sizeLabel: formatBytes(length),
      };
    });
  } catch (error) {
    console.error(`[torrent-stream] failed to parse torrent info: ${error}`);
    return [];
  }
}

function extractStreamMetadata(logText) {
  const lines = String(logText || "").split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const marker = "[torrent-stream] METADATA: ";
    const markerIndex = lines[i].indexOf(marker);
    if (markerIndex < 0) {
      continue;
    }

    try {
      const metadata = JSON.parse(lines[i].slice(markerIndex + marker.length));
      const files = parseInfoFiles(Array.isArray(metadata.files) ? JSON.stringify(metadata.files) : "[]");
      const selectedIndex = Number(metadata.selectedIndex);
      return {
        files,
        selectedIndex: Number.isInteger(selectedIndex) ? selectedIndex : null,
      };
    } catch (error) {
      console.error(`[torrent-stream] failed to parse stream metadata: ${formatError(error)}`);
      return null;
    }
  }
  return null;
}

function applyStreamMetadata(logText) {
  const metadata = extractStreamMetadata(logText);
  if (!metadata) {
    return false;
  }

  currentVideoFiles = sortVideoFiles(metadata.files.filter((file) => isVideoFileName(file.name)));
  selectedVideoIndex = currentVideoFiles.some((file) => file.index === metadata.selectedIndex)
    ? metadata.selectedIndex
    : (currentVideoFiles[0]?.index ?? null);
  renderMenu();
  return true;
}

function isVideoFileName(name) {
  return /\.(mkv|mp4|avi|mov|m4v|webm|ts|m2ts|wmv|mpg|mpeg|flv)$/i.test(name || "");
}

function sortVideoFiles(files) {
  return [...files].sort((a, b) => naturalCompare(a.name, b.name) || a.index - b.index);
}

function getSelectedVideoFile() {
  return currentVideoFiles.find((f) => f.index === selectedVideoIndex) || null;
}

function formatFileMenuLabel(file) {
  const base = `${file.index}: ${shortName(file.name, 52)}`;
  return file.sizeLabel ? `${base} (${file.sizeLabel})` : base;
}

function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value < 1024) return `${value} B`;
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 ** 3) return `${(value / (1024 ** 2)).toFixed(1)} MB`;
  if (value < 1024 ** 4) return `${(value / (1024 ** 3)).toFixed(1)} GB`;
  return `${(value / (1024 ** 4)).toFixed(1)} TB`;
}

function shortName(name, limit) {
  if (!name || name.length <= limit) {
    return name || "";
  }
  return `${name.slice(0, limit - 1)}…`;
}

function baseName(path) {
  const value = String(path || "");
  const parts = value.split("/");
  return parts[parts.length - 1] || value;
}

function naturalCompare(a, b) {
  const aa = String(a || "");
  const bb = String(b || "");
  try {
    return aa.localeCompare(bb, undefined, { numeric: true, sensitivity: "base" });
  } catch (_) {
    const al = aa.toLowerCase();
    const bl = bb.toLowerCase();
    if (al < bl) return -1;
    if (al > bl) return 1;
    return 0;
  }
}

async function readStreamLog(lines = 120) {
  const safeLines = Number.isFinite(lines)
    ? Math.max(20, Math.min(500, Math.floor(lines)))
    : 120;
  const cmd = `if [ -f ${sh(STREAM_LOG_PATH)} ]; then tail -n ${safeLines} ${sh(STREAM_LOG_PATH)}; fi`;
  const res = await utils.exec("/bin/bash", ["-lc", cmd]);
  if (res.status !== 0) {
    return "";
  }
  return res.stdout || "";
}

function extractLocalURL(logText) {
  if (!logText) {
    return "";
  }

  const re = /(https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):\d+[^\s"']*)/g;
  let match;
  let last = "";
  while ((match = re.exec(logText)) !== null) {
    last = match[1];
  }
  return last;
}

function buildTitle(source, selectedFile = null) {
  if (selectedFile && selectedFile.name) {
    return `Torrent: ${selectedFile.name}`;
  }
  if (source.startsWith("magnet:")) {
    return "Torrent Stream (magnet)";
  }
  const parts = source.split("/");
  return `Torrent Stream: ${parts[parts.length - 1] || source}`;
}

function configurePreferredTracks() {
  const options = [
    ["file-local-options/alang", "eng,en"],
    ["file-local-options/slang", "eng,en"],
    ["file-local-options/track-auto-selection", "yes"],
    ["file-local-options/subs-with-matching-audio", "yes"],
    ["file-local-options/aid", "auto"],
    ["file-local-options/sid", "auto"],
    ["file-local-options/sub-visibility", "yes"],
  ];

  for (const [name, value] of options) {
    try {
      mpv.set(name, value);
    } catch (error) {
      console.error(`[torrent-stream] failed to set ${name}: ${formatError(error)}`);
    }
  }
}

function sh(input) {
  return `'${String(input).replace(/'/g, `'\\''`)}'`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getFreeDiskMB() {
  const cmd = `df -Pk / | tail -n 1 | awk '{print $4}'`;
  const res = await utils.exec("/bin/bash", ["-lc", cmd]);
  if (res.status !== 0) {
    return -1;
  }

  const freeKb = Number(String(res.stdout || "").trim());
  if (!Number.isFinite(freeKb) || freeKb <= 0) {
    return -1;
  }

  return freeKb / 1024;
}

function getRequiredFreeSpaceMB(fileIndex) {
  let required = MIN_FREE_SPACE_MB;
  const selected = currentVideoFiles.find((f) => f.index === fileIndex);
  if (selected && selected.sizeBytes > 0) {
    const fileMB = Math.ceil(selected.sizeBytes / (1024 * 1024));
    required = Math.max(required, fileMB + FILE_SIZE_HEADROOM_MB);
  }
  return required;
}

async function pickDefaultVideoIndex(files) {
  if (!Array.isArray(files) || files.length === 0) {
    return null;
  }
  return files[0].index;
}

function twoDigits(n) {
  const value = Number(n);
  if (!Number.isFinite(value)) {
    return "00";
  }
  const s = String(Math.max(0, Math.floor(value)));
  return s.length >= 2 ? s : `0${s}`;
}

function formatError(error) {
  if (!error) {
    return "unknown error";
  }
  if (typeof error === "string") {
    return error;
  }
  if (error.message) {
    return String(error.message);
  }
  return String(error);
}

function showError(message) {
  const text = String(message || "Unknown torrent plugin error.");
  console.error(`[torrent-stream] ${text}`);
  core.osd(text);
}

function extractLastLogLine(text, pattern) {
  const lines = String(text || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    if (pattern.test(lines[i])) {
      return lines[i];
    }
  }
  return "";
}

function parsePeersFromLog(text) {
  const lines = String(text || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = lines[i].match(/\bPeers:\s*(\d+)\s*\/\s*(\d+)/i);
    if (m) {
      return {
        connected: Number(m[1]) || 0,
        total: Number(m[2]) || 0,
      };
    }
  }
  return null;
}

function parseStreamLogError(logText) {
  const text = String(logText || "");
  if (!text.trim()) {
    return "";
  }
  if (/ENOSPC|no space left on device/i.test(text)) {
    return "webtorrent failed: disk is full (ENOSPC).";
  }
  if (/LOW_DISK_SPACE/i.test(text)) {
    return "torrent stream stopped before the disk became full.";
  }
  if (/ENOENT: no such file or directory, mkdir/i.test(text)) {
    return "webtorrent failed: output directory could not be created (ENOENT).";
  }
  if (/EACCES|permission denied/i.test(text)) {
    return "webtorrent failed: permission denied while writing cache.";
  }
  const errorLine = extractLastLogLine(text, /(^Error:)|\bUNEXPECTED ERROR\b/i);
  if (errorLine) {
    return `webtorrent failed: ${errorLine}`;
  }
  return "";
}

async function buildStreamStartupFailureMessage(title) {
  const lines = [title];
  const selected = getSelectedVideoFile();
  const freeMB = await getFreeDiskMB();
  let requiredMB = MIN_FREE_SPACE_MB;

  if (selected && selected.sizeBytes > 0) {
    const fileMB = Math.ceil(selected.sizeBytes / (1024 * 1024));
    requiredMB = Math.max(requiredMB, fileMB + FILE_SIZE_HEADROOM_MB);
    lines.push(`Selected file: ${baseName(selected.name)} (${fileMB} MB).`);
  }

  if (freeMB > 0) {
    lines.push(`Free disk space: ${Math.floor(freeMB)} MB.`);
    if (freeMB < requiredMB) {
      lines.push(`Not enough space for selected file. Need about ${requiredMB} MB.`);
    }
  }

  const logText = await readStreamLog(220);
  const peers = parsePeersFromLog(logText);
  if (peers) {
    lines.push(`Peers: ${peers.connected}/${peers.total}.`);
    if (peers.connected === 0) {
      lines.push("No active peers yet. Stream cannot start until at least one peer sends data.");
    }
  }

  const logError = parseStreamLogError(logText);
  if (logError) {
    lines.push(logError);
  } else if (!logText.trim()) {
    lines.push("No webtorrent log found. webtorrent process likely did not start.");
  } else {
    lines.push("webtorrent did not return a playable local stream URL in time.");
  }

  lines.push("Check disk space and torrent peers, then try again.");
  return lines.join("\n");
}
