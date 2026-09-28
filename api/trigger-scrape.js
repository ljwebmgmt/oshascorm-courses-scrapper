import { Client } from '@upstash/qstash';

export default async function handler(req, res) {
  if (req.method !== 'POST' && req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const qstash = new Client({ token: process.env.QSTASH_TOKEN });
    const competitorUrls = JSON.parse(process.env.COMPETITOR_URLS || '{}');

    const protocol = req.headers['x-forwarded-proto'] || 'https';
    const host = req.headers['host'];
    const workerUrl = `${protocol}://${host}/api/scrape-worker`;

    const dispatchPromises = [];

    for (const [brand, targetUrl] of Object.entries(competitorUrls)) {
      console.log(`[QStash Dispatcher] Publishing scraping job for ${brand}`);
      
      const promise = qstash.publishJSON({
        url: workerUrl,
        body: {
          brand: brand,
          url: targetUrl
        },
        retries: 2,
      });

      dispatchPromises.push(promise);
    }

    const results = await Promise.all(dispatchPromises);

    return res.status(200).json({
      success: true,
      message: `Successfully dispatched ${results.length} scraping jobs to QStash.`,
      dispatchedBrands: Object.keys(competitorUrls)
    });

  } catch (error) {
    console.error('[Trigger Scrape Error]:', error);
    return res.status(500).json({ error: error.message });
  }
}