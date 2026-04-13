/**
 * fetch-notion.js
 * Pulls all pages from the Paris Locations Notion database,
 * geocodes via Nominatim (OpenStreetMap), and writes
 * data/locations.json for the map.
 *
 * Address resolution (in order):
 *   1. "Address" text field (if filled in Notion)
 *   2. Geocode cache (data/geocache.json)
 *   3. Auto-extract from page Name (part before " — ") + ", Paris, France"
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

/**
 * Try to get address from any property format the API might return.
 */
function extractAddress(addrProp) {
  if (!addrProp) return '';

  // Standard rich_text
  if (addrProp.rich_text) {
    return extractText(addrProp.rich_text);
  }

  // Plain string (shouldn't happen but just in case)
  if (typeof addrProp === 'string') return addrProp;

  // Maybe it's a different type - try common shapes
  if (addrProp.plain_text) return addrProp.plain_text;
  if (addrProp.title) return extractText(addrProp.title);
  if (addrProp.url) return addrProp.url;
  if (addrProp.string) return addrProp.string;

  // Last resort: check for a nested array with plain_text
  for (const key of Object.keys(addrProp)) {
    const val = addrProp[key];
    if (Array.isArray(val) && val.length > 0 && val[0].plain_text) {
      return val.map(r => r.plain_text || '').join('');
    }
  }

  return '';
}

function parsePage(page) {
  const p = page.properties;
  return {
    id: page.id,
    name: extractText(p['Name']?.title),
    address: extractAddress(p['Address']),
    summary: extractText(p['Summary']?.rich_text),
    time_period: extractText(p['Time period']?.rich_text),
    type: p['Type']?.select?.name || '',
    tags: (p['Tags']?.multi_select || []).map(t => t.name),
    source_link: p['Source link']?.url || '',
    notion_url: page.url,
  };
}

// ── Address extraction from Name ────────────────────────────

function extractAddressFromName(name) {
  if (!name) return '';
  let candidate = name.split(/\s[—–-]\s/)[0].trim();
  candidate = candidate.replace(/^[\u{1F000}-\u{1FFFF}\u{2600}-\u{27BF}\u{FE00}-\u{FEFF}]\s*/u, '');
  if (candidate.length < 3) return '';
  return candidate + ', Paris, France';
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

async function geocode(query) {
  const url = 'https://nominatim.openstreetmap.org/search?' + new URLSearchParams({
    q: query,
    format: 'json',
    limit: '1',
    countrycodes: 'fr'
  });

  const res = await fetch(url, {
    headers: { 'User-Agent': 'paris-locations-map/1.0 (github-pages-sync)' }
  });

  if (!res.ok) {
    console.warn(`   ⚠️  Nominatim ${res.status} for "${query}"`);
    return null;
  }

  const data = await res.json();
  if (!data.length) return null;

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

  // ═══ DEBUG: Show raw properties of the first page ═══
  if (pages.length > 0) {
    const firstProps = pages[0].properties;
    console.log('═══ DEBUG: First page property names & types ═══');
    for (const [key, val] of Object.entries(firstProps)) {
      console.log(`   "${key}" → type: "${val.type}"`);
    }

    const addr = firstProps['Address'];
    if (addr) {
      console.log('\n═══ DEBUG: Raw "Address" property ═══');
      console.log(JSON.stringify(addr, null, 2));
    } else {
      console.log('\n⚠️  DEBUG: No "Address" property found!');
      console.log('   Available properties:', Object.keys(firstProps).join(', '));
    }
    console.log('═══════════════════════════════════════════\n');
  }

  const parsed = pages.map(parsePage);
  const cache = loadCache();
  let cacheHits = 0;
  let geocodedNew = 0;
  let failed = 0;

  const locations = [];

  for (const loc of parsed) {
    let query = loc.address || extractAddressFromName(loc.name);

    if (!query) {
      console.warn(`   ❌ Can't resolve: "${loc.name}"`);
      failed++;
      continue;
    }

    let lat, lng;

    if (cache[query]) {
      lat = cache[query].lat;
      lng = cache[query].lng;
      cacheHits++;
    } else {
      await sleep(1100);
      const result = await geocode(query);
      if (result) {
        lat = result.lat;
        lng = result.lng;
        cache[query] = { lat, lng };
        geocodedNew++;
        console.log(`   🌐 "${loc.name}" → ${lat}, ${lng}`);
      } else {
        console.warn(`   ⚠️  Geocode failed: "${loc.name}" (query: "${query}")`);
        failed++;
        continue;
      }
    }

    locations.push({
      id: loc.id,
      name: loc.name,
      lat,
      lng,
      address: loc.address || query.replace(', Paris, France', ''),
      type: loc.type,
      tags: loc.tags,
      summary: loc.summary,
      time_period: loc.time_period,
      source_link: loc.source_link,
      notion_url: loc.notion_url
    });
  }

  saveCache(cache);

  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(path.join(DATA_DIR, 'locations.json'), JSON.stringify(locations, null, 2));

  fs.writeFileSync(path.join(DATA_DIR, 'meta.json'), JSON.stringify({
    last_sync: new Date().toISOString(),
    total_pages: pages.length,
    on_map: locations.length,
    cache_hits: cacheHits,
    freshly_geocoded: geocodedNew,
    failed
  }, null, 2));

  console.log(`\n✅ Done!`);
  console.log(`   📍 ${locations.length}/${parsed.length} on map`);
  console.log(`   💾 ${cacheHits} cached, 🌐 ${geocodedNew} geocoded`);
  if (failed > 0) {
    console.log(`   ❌ ${failed} failed — fill Address field in Notion for these`);
  }
}

main().catch(err => {
  console.error('\n❌ Failed:', err.message);
  process.exit(1);
});
