import { list, put } from '@vercel/blob';
import chromium from '@sparticuz/chromium';
import playwright from 'playwright-core';
import ExcelJS from 'exceljs';
import Fuse from 'fuse.js';

export const config = {
  maxDuration: 60,
  memory: 2048
};

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { brand, detailUrl } = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  if (!detailUrl) return res.status(400).json({ error: 'Missing detailUrl' });

  console.log(`[Detail Worker - ${brand}] Scraping: ${detailUrl}`);

  const browser = await playwright.chromium.launch({
    args: [...chromium.args, '--single-process', '--disable-gpu', '--no-sandbox'],
    executablePath: await chromium.executablePath(),
    headless: chromium.headless
  });

  const page = await browser.newPage();

  try {
    await page.goto(detailUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });

    const courseData = await page.evaluate((brandName) => {
      const h1 = document.querySelector('h1');
      const title = h1 ? h1.textContent.trim() : '';
      if (!title) return null;

      const priceEl = document.querySelector('.price, .course-price, [data-price], .product-price, .amount');
      const rawPrice = priceEl ? priceEl.textContent : '0.00';

      const durationEl = document.querySelector('.duration, .hours, .course-length, [data-duration]');
      const duration = durationEl ? durationEl.textContent.trim() : '2 Hours';

      const bodyText = document.body.innerText || '';
      const cfrMatch = bodyText.match(/\b(29\s*CFR\s*[\d\.]+[\/\d]*|49\s*CFR\s*[\d\.]+)\b/i);
      const citation = cfrMatch ? cfrMatch[0] : '';

      // Extract OG image or hero image
      const ogImg = document.querySelector('meta[property="og:image"]');
      const mainImg = document.querySelector('.course-hero img, .product-single__photo img, .main-image img');
      const imageUrl = ogImg ? ogImg.content : (mainImg ? mainImg.src : '');

      const bulletEls = Array.from(document.querySelectorAll('.course-highlights li, .features li, .description li')).slice(0, 5);
      let highlights = bulletEls.map(li => `• ${li.textContent.trim()}`).join('\n');
      if (!highlights) {
        highlights = `• Flexible, self-paced online training\n• Instant certificate of completion\n• Sourced from ${brandName}`;
      }

      return { title, rawPrice, duration, citation, imageUrl, highlights };
    }, brand);

    await browser.close();

    if (!courseData || !courseData.title) {
      return res.status(200).json({ skipped: true, reason: 'No title extracted' });
    }

    // Load & Deduplicate against Master Excel Sheet in Vercel Blob
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

    // Append new unique course
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

    // Save back to Blob
    const updatedBuffer = await workbook.xlsx.writeBuffer();
    await put(blobPath, updatedBuffer, { access: 'public', addRandomSuffix: false });

    console.log(`[Detail Worker - ${brand}] Added new course: "${courseData.title}"`);
    return res.status(200).json({ success: true, added: courseData.title });

  } catch (err) {
    console.error(`[Detail Worker Exception]:`, err.message);
    if (browser) await browser.close();
    return res.status(500).json({ error: err.message });
  }
}