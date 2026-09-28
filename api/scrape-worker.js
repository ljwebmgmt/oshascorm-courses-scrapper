import { Receiver } from '@upstash/qstash';
import { list, put } from '@vercel/blob';
import chromium from '@sparticuz/chromium';
import playwright from 'playwright-core';
import ExcelJS from 'exceljs';
import Fuse from 'fuse.js';

export const config = {
  maxDuration: 300, // 5 minutes per single competitor run (Vercel Pro)
  memory: 3008
};

const receiver = new Receiver({
  currentSigningKey: process.env.QSTASH_CURRENT_SIGNING_KEY,
  nextSigningKey: process.env.QSTASH_NEXT_SIGNING_KEY,
});

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // 1. Verify QStash Request Signature
  try {
    const signature = req.headers['upstash-signature'];
    const rawBody = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
    
    if (process.env.NODE_ENV === 'production') {
      const isValid = await receiver.verify({ signature, body: rawBody });
      if (!isValid) return res.status(401).json({ error: 'Invalid QStash signature' });
    }
  } catch (err) {
    return res.status(401).json({ error: 'Unauthorized QStash request' });
  }

  const { brand, url } = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  if (!brand || !url) return res.status(400).json({ error: 'Missing brand or url in payload' });

  console.log(`[Worker Started] Brand: ${brand} | Catalog URL: ${url}`);

  try {
    const blobPath = process.env.EXCEL_BLOB_PATH || 'ICTrainingUS_reviewed_with_course_highlights.xlsx';

    // 2. Fetch Master Excel Workbook from Vercel Blob Storage
    const blobList = await list({ prefix: blobPath });
    if (!blobList.blobs.length) return res.status(404).json({ error: `Blob file not found: ${blobPath}` });

    const blobResponse = await fetch(blobList.blobs[0].url);
    const arrayBuffer = await blobResponse.arrayBuffer();

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(arrayBuffer);
    const masterSheet = workbook.getWorksheet('Master Catalog') || workbook.worksheets[0];

    // Read existing course titles for deduplication
    const existingCourseNames = [];
    masterSheet.eachRow((row, rowNumber) => {
      if (rowNumber > 1) {
        const title = row.getCell(3).value; // Column C: Course Name
        if (title) existingCourseNames.push(String(title).trim().toLowerCase());
      }
    });

    const fuse = new Fuse(existingCourseNames, { threshold: 0.2 });

    // 3. Launch Serverless Headless Chromium
    const executablePath = await chromium.executablePath();
    const browser = await playwright.chromium.launch({
      args: chromium.args,
      executablePath,
      headless: chromium.headless
    });

    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    });

    const page = await context.newPage();

    // =========================================================================
    // PASS 1: Link Discovery (Catalog & Pagination Crawling)
    // =========================================================================
    const courseUrls = new Set();
    let currentCatalogUrl = url;
    let pageCount = 0;
    const maxPagesToCrawl = 5;

    while (currentCatalogUrl && pageCount < maxPagesToCrawl) {
      console.log(`[Pass 1 - ${brand}] Crawling Index Page ${pageCount + 1}: ${currentCatalogUrl}`);
      await page.goto(currentCatalogUrl, { waitUntil: 'networkidle', timeout: 35000 });

      // Extract matching course detail page links
      const discoveredLinks = await page.evaluate(() => {
        const links = Array.from(document.querySelectorAll('a[href]'));
        const courseHrefPattern = /\/(courses?|products?|p|training|item|pd)\/[a-zA-Z0-9_-]+/i;
        const blacklistKeywords = ['category', 'collections', 'cart', 'login', 'checkout', 'contact', 'about', 'privacy'];

        return links
          .map(a => a.href)
          .filter(href => {
            const isCourseLink = courseHrefPattern.test(href);
            const isNotBlacklisted = !blacklistKeywords.some(kw => href.toLowerCase().includes(kw));
            return isCourseLink && isNotBlacklisted;
          });
      });

      discoveredLinks.forEach(link => courseUrls.add(link));

      // Find next pagination page link
      const nextPageUrl = await page.evaluate(() => {
        const nextBtn = document.querySelector('a.next, .pagination-next a, [aria-label="Next"], link[rel="next"]');
        return nextBtn ? nextBtn.href : null;
      });

      currentCatalogUrl = nextPageUrl;
      pageCount++;
    }

    console.log(`[Pass 1 Complete] Found ${courseUrls.size} course detail pages for ${brand}`);

    // =========================================================================
    // PASS 2: Detail Page Extraction (Extracts Title, Price, CFR Citation, Image)
    // =========================================================================
    const addedCourses = [];

    for (const detailUrl of Array.from(courseUrls)) {
      try {
        await page.goto(detailUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });

        const courseData = await page.evaluate((brandName) => {
          // Title
          const h1 = document.querySelector('h1');
          const title = h1 ? h1.textContent.trim() : '';
          if (!title) return null;

          // Price
          const priceEl = document.querySelector('.price, .course-price, [data-price], .product-price, .amount');
          const rawPrice = priceEl ? priceEl.textContent : '0.00';

          // Duration
          const durationEl = document.querySelector('.duration, .hours, .course-length, [data-duration]');
          const duration = durationEl ? durationEl.textContent.trim() : '2 Hours';

          // CFR Citation Search
          const bodyText = document.body.innerText || '';
          const cfrMatch = bodyText.match(/\b(29\s*CFR\s*[\d\.]+[\/\d]*|49\s*CFR\s*[\d\.]+)\b/i);
          const citation = cfrMatch ? cfrMatch[0] : '';

          // Course Hero / OG Image Extraction
          const ogImg = document.querySelector('meta[property="og:image"]');
          const mainImg = document.querySelector('.course-hero img, .product-single__photo img, .main-image img');
          const imageUrl = ogImg ? ogImg.content : (mainImg ? mainImg.src : '');

          // Highlights
          const bulletEls = Array.from(document.querySelectorAll('.course-highlights li, .features li, .description li, #overview li')).slice(0, 5);
          let highlights = bulletEls.map(li => `• ${li.textContent.trim()}`).join('\n');
          if (!highlights) {
            highlights = `• Flexible, self-paced online training\n• Instant certificate of completion\n• Sourced from ${brandName}`;
          }

          return {
            title,
            rawPrice,
            duration,
            citation,
            imageUrl,
            highlights
          };
        }, brand);

        if (!courseData || !courseData.title) continue;

        const cleanTitle = courseData.title.trim();
        const normalizedTitle = cleanTitle.toLowerCase();

        // Exact & Fuzzy Match Deduplication
        const isExactMatch = existingCourseNames.includes(normalizedTitle);
        const isFuzzyMatch = fuse.search(normalizedTitle).length > 0;

        if (!isExactMatch && !isFuzzyMatch) {
          const priceNum = parseFloat(courseData.rawPrice.replace(/[^0-9.]/g, '')) || 29.99;
          
          let regBody = 'OSHA';
          if (cleanTitle.includes('DOT') || courseData.citation.includes('49 CFR')) regBody = 'DOT';
          else if (cleanTitle.includes('EPA')) regBody = 'EPA';
          else if (cleanTitle.includes('Cal/OSHA')) regBody = 'Cal/OSHA';

          // Append to 12-column Master Sheet
          masterSheet.addRow([
            'General Safety',                    // Column A: Category
            cleanTitle,                          // Column B: Course Family
            cleanTitle,                          // Column C: Course Name
            courseData.highlights,               // Column D: Course Highlights
            'Core Course',                       // Column E: Course Type
            regBody,                             // Column F: Regulatory Body
            courseData.citation,                 // Column G: Governing Regulation
            'General Industry, Workforce Safety',// Column H: Primary Industries
            courseData.duration,                 // Column I: Suggested Duration
            priceNum,                            // Column J: Est. MSRP (USD)
            'Bundle-Eligible',                   // Column K: Bundle Class
            'General Safety Bundle'              // Column L: Industry Bundle Tags
          ]);

          existingCourseNames.push(normalizedTitle);
          addedCourses.push(cleanTitle);
        }
      } catch (err) {
        console.error(`[Detail Scrape Error] ${detailUrl}:`, err.message);
      }
    }

    await browser.close();

    // 4. Save updated Master Excel file back to Vercel Blob Storage
    if (addedCourses.length > 0) {
      const updatedBuffer = await workbook.xlsx.writeBuffer();
      const updatedBlob = await put(blobPath, updatedBuffer, {
        access: 'public',
        addRandomSuffix: false
      });

      console.log(`[Worker Complete - ${brand}] Added ${addedCourses.length} new unique courses to Blob.`);
      return res.status(200).json({
        success: true,
        brand,
        addedCount: addedCourses.length,
        blobUrl: updatedBlob.url
      });
    }

    console.log(`[Worker Complete - ${brand}] No new unique courses found.`);
    return res.status(200).json({
      success: true,
      brand,
      addedCount: 0,
      message: 'No new unique courses found.'
    });

  } catch (error) {
    console.error(`[Worker Exception - ${brand}]:`, error);
    return res.status(500).json({ brand, error: error.message });
  }
}