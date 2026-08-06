async function streamServerMain() {
  const { default: fs } = await import("node:fs");
  const { default: path } = await import("node:path");
  const { pathToFileURL } = await import("node:url");

  const [, , cliBinary, torrentSource, selectedIndexText, outputDir, reserveMBText] = process.argv;
  const selectedIndexArg = Number(selectedIndexText);
  const reserveMB = Math.max(256, Number(reserveMBText) || 512);

  if (!cliBinary || !torrentSource || !outputDir) {
    throw new Error("missing stream server arguments");
  }

  const cliEntry = fs.realpathSync(cliBinary);
  const webTorrentEntry = path.resolve(path.dirname(cliEntry), "../node_modules/webtorrent/index.js");
  const { default: WebTorrent } = await import(pathToFileURL(webTorrentEntry).href);

  fs.mkdirSync(outputDir, { recursive: true });

  let client;
  let server;
  let shuttingDown = false;
  let finished = false;
  let diskTimer;

  function availableDiskMB() {
    const stats = fs.statfsSync(outputDir);
    return (stats.bavail * stats.bsize) / (1024 * 1024);
  }

  function finish(exitCode) {
    if (finished) {
      return;
    }
    finished = true;
    try {
      fs.rmSync(outputDir, { recursive: true, force: true });
    } catch (error) {
      process.stderr.write(`cache cleanup failed: ${error}\n`);
    }
    process.exit(exitCode);
  }

  function shutdown(exitCode = 0) {
    if (shuttingDown) {
      finish(exitCode);
      return;
    }
    shuttingDown = true;
    clearInterval(diskTimer);

    const forceExitTimer = setTimeout(() => finish(exitCode), 2000);

    try {
      server?.close();
      server?.closeAllConnections?.();
    } catch (_) {
      // Continue with client teardown and cache cleanup.
    }

    if (!client) {
      clearTimeout(forceExitTimer);
      finish(exitCode);
      return;
    }

    try {
      client.destroy(() => {
        clearTimeout(forceExitTimer);
        finish(exitCode);
      });
    } catch (_) {
      clearTimeout(forceExitTimer);
      finish(exitCode);
    }
  }

  function fail(error) {
    const message = error instanceof Error ? error.stack || error.message : String(error);
    process.stderr.write(`${message}\n`);
    shutdown(1);
  }

  process.on("SIGINT", () => shutdown(0));
  process.on("SIGTERM", () => shutdown(0));
  process.once("uncaughtException", fail);
  process.once("unhandledRejection", fail);

  client = new WebTorrent();
  client.once("error", fail);

  const torrent = client.add(torrentSource, { path: outputDir });
  torrent.once("error", fail);
  torrent.once("ready", () => {
    if (torrent.files.length === 0) {
      fail(new Error("torrent contains no files"));
      return;
    }

    const videoFilePattern = /\.(mkv|mp4|avi|mov|m4v|webm|ts|m2ts|wmv|mpg|mpeg|flv)$/i;
    const videoFileIndexes = torrent.files
      .map((torrentFile, index) => videoFilePattern.test(torrentFile.name) ? index : -1)
      .filter((index) => index >= 0);
    const defaultCandidates = videoFileIndexes.length > 0
      ? videoFileIndexes
      : torrent.files.map((_, index) => index);
    const selectedIndex = Number.isInteger(selectedIndexArg) && selectedIndexArg >= 0
      ? selectedIndexArg
      : defaultCandidates.reduce(
        (largest, index) => torrent.files[index].length > torrent.files[largest].length ? index : largest,
        defaultCandidates[0],
      );
    const selectedFile = torrent.files[selectedIndex];

    if (!selectedFile) {
      fail(new Error(`torrent has no file at index ${selectedIndex}`));
      return;
    }

    // WebTorrent selects every file by default. Without this, playing one
    // episode downloads the entire season and can fill the disk.
    for (const torrentFile of torrent.files) {
      torrentFile.deselect();
    }
    selectedFile.select();

    process.stdout.write(`[torrent-stream] METADATA: ${JSON.stringify({
      selectedIndex,
      files: torrent.files.map((torrentFile, index) => ({
        index,
        name: torrentFile.path || torrentFile.name,
        length: torrentFile.length,
      })),
    })}\n`);

    const instance = client.createServer({
      hostname: "127.0.0.1",
      origin: "iina://torrent-stream",
    }, "node");
    server = instance.server;
    server.once("error", fail);
    server.listen(0, "127.0.0.1", () => {
      const streamURL = new URL(
        selectedFile.streamURL,
        `http://127.0.0.1:${server.address().port}`,
      );
      process.stdout.write(`[torrent-stream] URL: ${streamURL.href}\n`);
    });

    diskTimer = setInterval(() => {
      try {
        const freeMB = availableDiskMB();
        if (freeMB < reserveMB) {
          process.stderr.write(
            `LOW_DISK_SPACE: ${Math.floor(freeMB)} MB free; stopping torrent stream\n`,
          );
          shutdown(1);
        }
      } catch (error) {
        fail(error);
      }
    }, 2000);
    diskTimer.unref();
  });
}

module.exports = `(${streamServerMain.toString()})()`;
