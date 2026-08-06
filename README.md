# IINA Torrent Stream Plugin

Stream video from `.torrent` files and `magnet:` links directly in IINA.

## Requirements

- macOS
- IINA 1.4+
- `webtorrent-cli` installed:

```bash
npm i -g webtorrent-cli
```

## Installation

In IINA, open **Settings → Plugins → Install from GitHub** and enter:

```text
maks-tabu/iina-torrent-stream
```

Alternatively, download the `.iinaplgz` file from the latest GitHub release and open it.

## Install (development link)

```bash
/Applications/IINA.app/Contents/MacOS/iina-plugin link /path/to/iina-torrent-stream
```

Restart IINA after linking.

## Releasing

1. Update `version` and increment `ghVersion` in `Info.json`.
2. Commit the changes and create a matching tag, for example `v0.1.3`.
3. Push the commit and tag. GitHub Actions will package the plugin and attach the
   `.iinaplgz` installer to a new GitHub release.

## Usage

1. Open a `.torrent` file in IINA, or open a `magnet:` URL.
2. If the torrent has multiple videos, select an episode in the panel. Use the
   search field to filter by a name such as `s01e05`.
3. The plugin starts `webtorrent` for the selected file only.
4. When the local stream is ready, IINA starts playback automatically.

## Notes

- Plugin stores temporary torrent data in an isolated `/tmp/iina-torrent-stream-<session>-data` directory.
- If disk space is low, stream start can fail. Use `Stop Torrent Stream` to clear temporary cache.

## Menu actions

- `Stop Torrent Stream`
- `Install WebTorrent CLI`
- `Open Torrent Panel`
- `Play Previous Video File`
- `Play Next Video File`
- `Select Torrent Video File`

## Troubleshooting

- If IINA shows `Cannot open file or stream!`, ensure yt-dlp plugin does not intercept local torrent stream URLs.
- Only the selected video file is downloaded. The temporary cache is removed when playback stops or the helper exits, and streaming stops automatically before free disk space falls below 512 MB.
- Add `localhost|127\.0\.0\.1` to `excluded_urls` in:
  - `~/Library/Application Support/com.colliderli.iina/plugins/.preferences/io.iina.ytdl.plist`
