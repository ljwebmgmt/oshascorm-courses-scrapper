import { list, put } from '@vercel/blob';
import * as cheerio from 'cheerio';
import ExcelJS from 'exceljs';
import Fuse from 'fuse.js';

export const config = {
  maxDuration: 60,
  memory: 1024
};

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { brand, detailUrl } = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  if (!detailUrl) return res.status(400).json({ error: 'Missing detailUrl' });

  console.log(`[Detail Worker - ${brand}] Fetching via Fast HTTP: ${detailUrl}`);

  try {
    // 1. HTTP GET with Realistic Browser Headers (Bypasses Cloudflare / WAF Handshake Checks)
    const response = await fetch(detailUrl, {
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Cache-Control': 'no-cache',
        'Sec-Ch-Ua': '"Chromium";v="122", "Not(A:Brand";v="24", "Google Chrome";v="122"',
        'Sec-Ch-Ua-Mobile': '?0',
        'Sec-Ch-Ua-Platform': '"Windows"',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'none',
        'Sec-Fetch-User': '?1',
        'Upgrade-Insecure-Requests': '1'
      }
    });

    if (!response.ok) {
      console.warn(`[HTTP ${response.status}] Access restricted or page missing for ${detailUrl}`);
      return res.status(200).json({ skipped: true, status: response.status });
    }

    const html = await response.text();
    const $ = cheerio.load(html);

    // 2. Multi-Selector Title & OpenGraph Extraction
    const title = 
      $('h1').first().text().trim() \vert{}\vert{}$('meta[property="og:title"]').attr('content') || 
      $('title').text().split('|')[0].trim();

    if (!title) {
      console.warn(`[Detail Worker] Could not parse title from ${detailUrl}`);
      return res.status(200).json({ skipped: true, reason: 'No title parsed' });
    }

    // Price extraction across platforms
    const rawPrice = 
      $('.price, .course-price, [data-price], .product-price, .amount, .cost').first().text().trim() || 
      '29.99';

    // Duration extraction
    const duration = 
      $('.duration, .hours, .course-length, [data-duration], .time-estimate').first().text().trim() || 
      '2 Hours';

    // CFR Citation extraction from raw HTML body
    const pageText = $('body').text();
    const cfrMatch = pageText.match(/\b(29\s*CFR\s*[\d\.]+[\/\d]*|49\s*CFR\s*[\d\.]+)\b/i);
    const citation = cfrMatch ? cfrMatch[0] : '';

    // Extract Hero / OG Image URL
    let imageUrl = 
      $('meta[property="og:image"]').attr('content') || 
      $('.course-hero img, .product-single__photo img, .main-image img, hero-section img').first().attr('src') || 
      '';

    // Ensure relative URLs are formatted to absolute URLs
    if (imageUrl && imageUrl.startsWith('/')) {
      const urlObj = new URL(detailUrl);
      imageUrl = `${urlObj.origin}${imageUrl}`;
    }

    // Highlighting / Feature Bullets
    const bullets = [];
    $('.course-highlights li, .features li, .description li, ul.benefits li').slice(0, 5).each((_, el) => {
      const text = $(el).text().trim();
      if (text && text.length < 200) bullets.push(`• ${text}`);
    });

    const highlights = bullets.length > 0 
      ? bullets.join('\n') 
      : `• Flexible, self-paced online training\n• Instant certificate of completion\n• Sourced from ${brand}`;

    const courseData = { title, rawPrice, duration, citation, imageUrl, highlights };

    // 3. Blob Workbook & Deduplication Strategy
    const blobPath = process.env.EXCEL_BLOB_PATH || 'ICTrainingUS_reviewed_with_course_highlights.xlsx';
    const blobList = await list({ prefix: blobPath });

    if (!blobList.blobs.length) return res.status(404).json({ error: 'Master Excel Blob not found' });

    const blobResponse = await fetch(blobList.blobs[0].url);
    const arrayBuffer = await blobResponse.arrayBuffer();

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(arrayBuffer);
    const masterSheet = workbook.getWorksheet('Master Catalog') || workbook.worksheets[0];

    const existingNames = [];
    masterSheet.eachRow((row, rowNum) => {
      if (rowNum > 1 && row.getCell(3).value) {
        existingNames.push(String(row.getCell(3).value).trim().toLowerCase());
      }
    });

    const normTitle = courseData.title.trim().toLowerCase();
    const fuse = new Fuse(existingNames, { threshold: 0.2 });

    if (existingNames.includes(normTitle) || fuse.search(normTitle).length > 0) {
      console.log(`[Detail Worker - ${brand}] Duplicate skipped: "${courseData.title}"`);
      return res.status(200).json({ skipped: true, reason: 'Duplicate course' });
    }

    // 4. Append to Excel Row
    const priceNum = parseFloat(courseData.rawPrice.replace(/[^0-9.]/g, '')) || 29.99;
    let regBody = 'OSHA';
    if (courseData.title.includes('DOT') || courseData.citation.includes('49 CFR')) regBody = 'DOT';
    else if (courseData.title.includes('EPA')) regBody = 'EPA';

    masterSheet.addRow([
      'General Safety',
      courseData.title,
      courseData.title,
      courseData.highlights,
      'Core Course',
      regBody,
      courseData.citation,
      'General Industry, Workforce Safety',
      courseData.duration,
      priceNum,
      'Bundle-Eligible',
      'General Safety Bundle'
    ]);

    // 5. Update Excel File in Vercel Blob
    const updatedBuffer = await workbook.xlsx.writeBuffer();
    await put(blobPath, updatedBuffer, { access: 'public', addRandomSuffix: false });

    console.log(`[Detail Worker - ${brand}] Successfully ingested: "${courseData.title}"`);
    return res.status(200).json({ success: true, added: courseData.title });

  } catch (err) {
    console.error(`[Detail Worker Exception - ${brand}]: ${err.message}`);
    return res.status(500).json({ error: err.message });
  }
}