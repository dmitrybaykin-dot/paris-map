/**
 * fetch-notion.js
 * Pulls all pages from the Paris Locations Notion database,
 * geocodes the Address field via Nominatim (OpenStreetMap),
 * and writes data/locations.json for the map.
 *
 * Free, no API keys needed (besides Notion).
 * Geocode results are cached in data/geocache.json so Nominatim
 * is only called for new or changed addresses.
 *
 * Usage:
 *   NOTION_API_KEY=secret_xxx node scripts/fetch-notion.js
 */

const fs = require('fs');
const path = require('path');

const NOTION_API_KEY = process.env.NOTION_API_KEY;
const DATABASE_ID = process.env.DATABASE_ID || 'c2dc61fb15b64b348ec0f395cce32dfb';

if (!NOTION_API_KEY) {
  console.error('❌ NOTION_API_KEY is required.');
  process.exit(1);
}

const NOTION_API = 'https://api.notion.com/v1';
const HEADERS = {
  'Authorization': `Bearer ${NOTION_API_KEY}`,
  'Notion-Version': '2022-06-28',
  'Content-Type': 'application/json'
};

const DATA_DIR = path.join(__dirname, '..', 'data');
const GEOCACHE_PATH = path.join(DATA_DIR, 'geocache.json');

// ── Notion ──────────────────────────────────────────────────

async function queryAll() {
  let results = [];
  let cursor = undefined;

  while (true) {
    const body = { page_size: 100 };
    if (cursor) body.start_cursor = cursor;

    const res = await fetch(`${NOTION_API}/databases/${DATABASE_ID}/query`, {
      method: 'POST',
      headers: HEADERS,
      body: JSON.stringify(body)
    });

    if (!res.ok) {
      const err = await res.text();
      console.error(`❌ Notion API error ${res.status}:`, err);
      throw new Error(`Notion API ${res.status}`);
    }

    const data = await res.json();
    results = results.concat(data.results);
    if (!data.has_more) break;
    cursor = data.next_cursor;
  }
  return results;
}

function extractText(richTextArray) {
  if (!richTextArray || !Array.isArray(richTextArray)) return '';
  return richTextArray.map(r => r.plain_text || '').join('');
}

function parsePage(page) {
  const p = page.properties;
  return {
    id: page.id,
    name: extractText(p['Name']?.title),
    address: extractText(p['Address']?.rich_text),
    summary: extractText(p['Summary']?.rich_text),
    time_period: extractText(p['Time period']?.rich_text),
    type: p['Type']?.select?.name || '',
    tags: (p['Tags']?.multi_select || []).map(t => t.name),
    source_link: p['Source link']?.url || '',
    notion_url: page.url,
  };
}

// ── Geocoding ───────────────────────────────────────────────

function loadCache() {
  try {
    return JSON.parse(fs.readFileSync(GEOCACHE_PATH, 'utf-8'));
  } catch {
    return {};
  }
}

function saveCache(cache) {
  fs.writeFileSync(GEOCACHE_PATH, JSON.stringify(cache, null, 2));
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function geocode(address) {
  const url = 'https://nominatim.openstreetmap.org/search?' + new URLSearchParams({
    q: address,
    format: 'json',
    limit: '1',
    countrycodes: 'fr'
  });

  const res = await fetch(url, {
    headers: { 'User-Agent': 'paris-locations-map/1.0 (github-pages-sync)' }
  });

  if (!res.ok) {
    console.warn(`   ⚠️  Nominatim ${res.status} for "${address}"`);
    return null;
  }

  const data = await res.json();
  if (!data.length) {
    console.warn(`   ⚠️  No geocode results for "${address}"`);
    return null;
  }

  return {
    lat: parseFloat(data[0].lat),
    lng: parseFloat(data[0].lon),
  };
}

// ── Main ────────────────────────────────────────────────────

async function main() {
  console.log('📡 Fetching from Notion…');
  const pages = await queryAll();
  console.log(`   ${pages.length} pages found\n`);

  const parsed = pages.map(parsePage);
  const cache = loadCache();
  let cacheHits = 0;
  let geocoded = 0;

  const locations = [];

  for (const loc of parsed) {
    if (!loc.address) {
      console.warn(`   ❌ No address: "${loc.name}"`);
      continue;
    }

    let lat, lng;

    // Check cache first
    if (cache[loc.address]) {
      lat = cache[loc.address].lat;
      lng = cache[loc.address].lng;
      cacheHits++;
    } else {
      // Geocode (respect Nominatim 1 req/sec limit)
      await sleep(1100);
      const result = await geocode(loc.address);
      if (result) {
        lat = result.lat;
        lng = result.lng;
        cache[loc.address] = { lat, lng };
        geocoded++;
        console.log(`   🌐 Geocoded: "${loc.name}" → ${lat}, ${lng}`);
      } else {
        continue;
      }
    }

    locations.push({
      id: loc.id,
      name: loc.name,
      lat,
      lng,
      address: loc.address,
      type: loc.type,
      tags: loc.tags,
      summary: loc.summary,
      time_period: loc.time_period,
      source_link: loc.source_link,
      notion_url: loc.notion_url
    });
  }

  // Save geocode cache
  saveCache(cache);

  // Write locations.json
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(path.join(DATA_DIR, 'locations.json'), JSON.stringify(locations, null, 2));

  // Meta
  const missing = parsed.length - locations.length;
  fs.writeFileSync(path.join(DATA_DIR, 'meta.json'), JSON.stringify({
    last_sync: new Date().toISOString(),
    total_pages: pages.length,
    on_map: locations.length,
    cache_hits: cacheHits,
    freshly_geocoded: geocoded,
    missing
  }, null, 2));

  console.log(`\n✅ Done!`);
  console.log(`   📍 ${locations.length}/${parsed.length} locations on map`);
  console.log(`   💾 ${cacheHits} from cache, 🌐 ${geocoded} freshly geocoded`);
  if (missing > 0) {
    console.log(`   ❌ ${missing} missing — fill in the Address field in Notion`);
  }
}

main().catch(err => {
  console.error('\n❌ Failed:', err.message);
  process.exit(1);
});
