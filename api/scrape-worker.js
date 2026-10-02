import { Redis } from '@upstash/redis';
import { Client } from '@upstash/qstash';
import * as cheerio from 'cheerio';

const redis = Redis.fromEnv();
const qstash = new Client({
  token: process.env.QSTASH_TOKEN,
  baseUrl: 'https://qstash-us-east-1.upstash.io'
});

export const config = {
  maxDuration: 60,
  memory: 1024
};

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  let payload = req.body;
  if (typeof payload === 'string') payload = JSON.parse(payload);

  const { brand, catalogUrl, jobId } = payload || {};
  if (!catalogUrl || !brand || !jobId) {
    return res.status(400).json({ error: 'Missing brand, catalogUrl, or jobId' });
  }

  console.log(`[Catalog Worker - ${brand}] Scraping URLs from: ${catalogUrl}`);

  try {
    const response = await fetch(catalogUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
      }
    });

    if (!response.ok) {
      return res.status(500).json({ error: `Catalog fetch failed with HTTP ${response.status}` });
    }

    const html = await response.text();
    const $ = cheerio.load(html);

    const discoveredUrls = new Set();
    $('a[href*="/course/"], a[href*="/courses/"]').each(function() {
      let href = $(this).attr('href');
      if (href) {
        if (href.startsWith('/')) {
          const origin = new URL(catalogUrl).origin;
          href = origin + href;
        }
        if (href.startsWith('http')) {
          discoveredUrls.add(href.split('#')[0]);
        }
      }
    });

    const courseUrls = Array.from(discoveredUrls);
    if (courseUrls.length === 0) {
      return res.status(200).json({ message: `No course URLs discovered for ${brand}.` });
    }

    const protocol = req.headers['x-forwarded-proto'] || 'https';
    const detailWorkerUrl = `${protocol}://${req.headers['host']}/api/detail-worker`;

    // Atomically ADD this brand's discovered course count to the global counter
    await redis.incrby(`total_count:${jobId}`, courseUrls.length);

    // Dispatch detail tasks for this brand
    const dispatchPromises = courseUrls.map(courseUrl => 
      qstash.publishJSON({
        url: detailWorkerUrl,
        body: { brand, detailUrl: courseUrl, jobId },
        retries: 2
      })
    );

    await Promise.all(dispatchPromises);

    console.log(`[Catalog Worker - ${brand}] Added ${courseUrls.length} courses to global job: ${jobId}`);
    return res.status(200).json({ success: true, brand, jobId, dispatched: courseUrls.length });

  } catch (err) {
    console.error(`[Catalog Worker Exception - ${brand}]: ${err.message}`);
    return res.status(500).json({ error: err.message });
  }
}