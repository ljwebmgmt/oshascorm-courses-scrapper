import { list, put } from '@vercel/blob';
import * as cheerio from 'cheerio';
import ExcelJS from 'exceljs';
import Fuse from 'fuse.js';

export const config = {
  maxDuration: 60,
  memory: 1024
};

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    let payload = req.body;
    if (typeof payload === 'string') {
      payload = JSON.parse(payload);
    }

    const brand = payload && payload.brand ? payload.brand : 'Unknown';
    const detailUrl = payload && payload.detailUrl ? payload.detailUrl : null;

    if (!detailUrl) {
      return res.status(400).json({ error: 'Missing detailUrl' });
    }

    console.log('[Detail Worker] Fetching course:', detailUrl);

    const response = await fetch(detailUrl, {
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Cache-Control': 'no-cache'
      }
    });

    if (!response.ok) {
      console.warn('[HTTP Error]', response.status, detailUrl);
      return res.status(200).json({ skipped: true, status: response.status });
    }

    const html = await response.text();
    const $ = cheerio.load(html);

    // Extract Title
    const h1Text = $('h1').first().text().trim();
    const ogTitle = $('meta[property="og:title"]').attr('content');
    const pageTitle = $('title').text().split('|')[0].trim();
    const title = h1Text || ogTitle || pageTitle || '';

    if (!title) {
      console.warn('[Detail Worker] Missing title for:', detailUrl);
      return res.status(200).json({ skipped: true, reason: 'No title parsed' });
    }

    // Extract Metadata
    const rawPrice = $('.price, .course-price, [data-price], .product-price, .amount, .cost').first().text().trim() || '29.99';
    const duration = $('.duration, .hours, .course-length, [data-duration], .time-estimate').first().text().trim() || '2 Hours';

    // Citation Search
    const pageText = $('body').text();
    const cfrRegex = new RegExp('(29\\s*CFR\\s*[0-9\\.]+[\\/0-9]*|49\\s*CFR\\s*[0-9\\.]+)', 'i');
    const cfrMatch = pageText.match(cfrRegex);
    const citation = cfrMatch ? cfrMatch[0] : '';

    // Image Extraction
    let imageUrl = $('meta[property="og:image"]').attr('content') || '';
    if (!imageUrl) {
      imageUrl = $('.course-hero img, .product-single__photo img, .main-image img').first().attr('src') || '';
    }

    if (imageUrl && imageUrl.startsWith('/')) {
      const urlObj = new URL(detailUrl);
      imageUrl = urlObj.origin + imageUrl;
    }

    // Highlights Extraction
    const bullets = [];
    $('.course-highlights li, .features li, .description li, ul.benefits li').slice(0, 5).each(function() {
      const text = $(this).text().trim();
      if (text && text.length < 200) {
        bullets.push('- ' + text);
      }
    });

    let highlights = bullets.join('\n');
    if (!highlights) {
      highlights = '- Flexible, self-paced online training\n- Instant certificate of completion\n- Sourced from ' + brand;
    }

    // Load Master Excel from Blob
    const blobPath = process.env.EXCEL_BLOB_PATH || 'ICTrainingUS_reviewed_with_course_highlights.xlsx';
    const blobList = await list({ prefix: blobPath });

    if (!blobList.blobs || blobList.blobs.length === 0) {
      return res.status(404).json({ error: 'Master Excel Blob not found' });
    }

    const blobResponse = await fetch(blobList.blobs[0].url);
    const arrayBuffer = await blobResponse.arrayBuffer();

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(arrayBuffer);
    const masterSheet = workbook.getWorksheet('Master Catalog') || workbook.worksheets[0];

    const existingNames = [];
    masterSheet.eachRow(function(row, rowNum) {
      if (rowNum > 1 && row.getCell(3).value) {
        existingNames.push(String(row.getCell(3).value).trim().toLowerCase());
      }
    });

    const normTitle = title.trim().toLowerCase();
    const fuse = new Fuse(existingNames, { threshold: 0.2 });

    if (existingNames.includes(normTitle) || fuse.search(normTitle).length > 0) {
      console.log('[Duplicate Skipped]:', title);
      return res.status(200).json({ skipped: true, reason: 'Duplicate course' });
    }

    // Append New Row
    const priceNum = parseFloat(rawPrice.replace(/[^0-9.]/g, '')) || 29.99;
    let regBody = 'OSHA';
    if (title.includes('DOT') || citation.includes('49 CFR')) {
      regBody = 'DOT';
    } else if (title.includes('EPA')) {
      regBody = 'EPA';
    }

    masterSheet.addRow([
      'General Safety',
      title,
      title,
      highlights,
      'Core Course',
      regBody,
      citation,
      'General Industry, Workforce Safety',
      duration,
      priceNum,
      'Bundle-Eligible',
      'General Safety Bundle'
    ]);

    // Save Back to Vercel Blob
    const updatedBuffer = await workbook.xlsx.writeBuffer();
    await put(blobPath, updatedBuffer, { access: 'public', addRandomSuffix: false });

    console.log('[Successfully Ingested]:', title);
    return res.status(200).json({ success: true, added: title });

  } catch (err) {
    console.error('[Detail Worker Exception]:', err.message);
    return res.status(500).json({ error: err.message });
  }
}