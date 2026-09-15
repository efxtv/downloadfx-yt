# DownloadFX

A self-hosted, web based video and audio downloader. Paste a link, pick a quality, and download through a clean, minimal web UI. Runs on your own network, handles YouTube (including Shorts), Dailymotion, direct media files, and many other sites via yt-dlp under the hood.

Created and maintained by **EFXTv**.

---

## Why DownloadFX

- Runs entirely on your own machine and network. No third party service in the middle.
- Handles bot-gated YouTube videos from data center or low trust IPs and still delivers high quality using a built in PO token pipeline.
- No build step required. The core is plain Node and static files.
- A quiet, animated background element and a draggable download panel for a pleasant experience.

---

## Requirements

| Requirement | Minimum | Notes |
| --- | --- | --- |
| Node.js | 18+ | Runtime for the web server. Tested on Node 24. |
| Python 3 | 3.9+ | Used to create the venv that runs yt-dlp. |
| ffmpeg / ffprobe | any | Needed for merging video and audio, and MP3 extraction. setup.sh installs it if missing. |
| git | optional | Only needed if setup.sh has to fetch the PO token provider from scratch. |
| npm | optional | Only needed if setup.sh has to rebuild the PO token provider locally. |
| Docker | optional | Alternative way to run the PO token provider without npm. |

Node, Python, and (optionally) Docker must already exist on the machine. setup.sh never installs system packages.

---

## Installation

Copy the whole project folder to the target machine, then run:

```bash
bash setup.sh
npm start
```

Or run the server directly without npm:

```bash
node server.js
```

The server listens on `http://localhost:3100` by default and is reachable from other devices on the same network at `http://YOUR-LAN-IP:3100`.

To change the port:

```bash
PORT=8080 node server.js
```

---

## What setup.sh does

setup.sh recreates the parts of this project that are specific to the operating system, so a folder copied from one machine keeps working on another. It never touches anything outside the project folder.

1. Builds a Python virtual environment at `.venv` and installs:
   - `yt-dlp[default]` (includes curl_cffi for browser impersonation)
   - `bgutil-ytdlp-pot-provider` (fetches YouTube proof-of-origin tokens)
   - `yt-dlp-ejs` (solves the YouTube JavaScript n signature)
2. Ensures `bin/ffmpeg` and `bin/ffprobe` work. It keeps yours if it runs, copies the system binary if one exists, or downloads a static build.
3. Sets up the PO token provider at `bgutil-provider`:
   - Uses Docker if available (no npm needed), or
   - Rebuilds it locally with `npm ci` and `npx tsc`, or
   - Clones it from GitHub first if the folder was not copied.

If Docker and npm are both missing, setup.sh warns you and the app still runs. Bot-gated YouTube videos may then be capped at low quality, but everything else still works.

---

## How downloads work

Every download request creates a temporary job folder under the system temp directory. The file is written there, the folder size is polled for progress, and the folder is deleted as soon as the file is sent to your browser.

- `POST /api/info` resolves a link and returns all available formats.
- `GET /api/download` downloads the chosen format, including merge and MP3 extraction.
- `GET /api/progress?id=...` reports live progress for the UI.

Orphaned temp folders from crashed sessions or aborted connections are swept automatically at startup and every 10 minutes.

---

## How the YouTube 4K unlock works

Many server IPs are flagged by YouTube, which then returns only low-quality formats even for videos uploaded in 4K. DownloadFX solves this without any login.

```
DownloadFX  →  yt-dlp  →  YouTube
                  │
                  ├── PO token       ← bgutil-provider (port 4416)
                  ├── visitor data   ← fetched fresh, cached 30 min
                  └── n signature    ← solved with the node runtime
```

1. A fresh visitor identifier is fetched from YouTube and cached for 30 minutes.
2. On each video, the bgutil-attestation pipeline mints a proof-of-origin token.
3. yt-dlp uses the `node` runtime to solve the player signature challenge.
4. Extraction runs through high-quality web clients with Android as a last resort.

The provider is a local HTTP server on `127.0.0.1:4416`. The server.js process starts it automatically on boot and prints its status at startup.

---

## Optimizations for heavy use

If you download many videos from one IP, keep these in mind.

| Matter | Guidance |
| --- | --- |
| Volume | A few videos at a time is safe. Dozens at once will trigger rate limits. |
| Queue | Download one video at a time and pause between downloads. |
| Cookies | A logged-in browser cookie file raises limits a lot. See below. |
| Recovery | If YouTube starts rate limiting, wait a few hours and it clears. |

### cookies.txt (optional, powerful)

Export cookies from a logged-in YouTube session in your browser (for example with the "Get cookies.txt LOCALLY" extension) and save the file as `cookies.txt` next to `server.js`. It is detected automatically on the next request. Cookies expire after a few weeks and need a fresh export.

Verify a cookie file works from the project root:

```bash
.venv/bin/yt-dlp -J --no-warnings \
  --extractor-args "youtube:player_client=web_embedded,mweb,android" \
  --cookies cookies.txt https://www.youtube.com/watch?v=dQw4w9WgXcQ \
  | grep -o '"height":[0-9]*'
```

### Proxy / exit IP

Route YouTube traffic through another exit IP by setting an environment variable before starting the server:

```bash
YTDLP_PROXY=http://127.0.0.1:1080 node server.js
```

A clean residential exit IP is the most reliable way to avoid quality caps entirely.

---

## Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3100` | HTTP port for the web UI and API. |
| `YTDLP_PROXY` | unset | Proxy used by yt-dlp for every extraction and download. |

---

## Project structure

```
DownloadFX/
├── server.js          Express server, resolver, download jobs, provider boot
├── setup.sh           One-shot OS setup (venv, ffmpeg, PO provider)
├── README.md
├── public/            Static web UI (no framework, no build step)
│   ├── index.html
│   ├── style.css
│   └── app.js
├── bin/               ffmpeg, ffprobe, standalone yt-dlp
├── bgutil-provider/   PO token HTTP server (port 4416)
└── .venv/             Python environment with yt-dlp and plugins
```

---

## Supported sources

DownloadFX is powered by yt-dlp, so it reaches a very wide range of sites. Popular ones include:

| Group | Sites |
| --- | --- |
| YouTube | YouTube, YouTube Music, Shorts, youtu.be links, playlists |
| Video platforms | Dailymotion, Vimeo, Twitch (clips/VODs), Rumble, BitChute, Odysee, PeerTube, Bilibili, VK, streamable, 9GAG, Facebook Watch, Reddit, X / Twitter videos, TikTok |
| Music & audio | SoundCloud, Bandcamp, Mixcloud, Spotify, TIDAL, Deezer, Apple Podcasts, NPR, archive.org audio |
| Learning & talks | TED, Coursera, Udemy, Khan Academy, Skillshare, LinkedIn Learning |
| News & TV | BBC, DW, France24, Al Jazeera, CBC, CNN, Euronews, Bloomberg, CNBC, NHK |
| Direct links | Raw MP4, MKV, AVI, MOV, WEBM, M3U8/HLS streams, MP3, FLAC, WAV, M4A and most media files |
| Generic pages | Any page that embeds video or audio via OpenGraph, video tags, or HTML5 media, handled automatically |

Two tiers of reliability from this app:

- **Tier 1: works without login or extra setup.** YouTube (including 4K via the built-in anti-bot unlock), Dailymotion, direct file links, and scraped pages. Verified working.
- **Tier 2: supported but may require cookies or a clean IP.** Twitch, Vimeo, Instagram, TikTok, and some news sites may enforce login walls, geo-restrictions, or bot checks. These depend on the site, your IP, and whether you supply a cookies.txt file. The app reports the real reason when a site blocks a request.

If the site you need is not listed, paste the link anyway. yt-dlp tracks hundreds of extractors and the app falls back to generic page scraping, so many unlisted sites still work.

Cloudflare-heavy or login-walled sites (for example Vimeo, TikTok, and Instagram from restrictive IPs) may reject automated access. The app reports the real reason when a site blocks it.

---

## Notes and fair use

- Download only content you have the right to download. Respect YouTube and site terms of service.
- The PO token mechanism is unofficial and can be patched by YouTube at any time. If quality drops, refresh the bundled tools with `pip install -U yt-dlp bgutil-ytdlp-pot-provider yt-dlp-ejs` and rebuild the provider, or use cookies.
- This tool is for your own media and personal use. Heavy scraping from one IP may get that IP rate limited by YouTube.
- The background and panel are purely local UI. No analytics, no tracking, no external requests beyond the media sources you ask it to fetch.

---

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| Server does not start | Check Node is 18+ and run `bash setup.sh` once first. |
| YouTube videos capped at low quality | Let the PO provider run (check the startup log), use cookies.txt, or set YTDLP_PROXY. |
| Merge or MP3 extraction fails | Make sure ffmpeg works (run setup.sh again). |
| Downloads stay at 0% | A site is streaming without a content length. Progress may jump at the end. |
| Port in use | Set `PORT` to something free. |
| Quality note appears in the UI | YouTube is actively restricting that video. This is expected for some fresh or protected videos. |

---

© EFXTv. DownloadFX is provided as free software for personal, non-commercial use.
