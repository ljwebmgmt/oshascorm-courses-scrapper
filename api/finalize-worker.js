import { list, put } from '@vercel/blob';
import { Redis } from '@upstash/redis';
import ExcelJS from 'exceljs';
import Fuse from 'fuse.js';

const redis = Redis.fromEnv();

export const config = {
  maxDuration: 60,
  memory: 2048
};

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  let payload = req.body;
  if (typeof payload === 'string') payload = JSON.parse(payload);
  const { jobId } = payload || {};

  if (!jobId) return res.status(400).json({ error: 'Missing jobId' });

  const redisKey = `temp_scrape:${jobId}`;
  const blobPath = process.env.EXCEL_BLOB_PATH || 'ICTrainingUS_reviewed_with_course_highlights.xlsx';

  try {
    // 1. Fetch accumulated items from Redis
    const rawItems = await redis.lrange(redisKey, 0, -1);
    
    if (!rawItems || rawItems.length === 0) {
      console.log(`[Finalizer] No parsed course data found for ${jobId}`);
      await cleanupKeys(jobId);
      return res.status(200).json({ message: 'No course rows to commit' });
    }

    const scrapedCourses = rawItems.map(item => (typeof item === 'string' ? JSON.parse(item) : item));
    console.log(`[Finalizer] Consolidating ${scrapedCourses.length} courses for Job ID: ${jobId}`);

    // 2. BLOB READ (1 Operation)
    const masterBlobList = await list({ prefix: blobPath });
    const workbook = new ExcelJS.Workbook();
    let masterSheet;

    if (masterBlobList.blobs && masterBlobList.blobs.length > 0) {
      const blobResp = await fetch(`${masterBlobList.blobs[0].url}?cb=${Date.now()}`);
      if (blobResp.ok) {
        const buffer = await blobResp.arrayBuffer();
        if (buffer.byteLength > 500) {
          await workbook.xlsx.load(buffer);
          masterSheet = workbook.getWorksheet('Master Catalog') || workbook.worksheets[0];
        }
      }
    }

    if (!masterSheet) {
      masterSheet = workbook.addWorksheet('Master Catalog');
      masterSheet.addRow([
        'Category', 'Course Title', 'Display Name', 'Highlights',
        'Course Type', 'Regulatory Body', 'CFR Citation',
        'Industry Scope', 'Duration', 'Price', 'Bundle Eligibility', 'Bundle Category'
      ]);
    }

    // 3. Deduplication setup
    const existingNames = [];
    masterSheet.eachRow((row, rowNum) => {
      if (rowNum > 1 && row.getCell(3).value) {
        existingNames.push(String(row.getCell(3).value).trim().toLowerCase());
      }
    });

    const fuse = new Fuse(existingNames, { threshold: 0.2 });
    let addedCount = 0;

    // 4. Batch append unique courses
    for (const course of scrapedCourses) {
      const normTitle = course.title.trim().toLowerCase();

      if (existingNames.includes(normTitle) || fuse.search(normTitle).length > 0) {
        continue;
      }

      const priceNum = parseFloat(course.rawPrice.replace(/[^0-9.]/g, '')) || 29.99;
      let regBody = 'OSHA';
      if (course.title.includes('DOT') || course.citation.includes('49 CFR')) regBody = 'DOT';
      else if (course.title.includes('EPA')) regBody = 'EPA';

      masterSheet.addRow([
        'General Safety',
        course.title,
        course.title,
        course.highlights,
        'Core Course',
        regBody,
        course.citation,
        'General Industry, Workforce Safety',
        course.duration,
        priceNum,
        'Bundle-Eligible',
        'General Safety Bundle'
      ]);

      existingNames.push(normTitle);
      addedCount++;
    }

    // 5. BLOB WRITE (1 Operation)
    const updatedBuffer = await workbook.xlsx.writeBuffer();
    await put(blobPath, updatedBuffer, { access: 'public', addRandomSuffix: false });

    // 6. Clean up state keys in Redis
    await cleanupKeys(jobId);

    console.log(`[Finalizer Complete - ${jobId}] Successfully appended ${addedCount} new courses to Blob file.`);
    return res.status(200).json({ success: true, addedCount, totalProcessed: scrapedCourses.length });

  } catch (err) {
    console.error(`[Finalizer Exception]: ${err.message}`);
    return res.status(500).json({ error: err.message });
  }
}

async function cleanupKeys(jobId) {
  try {
    await redis.del(`temp_scrape:${jobId}`);
    await redis.del(`total_count:${jobId}`);
    await redis.del(`completed_count:${jobId}`);
  } catch (err) {
    console.error(`[Cleanup Error]: ${err.message}`);
  }
}