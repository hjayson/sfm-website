# SFM Client Portal — Team Guide

Every client gets a live progress page at:
**https://www.salesfunnelmarketing.us/clients/<client-name>.html** + a 4-digit access code.

Example: Cari Hines → `/clients/cari-hines.html` · code `2468`

## Add a new client (5 minutes)
1. Copy `client-portal-template.html` (repo root) into `sfm-deploy-v3/clients/` and rename it, e.g. `acme-roofing.html`.
2. Open it and edit ONLY the `CLIENT = { ... }` block at the bottom: name, a fresh 4-digit `accessCode`, tagline, projects.
3. Optional: drop their logo into `sfm-deploy-v3/images/logos/` and point `logo:` at it (falls back to the SFM logo).
4. Commit + push to `main`. Netlify deploys automatically (~1 min).
5. Text the client their link + code.

## Weekly update (2 minutes per client)
Edit the client file's `CLIENT` block:
- `weeklyNote` — one friendly paragraph from us
- `plan` — this week's actions
- each project's `percent` and stages (`done:true` / `current:true`)
- `nextSteps` (us) and `yourTurn` (them)
- `updated` — today's date
Commit + push.

## Rules
- One file per client. Never reuse an access code across clients.
- Don't touch anything below the `EDIT ABOVE` line in the file.
- `/clients/` is blocked from Google (robots.txt + noindex + X-Robots-Tag) — light privacy, fine for project status, not for sensitive data.
- Keep codes/links out of public posts; share by text/email only.

## Current clients
| Client | URL | Code |
|---|---|---|
| Cari Hines Personal Training | /clients/cari-hines.html | 2468 |
| Legacy Law Group (LLG) | /clients/legacy-law-group.html | 7301 |
| Corporate Intelligence Consultants (CIC) | /clients/corporate-intelligence.html | 5142 |
| National Exchange Club (NEC) | /clients/national-exchange-club.html | 6273 |
| TRIO Veterans Upward Bound (VUB) | /clients/veterans-trio.html | 8094 |
| Fuller & Sons Insurance | /clients/fuller-and-sons.html | 3517 |
| VJ's Towing | /clients/vjs-towing.html | 9426 |
| Bargain Towing | /clients/bargain-towing.html | 3164 |
| Perrysburg Heights Community Assoc. | /clients/perrysburg-heights.html | 4310 |

## Master dashboard (team only)
**/clients/master.html · master code 4750** — toggle through every client portal in one view (auto-unlocked), see last-updated + progress, and hit "✏️ Edit here" to update any client right on the page — weekly note, plan, percents, stages, add/remove projects (e.g., a new SEO task) — Save commits to GitHub and redeploys in ~1 min. One-time setup per browser: ⚙︎ GitHub button → paste a fine-grained token (repo: sfm-website, Contents: Read & write). "GitHub ↗" still opens the raw file as a fallback. When adding a client, also add them to the CLIENTS list inside master.html.
