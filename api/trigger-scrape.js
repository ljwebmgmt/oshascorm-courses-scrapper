import { Client } from '@upstash/qstash';

export default async function handler(req, res) {
  if (req.method !== 'POST' && req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const qstash = new Client({ 
      token: process.env.QSTASH_TOKEN, 
      baseUrl: 'https://qstash-us-east-1.upstash.io' 
    });
    
    const competitorUrls = JSON.parse(process.env.COMPETITOR_URLS || '{}');

    const protocol = req.headers['x-forwarded-proto'] || 'https';
    const host = req.headers['host'];
    const catalogWorkerUrl = `${protocol}://${host}/api/scrape-worker`;

    // 1. Generate ONE global jobId for this entire multi-brand scraping session
    const globalJobId = `run_all_brands_${Date.now()}`;

    const dispatchPromises = [];

    for (const [brand, targetUrl] of Object.entries(competitorUrls)) {
      console.log(`[QStash Dispatcher] Publishing catalog job for ${brand} with globalJobId: ${globalJobId}`);
      
      const promise = qstash.publishJSON({
        url: catalogWorkerUrl,
        body: {
          brand: brand,
          catalogUrl: targetUrl,
          jobId: globalJobId // Pass the same jobId across all brands
        },
        retries: 2,
      });

      dispatchPromises.push(promise);
    }

    const results = await Promise.all(dispatchPromises);

    return res.status(200).json({
      success: true,
      jobId: globalJobId,
      message: `Successfully dispatched ${results.length} catalog scraping jobs to QStash.`,
      dispatchedBrands: Object.keys(competitorUrls)
    });

  } catch (error) {
    console.error('[Trigger Scrape Error]:', error);
    return res.status(500).json({ error: error.message });
  }
}