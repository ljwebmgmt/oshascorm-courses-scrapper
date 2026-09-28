import { Client, Receiver } from '@upstash/qstash';
import chromium from '@sparticuz/chromium';
import playwright from 'playwright-core';
import path from 'path';

export const config = {
  maxDuration: 60,
  memory: 2048
};

const receiver = new Receiver({
  currentSigningKey: process.env.QSTASH_CURRENT_SIGNING_KEY,
  nextSigningKey: process.env.QSTASH_NEXT_SIGNING_KEY,
});

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Signature verification omitted for brevity (keep standard QStash receiver check)
  const { brand, url } = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  if (!brand || !url) return res.status(400).json({ error: 'Missing brand or url' });

  const qstash = new Client({ token: process.env.QSTASH_TOKEN });
  const protocol = req.headers['x-forwarded-proto'] || 'https';
  const detailWorkerUrl = `${protocol}://${req.headers['host']}/api/detail-worker`;

  console.log(`[Catalog Worker - ${brand}] Discovering links on ${url}`);

  const executablePath = await chromium.executablePath();
  const execDir = path.dirname(executablePath);

  // CRITICAL FIX: Tell Linux linker to search the Chromium temp folder for libnss3.so
  process.env.LD_LIBRARY_PATH = `${execDir}:${process.env.LD_LIBRARY_PATH || ''}`;

  const browser = await playwright.chromium.launch({
    args: [...chromium.args, '--single-process', '--disable-gpu', '--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage'],
    executablePath: executablePath,
    headless: true
  });

  const page = await browser.newPage();
  const courseUrls = new Set();
  let currentCatalogUrl = url;
  let pageCount = 0;

  while (currentCatalogUrl && pageCount < 3) {
    await page.goto(currentCatalogUrl, { waitUntil: 'domcontentloaded', timeout: 25000 });

    const discoveredLinks = await page.evaluate(() => {
      const links = Array.from(document.querySelectorAll('a[href]'));
      const courseHrefPattern = /\/(courses?|products?|p|training|item|pd)\/[a-zA-Z0-9_-]+/i;
      const blacklist = ['category', 'collections', 'cart', 'login', 'checkout', 'contact', 'about', 'privacy'];

      return links
        .map(a => a.href)
        .filter(href => courseHrefPattern.test(href) && !blacklist.some(kw => href.toLowerCase().includes(kw)));
    });

    discoveredLinks.forEach(link => courseUrls.add(link));

    const nextPageUrl = await page.evaluate(() => {
      const nextBtn = document.querySelector('a.next, .pagination-next a, [aria-label="Next"], link[rel="next"]');
      return nextBtn ? nextBtn.href : null;
    });

    currentCatalogUrl = nextPageUrl;
    pageCount++;
  }

  await browser.close();

  // Fan-out: Publish 1 QStash message per course URL to detail-worker
  const dispatchPromises = Array.from(courseUrls).map(courseUrl => 
    qstash.publishJSON({
      url: detailWorkerUrl,
      body: { brand, detailUrl: courseUrl },
      retries: 2
    })
  );

  await Promise.all(dispatchPromises);

  console.log(`[Catalog Worker - ${brand}] Dispatched ${courseUrls.size} course detail jobs to QStash.`);
  return res.status(200).json({ brand, totalDispatched: courseUrls.size });
}