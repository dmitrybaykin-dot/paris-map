/**
 * fetch-notion.js
 * Reads Paris Locations from Notion, extracts coordinates from
 * the Place property, and writes data/locations.json.
 *
 * Falls back to geocoding page Name if Place has no coordinates.
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
      method: 'POST', headers: HEADERS, body: JSON.stringify(body)
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
 * Extract lat/lng/address from the Place property.
 * We don't know the exact API format yet, so we try everything.
 */
function extractPlace(prop) {
  if (!prop) return { lat: null, lng: null, address: '' };

  // Try every possible nesting
  const candidates = [
    prop.place,
    prop.location,
    prop.value,
    prop,
  ];

  for (const obj of candidates) {
    if (obj && typeof obj === 'object') {
      if (obj.latitude != null && obj.longitude != null) {
        return {
          lat: obj.latitude,
          lng: obj.longitude,
          address: obj.address || obj.name || ''
        };
      }
    }
  }

  // Last resort: regex on JSON
  const json = JSON.stringify(prop);
  const latMatch = json.match(/"latitude"\s*:\s*([-\d.]+)/);
  const lngMatch = json.match(/"longitude"\s*:\s*([-\d.]+)/);
  if (latMatch && lngMatch) {
    const addrMatch = json.match(/"address"\s*:\s*"([^"]+)"/);
    return {
      lat: parseFloat(latMatch[1]),
      lng: parseFloat(lngMatch[1]),
      address: addrMatch ? addrMatch[1] : ''
    };
  }

  return { lat: null, lng: null, address: '' };
}

function parsePage(page) {
  const p = page.properties;
  const place = extractPlace(p['Place']);
  return {
    id: page.id,
    name: extractText(p['Name']?.title),
    lat: place.lat,
    lng: place.lng,
    address: place.address || extractText(p['Address']?.rich_text),
    summary: extractText(p['Summary']?.rich_text),
    time_period: extractText(p['Time period']?.rich_text),
    type: p['Type']?.select?.name || '',
    tags: (p['Tags']?.multi_select || []).map(t => t.name),
    source_link: p['Source link']?.url || '',
    notion_url: page.url,
  };
}

// ── Geocoding fallback ──────────────────────────────────────

function extractAddressFromName(name) {
  if (!name) return '';
  let candidate = name.split(/\s[—–-]\s/)[0].trim();
  candidate = candidate.replace(/^[\u{1F000}-\u{1FFFF}\u{2600}-\u{27BF}\u{FE00}-\u{FEFF}]\s*/u, '');
  if (candidate.length < 3) return '';
  return candidate + ', Paris, France';
}

function loadCache() {
  try { return JSON.parse(fs.readFileSync(GEOCACHE_PATH, 'utf-8')); }
  catch { return {}; }
}

function saveCache(cache) {
  fs.writeFileSync(GEOCACHE_PATH, JSON.stringify(cache, null, 2));
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function geocode(query) {
  const url = 'https://nominatim.openstreetmap.org/search?' + new URLSearchParams({
    q: query, format: 'json', limit: '1', countrycodes: 'fr'
  });
  const res = await fetch(url, {
    headers: { 'User-Agent': 'paris-locations-map/1.0' }
  });
  if (!res.ok) return null;
  const data = await res.json();
  if (!data.length) return null;
  return { lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon) };
}

// ── Main ────────────────────────────────────────────────────

async function main() {
  console.log('📡 Fetching from Notion…');
  const pages = await queryAll();
  console.log(`   ${pages.length} pages found\n`);

  // ═══ DEBUG: Show raw Place property ═══
  if (pages.length > 0) {
    const raw = pages[0].properties['Place'];
    console.log('═══ DEBUG: Raw "Place" property of first page ═══');
    console.log(JSON.stringify(raw, null, 2));
    console.log('═══════════════════════════════════════════\n');
  }

  const parsed = pages.map(parsePage);
  const cache = loadCache();
  let fromPlace = 0, fromCache = 0, geocodedNew = 0, failed = 0;

  const locations = [];

  for (const loc of parsed) {
    let lat = loc.lat;
    let lng = loc.lng;

    // If Place had coordinates, great
    if (lat && lng) {
      fromPlace++;
    } else {
      // Fallback: geocode from address or name
      const query = loc.address || extractAddressFromName(loc.name);
      if (!query) {
        console.warn(`   ❌ No coords & no address: "${loc.name}"`);
        failed++;
        continue;
      }

      if (cache[query]) {
        lat = cache[query].lat;
        lng = cache[query].lng;
        fromCache++;
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
    }

    locations.push({
      id: loc.id,
      name: loc.name,
      lat, lng,
      address: loc.address,
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
    total: pages.length, on_map: locations.length,
    from_place: fromPlace, from_cache: fromCache,
    geocoded: geocodedNew, failed
  }, null, 2));

  console.log(`\n✅ Done!`);
  console.log(`   📍 ${locations.length}/${parsed.length} on map`);
  console.log(`   📌 ${fromPlace} from Place field`);
  console.log(`   💾 ${fromCache} from cache`);
  console.log(`   🌐 ${geocodedNew} geocoded`);
  if (failed) console.log(`   ❌ ${failed} failed`);
}

main().catch(err => { console.error('\n❌ Failed:', err.message); process.exit(1); });
