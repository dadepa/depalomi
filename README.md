# depalomi.com

Personal website and CMS for Davide De Palomi — photographer, video editor, web developer and n8n automation specialist.

## Stack

- **Backend**: Pure Node.js (zero npm dependencies) — built-in `http`, `crypto`, `fs/promises`, `path`
- **Frontend**: Vanilla HTML/CSS/JS — no frameworks, no build step
- **Storage**: JSON files + local filesystem for uploads
- **Auth**: `crypto.scrypt` password hashing, 256-bit session tokens, HttpOnly + SameSite=Strict cookies

## Structure

```
├── server.js           # HTTP server — API + static file serving
├── lib/                # Server-side helpers
│   └── immoscout-export.js
├── package.json
├── public/             # Public website
│   ├── index.html      # Homepage with video hero
│   ├── fotografie.html
│   ├── video.html
│   ├── webseiten.html
│   ├── automatisierung.html
│   ├── immoscout-tool.html
│   ├── immoscout-tool.js
│   ├── impressum.html
│   ├── 404.html
│   ├── 500.html
│   ├── styles.css
│   ├── script.js
│   └── videos/         # Place hero.mp4 here
├── admin/              # Password-protected CMS
│   ├── index.html      # Login
│   └── dashboard.html  # Portfolio & project management
└── data/               # Auto-created at runtime
    ├── config.json     # Hashed admin password
    ├── portfolio.json  # Photos & videos
    ├── projects.json   # Client preview projects
    └── uploads/        # Uploaded images
```

## Getting Started

```bash
node server.js
```

On first run, the server creates `data/` and generates a random admin password printed to the console. Open `http://localhost:3000/admin` to log in.

```bash
# Development (auto-restart on file changes)
npm run dev
```

### Environment

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | HTTP port |
| `NODE_ENV` | — | Set to `production` to enable Secure cookie flag |
| `CHROME_PATH` | auto-detect | Chrome/Chromium executable for ImmoScout PDF export |
| `IMMOSCOUT_CHROME_PROFILE_DIR` | temp profile | Optional Chrome profile dir, e.g. when an authenticated browser profile is needed |
| `OPENAI_API_KEY` | — | Optional: enables GPT-assisted field extraction when real listing text is available |
| `OPENAI_MODEL` | `gpt-4.1-mini` | Optional model override for GPT-assisted extraction |

## CMS Features

- **Fotografie**: Upload photos (JPEG, PNG, WEBP) with title, category, description and visibility toggle
- **Video**: Add videos by URL (YouTube, Vimeo, direct link)
- **Kunden-Previews**: Password-protected client preview pages — embed any staging URL in an iframe
- **Settings**: Change admin password

## Internal Tools

- **ImmoScout Export**: `/immoscout-tool/` accepts ImmoScout expose URLs behind the existing admin login and creates a ZIP with `immoscout-export.xlsx`, one `<Immoscout-ID>.pdf` per accessible listing, and `hinweise.txt`.
- **Browser-Import**: The tool also generates a bookmarklet. Save it once, paste ImmoScout expose URLs into `/immoscout-tool/`, start the automatic URL run, then run the bookmarklet on each opened expose. The tool tab stays open while ImmoScout runs in a second tab.
- The direct server export uses local Chrome for page rendering and PDF creation. It detects ImmoScout protection/Captcha pages and leaves missing values empty instead of trying to bypass them.

## Hero Video

Place your video file at:

```
public/videos/hero.mp4
```

Optional additions for better browser support and faster initial load:

```
public/videos/hero.webm     # Better compression (Chrome/Firefox)
public/videos/hero-poster.jpg  # Still frame shown while video loads
```

Recommended specs: 1920×1080, H.264, no audio, 10–30 sec loop, under 20 MB.

## Security

- Rate limiting on login (5 attempts, 15 min lockout)
- Timing-safe password comparison
- Path traversal protection on static file serving
- MIME type validation on uploads
- Body size limit (12 MB)
- Security headers: CSP, X-Frame-Options, Referrer-Policy, Permissions-Policy

## License

Private — all rights reserved.
