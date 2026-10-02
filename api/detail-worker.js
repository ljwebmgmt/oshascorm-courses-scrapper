import * as cheerio from 'cheerio';
import { Redis } from '@upstash/redis';
import { Client } from '@upstash/qstash';

const redis = Redis.fromEnv();
const qstash = new Client({
  token: process.env.QSTASH_TOKEN,
  baseUrl: 'https://qstash-us-east-1.upstash.io'
});

export const config = {
  maxDuration: 30,
  memory: 512
};

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  let payload = req.body;
  if (typeof payload === 'string') {
    try {
      payload = JSON.parse(payload);
    } catch (e) {
      return res.status(400).json({ error: 'Invalid JSON payload' });
    }
  }

  const brand = payload && payload.brand ? payload.brand : 'Unknown';
  const detailUrl = payload && payload.detailUrl ? payload.detailUrl : null;
  const jobId = payload && payload.jobId ? payload.jobId : null;

  if (!detailUrl || !jobId) {
    return res.status(400).json({ error: 'Missing detailUrl or jobId' });
  }

  try {
    const response = await fetch(detailUrl, {
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9'
      }
    });

    if (!response.ok) {
      await checkAndTriggerFinalizer(req, jobId);
      return res.status(200).json({ skipped: true, status: response.status });
    }

    const html = await response.text();
    const $ = cheerio.load(html);

    const h1Text = $('h1').first().text().trim();
    const ogTitle = $('meta[property="og:title"]').attr('content');
    const pageTitle = $('title').text().split('|')[0].trim();
    const title = h1Text || ogTitle || pageTitle || '';

    if (!title) {
      await checkAndTriggerFinalizer(req, jobId);
      return res.status(200).json({ skipped: true, reason: 'No title parsed' });
    }

    const rawPrice = $('.price, .course-price, [data-price], .product-price, .amount, .cost').first().text().trim() || '29.99';
    const duration = $('.duration, .hours, .course-length, [data-duration]').first().text().trim() || '2 Hours';

    const pageText = $('body').text();
    const cfrRegex = new RegExp('(29\\s*CFR\\s*[0-9\\.]+[\\/0-9]*|49\\s*CFR\\s*[0-9\\.]+)', 'i');
    const cfrMatch = pageText.match(cfrRegex);
    const citation = cfrMatch ? cfrMatch[0] : '';

    let imageUrl = $('meta[property="og:image"]').attr('content') || '';
    if (imageUrl && imageUrl.startsWith('/')) {
      const urlObj = new URL(detailUrl);
      imageUrl = urlObj.origin + imageUrl;
    }

    const bullets = [];
    $('.course-highlights li, .features li, .description li').slice(0, 5).each(function() {
      const text = $(this).text().trim();
      if (text) {
        bullets.push('- ' + text);
      }
    });

    let highlights = bullets.join('\n');
    if (!highlights) {
      highlights = '- Flexible, self-paced online training\n- Instant certificate of completion\n- Sourced from ' + brand;
    }

    const courseObj = { brand, title, rawPrice, duration, citation, imageUrl, highlights, detailUrl };

    // 1. Store item in Redis List under the global jobId
    await redis.rpush(`temp_scrape:${jobId}`, JSON.stringify(courseObj));

    // 2. Increment completed counter and trigger Finalizer if batch is done
    await checkAndTriggerFinalizer(req, jobId);

    return res.status(200).json({ success: true, parsed: title });

  } catch (err) {
    console.error('[Detail Worker Exception]:', err.message);
    await checkAndTriggerFinalizer(req, jobId);
    return res.status(500).json({ error: err.message });
  }
}

async function checkAndTriggerFinalizer(req, jobId) {
  try {
    const completed = await redis.incr(`completed_count:${jobId}`);
    const totalRaw = await redis.get(`total_count:${jobId}`);
    const total = parseInt(totalRaw, 10) || 0;

    console.log(`[Job ${jobId}] Progress: ${completed}/${total}`);

    if (completed >= total) {
      console.log(`[Job ${jobId}] All tasks completed. Invoking Finalizer Worker.`);
      
      const protocol = req.headers['x-forwarded-proto'] || 'https';
      const host = req.headers['host'];
      const finalizeUrl = `${protocol}://${host}/api/finalize-worker`;

      await qstash.publishJSON({
        url: finalizeUrl,
        body: { jobId }
      });
    }
  } catch (err) {
    console.error('[Completion Check Error]:', err.message);
  }
}