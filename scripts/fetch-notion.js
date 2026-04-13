/**
 * fetch-notion.js
 * Pulls all pages from the Paris Locations Notion database
 * and writes data/locations.json for the map.
 *
 * Usage:
 *   NOTION_API_KEY=secret_xxx node scripts/fetch-notion.js
 *
 * Environment variables:
 *   NOTION_API_KEY  — Notion integration token (required)
 *   DATABASE_ID     — Notion database ID (default: your Paris Locations DB)
 */

const NOTION_API_KEY = process.env.NOTION_API_KEY;
const DATABASE_ID = process.env.DATABASE_ID || 'c2dc61fb15b64b348ec0f395cce32dfb';

if (!NOTION_API_KEY) {
  console.error('❌ NOTION_API_KEY is required');
  process.exit(1);
}

const NOTION_API = 'https://api.notion.com/v1';
const HEADERS = {
  'Authorization': `Bearer ${NOTION_API_KEY}`,
  'Notion-Version': '2022-06-28',  // Update if Notion adds newer features
  'Content-Type': 'application/json'
};

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
      throw new Error(`Notion API error ${res.status}: ${err}`);
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
  const props = page.properties;

  // Extract place data — handle multiple Notion API formats
  let lat = null, lng = null, address = '';
  const place = props['Place'];

  if (place) {
    // Format 1: location type (newer Notion API)
    if (place.type === 'location' && place.location) {
      lat = place.location.latitude;
      lng = place.location.longitude;
      address = place.location.address || '';
    }
    // Format 2: place type (Notion's place property)
    else if (place.type === 'place' && place.place) {
      lat = place.place.latitude;
      lng = place.place.longitude;
      address = place.place.address || place.place.name || '';
    }
    // Format 3: check nested structures
    else if (place.latitude !== undefined) {
      lat = place.latitude;
      lng = place.longitude;
      address = place.address || '';
    }
  }

  // Extract other fields
  const name = extractText(props['Name']?.title);
  const summary = extractText(props['Summary']?.rich_text);
  const timePeriod = extractText(props['Time period']?.rich_text);
  const type = props['Type']?.select?.name || '';
  const tags = (props['Tags']?.multi_select || []).map(t => t.name);
  const sourceLink = props['Source link']?.url || '';

  return {
    id: page.id,
    name,
    lat,
    lng,
    address,
    type,
    tags,
    summary,
    time_period: timePeriod,
    source_link: sourceLink,
    notion_url: page.url
  };
}

async function main() {
  console.log('📡 Fetching from Notion…');
  const pages = await queryAll();
  console.log(`   Found ${pages.length} pages`);

  const locations = pages
    .map(parsePage)
    .filter(loc => loc.lat && loc.lng);

  // Log pages that are missing coordinates for debugging
  const missing = pages.map(parsePage).filter(loc => !loc.lat || !loc.lng);
  if (missing.length > 0) {
    console.log(`   ⚠️  ${missing.length} pages have no coordinates:`);
    missing.slice(0, 5).forEach(m => console.log(`      - ${m.name}`));
    if (missing.length > 5) console.log(`      … and ${missing.length - 5} more`);

    // Debug: show raw Place property of first page for troubleshooting
    const firstRaw = pages[0]?.properties?.['Place'];
    if (firstRaw) {
      console.log(`\n   🔍 Debug — raw Place property format:`);
      console.log(`      type: "${firstRaw.type}"`);
      console.log(`      keys: ${JSON.stringify(Object.keys(firstRaw))}`);
      console.log(`      value: ${JSON.stringify(firstRaw).slice(0, 300)}`);
    }
  }

  console.log(`   ${locations.length} locations with coordinates`);

  // Write JSON
  const fs = require('fs');
  const path = require('path');
  const outDir = path.join(__dirname, '..', 'data');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  const outPath = path.join(outDir, 'locations.json');
  fs.writeFileSync(outPath, JSON.stringify(locations, null, 2));
  console.log(`✅ Written to ${outPath}`);

  // Also write a meta file with sync timestamp
  const meta = {
    last_sync: new Date().toISOString(),
    total_pages: pages.length,
    locations_with_coords: locations.length
  };
  fs.writeFileSync(path.join(outDir, 'meta.json'), JSON.stringify(meta, null, 2));
  console.log(`✅ Meta written`);
}

main().catch(err => {
  console.error('❌ Failed:', err.message);
  process.exit(1);
});
