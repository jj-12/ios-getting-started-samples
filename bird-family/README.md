# Support the Bird Family — memorial & donation site

A single-page, plain HTML/CSS/JS website to support the Bird family of
Riverdale, Utah after the fire: the official ways to help Lindsey and her
sons, updates, and links to news coverage. No build step, no framework; it runs from any static web host or
straight off a USB stick.

Live preview while it's in this repo:
<https://jj-12.github.io/ios-getting-started-samples/bird-family/>

## What's in here

| Path | Purpose |
| --- | --- |
| `index.html` | The page. All editable content is marked `<!-- EDIT: ... -->`. |
| `style.css` | Styling (warm paper background, slate blue, soft gold). |
| `app.js` | Analytics loader, click tracking, copy / share buttons. |
| `config.js` | **The only file you need to touch to turn on analytics** or change the site address. |
| `assets/` | Images: site QR, social preview card, favicon, floral artwork. |
| `qr/` | Print-ready QR code (PNG + SVG) and a letter-size printable flyer (`qr/print.html`). |
| `tools/make-qr.py` | Regenerates the QR codes from the `siteUrl` in `config.js`. |
| `tools/make-og-image.py` | Regenerates the social preview image. |
| `tools/make-zip.sh` | Packages the site for upload to another host. |

## Editing the content

Open `index.html` in any text editor and search for `EDIT`. You'll find:

- the hero headline and intro,
- the "Updates" timeline (service details, meal trains, etc.),
- the list of news articles,
- the contact email in the footer.

## Turning on analytics

1. Go to <https://analytics.google.com>, create a property, and add a
   **Web** data stream for `www.supportthebirdfamily.com`.
2. Copy the Measurement ID (`G-XXXXXXXXXX`) into `config.js`:

   ```js
   ga4MeasurementId: 'G-XXXXXXXXXX',
   ```

That's it. The Google script is only loaded when an ID is present, and
never when the page is opened as a local file. Besides page views you'll
see these custom events in GA4 (Reports → Engagement → Events):

| Event | Meaning |
| --- | --- |
| `gofundme_click` | Someone tapped a GoFundMe button (`location` = hero or help). |
| `afcu_copy` | Someone copied the America First account number. |
| `article_click` | Someone opened a news article. |
| `share_copy`, `share_native`, `qr_print` | Share section actions. |
| `section_view` | Visitor scrolled a section into view (`section` = help, updates, news, share). |

Prefer something lighter than Google? Set `plausibleDomain` instead (or as
well) and the same events are sent to [Plausible](https://plausible.io).

Visitors with "Do Not Track" or Global Privacy Control turned on are not
tracked (`respectDoNotTrack: true`).

## QR code for the site

Ready-made codes pointing at `https://www.supportthebirdfamily.com/`:

- `qr/supportthebirdfamily-qr.png` — 2000 px, fine for posters.
- `qr/supportthebirdfamily-qr.svg` — vector, any size.
- `qr/print.html` — open it in a browser and press Print for a letter-size
  flyer with the code, the URL and the ways to give.

If the address ever changes, update `siteUrl` in `config.js` and run:

```sh
pip install "qrcode[pil]"
python3 tools/make-qr.py
```

## Moving the site to another host

```sh
./tools/make-zip.sh
```

This writes `supportthebirdfamily-site.zip` one folder up, containing only
the files a web server needs. Unzip it into the host's web root
(`public_html`, `www`, `htdocs`, …) and the site is live. Every link in
the site is relative, so it works at the root of a domain or in a
subfolder.

Hosting notes for `www.supportthebirdfamily.com`:

- **Any shared host (Bluehost, SiteGround, etc.):** upload the zip
  contents via their file manager or FTP.
- **Netlify / Cloudflare Pages / Vercel:** drag-and-drop the unzipped
  folder; they give you free HTTPS and you point the domain's DNS at them.
- **GitHub Pages:** put these files in their own repository, enable Pages,
  and add a `CNAME` file containing `www.supportthebirdfamily.com`.

Make sure the final host serves HTTPS; the copy buttons and the native
"Share…" button only work on secure pages.

## Local preview

Just double-click `index.html`, or for a closer match to a real server:

```sh
python3 -m http.server 8000
# then open http://localhost:8000/
```
