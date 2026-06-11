const fs = require('node:fs/promises');
const path = require('node:path');

const OUT_PATH = path.join(process.cwd(), 'data', 'news.json');

const FEEDS = {
  innlent: {
    label: 'mbl.is - Innlent',
    url: 'https://www.mbl.is/feeds/innlent/'
  },
  sport: {
    label: 'mbl.is - Ithrottir',
    url: 'https://www.mbl.is/feeds/sport/'
  },
  erlent: {
    label: 'Visir - Frettir',
    url: 'https://www.visir.is/rss/frettir'
  }
};

const ENTITY_MAP = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' '
};

function decodeEntities(value) {
  return String(value || '').replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, entity) => {
    if (entity[0] === '#') {
      const isHex = entity[1]?.toLowerCase() === 'x';
      const code = Number.parseInt(entity.slice(isHex ? 2 : 1), isHex ? 16 : 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }

    return ENTITY_MAP[entity] || match;
  });
}

function cleanText(value) {
  return decodeEntities(value)
    .replace(/<!\[CDATA\[/g, '')
    .replace(/\]\]>/g, '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/[\u00ad\u200b]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function getTag(block, tagName) {
  const match = block.match(new RegExp(`<${tagName}[^>]*>([\\s\\S]*?)<\\/${tagName}>`, 'i'));
  return match ? cleanText(match[1]) : '';
}

function formatDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';

  return new Intl.DateTimeFormat('is-IS', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'Atlantic/Reykjavik'
  }).format(date);
}

function trimDescription(value) {
  const text = cleanText(value);
  if (text.length <= 360) return text;

  const short = text.slice(0, 360);
  const lastSpace = short.lastIndexOf(' ');
  return `${short.slice(0, lastSpace > 240 ? lastSpace : 360).trim()}...`;
}

function parseRss(xml) {
  const itemMatches = [...xml.matchAll(/<item\b[\s\S]*?<\/item>/gi)];

  return itemMatches
    .map(([item]) => {
      const title = getTag(item, 'title');
      const description = getTag(item, 'description') || getTag(item, 'content:encoded');
      const pubDateRaw = getTag(item, 'pubDate');

      return {
        title,
        desc: trimDescription(description),
        pubDate: formatDate(pubDateRaw),
        link: getTag(item, 'link')
      };
    })
    .filter(item => item.title && item.desc)
    .slice(0, 8);
}

async function readExistingNews() {
  try {
    const raw = await fs.readFile(OUT_PATH, 'utf8');
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

async function fetchFeed(key, config, existing) {
  try {
    const response = await fetch(config.url, {
      headers: {
        'user-agent': 'islenska-leikur-news-fetcher/1.0'
      }
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const xml = await response.text();
    const items = parseRss(xml);

    if (!items.length) {
      throw new Error('No usable RSS items found');
    }

    return {
      label: config.label,
      items,
      ok: true
    };
  } catch (error) {
    console.warn(`Could not update ${key}: ${error.message}`);

    if (existing[key]?.items?.length) {
      return {
        ...existing[key],
        label: config.label,
        ok: true,
        stale: true,
        error: error.message
      };
    }

    return {
      label: config.label,
      items: [],
      ok: false,
      error: error.message
    };
  }
}

async function main() {
  const existing = await readExistingNews();
  const next = {};

  for (const [key, config] of Object.entries(FEEDS)) {
    next[key] = await fetchFeed(key, config, existing);
  }

  next.updated = new Date().toISOString();

  await fs.mkdir(path.dirname(OUT_PATH), { recursive: true });
  await fs.writeFile(OUT_PATH, `${JSON.stringify(next, null, 2)}\n`, 'utf8');

  const count = Object.values(next)
    .filter(feed => feed && Array.isArray(feed.items))
    .reduce((sum, feed) => sum + feed.items.length, 0);

  console.log(`Wrote ${count} news items to ${OUT_PATH}`);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
