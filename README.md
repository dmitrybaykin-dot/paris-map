# 🗺️ Paris Locations Map

Live map powered by your Notion database. Auto-syncs every 6 hours via GitHub Actions.

## Setup (5 minutes)

### 1. Create a Notion Integration

1. Go to [notion.so/my-integrations](https://www.notion.so/my-integrations)
2. Click **"New integration"**
3. Name it `paris-map` (or anything)
4. Select your workspace
5. Copy the **Internal Integration Secret** (starts with `secret_`)

### 2. Share your database with the integration

1. Open your **Paris Locations** database in Notion
2. Click **⋯** (top right) → **Connections** → **Connect to** → select `paris-map`

### 3. Create the GitHub repo

```bash
git init paris-map && cd paris-map
# Copy all project files here, then:
git add .
git commit -m "initial commit"
git remote add origin git@github.com:YOUR_USERNAME/paris-map.git
git push -u origin main
```

### 4. Add the secret to GitHub

1. Go to your repo → **Settings** → **Secrets and variables** → **Actions**
2. Click **"New repository secret"**
3. Name: `NOTION_API_KEY`
4. Value: paste your `secret_xxx` token

### 5. Enable GitHub Pages

1. Go to **Settings** → **Pages**
2. Source: **Deploy from a branch**
3. Branch: `gh-pages` / `/ (root)`
4. Save

### 6. Run the first sync

Go to **Actions** tab → **Sync Notion → Map** → **Run workflow**

Your map will be live at `https://YOUR_USERNAME.github.io/paris-map/`

## How it works

```
Notion DB  ──(every 6h)──▶  GitHub Action  ──▶  data/locations.json  ──▶  Static HTML map
```

- **GitHub Action** runs `scripts/fetch-notion.js` on a schedule
- The script calls the Notion API, extracts coordinates + metadata, writes `data/locations.json`
- Commits the JSON and deploys to GitHub Pages
- The `index.html` reads the JSON client-side — no backend needed

## Local development

```bash
# First sync
NOTION_API_KEY=secret_xxx node scripts/fetch-notion.js

# Serve locally
npx serve .
# Open http://localhost:3000
```

## Force sync

- **From GitHub**: Actions tab → Run workflow
- **Automatic**: Every push to `main`, or every 6 hours
- **Local**: Run the fetch script, commit, push

## Customization

- Edit colors/styles in `index.html`
- Change sync frequency in `.github/workflows/sync.yml` (cron expression)
- Add new Type categories: update `TYPE_COLORS` in the HTML
