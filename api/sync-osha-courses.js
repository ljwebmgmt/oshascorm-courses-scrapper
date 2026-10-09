import { list } from '@vercel/blob';
import * as xlsx from 'xlsx';
import { 
  uploadJsonl, 
  runBulk, 
  getBulkStatus, 
  shopifyGraphql, 
  resolveShopifyToken 
} from './utils/shopify.js';

// Helper: Standardize titles for exact normalized string comparisons
function normalizeTitle(str) {
  if (!str) return '';
  return str
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .trim();
}

function generateHandle(title) {
  if (!title) return '';
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// Helper: Parse 'Meta Data for Marketing' cell to extract Meta Description
function extractMetaDescription(metaString) {
  if (!metaString) return '';
  const match = metaString.match(/Meta Description:\s*([^\n]+)/i);
  return match ? match[1].trim() : '';
}

// Helper: Download Excel master file from Vercel Blob Storage
async function getCoursesFromBlob() {
  const blobFileName = process.env.EXCEL_BLOB_PATH_NEW || 'HAZWOPER-OSHA_Master_Course_Catalog_and_B2B_Bundles_v3.xlsx';
  
  const { blobs } = await list();
  const targetBlob = blobs.find(b => b.pathname.endsWith(blobFileName) || b.pathname === blobFileName);

  if (!targetBlob) {
    throw new Error(`Master catalog file "${blobFileName}" was not found in Vercel Blob storage.`);
  }

  console.log(`[Blob Loader] Fetching Excel catalog from: ${targetBlob.url}`);

  const response = await fetch(targetBlob.url);
  if (!response.ok) {
    throw new Error(`Failed to download Blob file. HTTP Status: ${response.status}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  const workbook = xlsx.read(new Uint8Array(arrayBuffer), { type: 'array' });

  const sheetName = workbook.SheetNames.includes('Master Course List') 
    ? 'Master Course List' 
    : workbook.SheetNames[0];

  const sheet = workbook.Sheets[sheetName];
  const rows = xlsx.utils.sheet_to_json(sheet);

  console.log(`[Blob Loader] Successfully parsed ${rows.length} course rows from sheet "${sheetName}".`);
  return rows;
}

export default async function handler(request, response) {
  // 1. Security Check
  const authHeader = request.headers.authorization;
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return response.status(401).json({ success: false, error: 'Unauthorized' });
  }

  // Operation Mode: 'upsert' (default), 'delete', or 'auto'
  const operation = request.query.operation || 'upsert';
  const isDryRun = request.query.dryRun === 'true';

  const storeCfg = {
    store: process.env.SHOPIFY_STORE_DOMAIN,
    client_id: process.env.SHOPIFY_STORE_CLIENT_ID,
    client_secret: process.env.SHOPIFY_STORE_CLIENT_SECRET,
    api_version: '2026-04'
  };

  try {
    storeCfg.token = await resolveShopifyToken(storeCfg);

    // 2. Operational Shield: Check if a bulk job is currently running on Shopify
    if (!isDryRun) {
      const statusCheck = await getBulkStatus(storeCfg);
      const currentStatus = statusCheck?.data?.currentBulkOperation?.status;

      if (currentStatus === 'RUNNING' || currentStatus === 'CANCELING') {
        console.warn(`[Bulk Operational Shield] Active bulk operation is ${currentStatus}. Skipping.`);
        return response.status(200).json({ 
          success: true, 
          message: 'Bulk operation already in progress. Skipped.' 
        });
      }
    }

    // 3. Download and Parse Excel Catalog directly from Vercel Blob
    const incomingCourses = await getCoursesFromBlob();

    // Map incoming rows by both Primary Title AND Original Title
    const incomingMap = new Map();
    for (const c of incomingCourses) {
      const primaryName = c['Course Name (most-searched title)'] || c.course_name;
      const originalName = c['Original Title (as in Master_list / source)'];

      const normPrimary = normalizeTitle(primaryName);
      if (normPrimary) {
        incomingMap.set(normPrimary, c);
      }

      const normOriginal = normalizeTitle(originalName);
      if (normOriginal && normOriginal !== normPrimary) {
        incomingMap.set(normOriginal, c);
      }
    }

    // 4. Fetch All Existing 'osha_course' Metaobjects from Shopify
    const existingMetaobjects = [];
    let hasNextPage = true;
    let cursor = null;

    while (hasNextPage) {
      const query = `
        query getMetaobjects($after: String) {
          metaobjects(type: "osha_course", first: 250, after: $after) {
            pageInfo { hasNextPage endCursor }
            nodes {
              id
              handle
              field(key: "course_name") { value }
            }
          }
        }
      `;

      const data = await shopifyGraphql(
        storeCfg.store,
        storeCfg.token,
        storeCfg.api_version,
        query,
        { after: cursor }
      );

      const nodes = data?.data?.metaobjects?.nodes || [];
      for (const node of nodes) {
        existingMetaobjects.push({
          id: node.id,
          handle: node.handle,
          course_name: node.field ? node.field.value : ''
        });
      }

      hasNextPage = data?.data?.metaobjects?.pageInfo?.hasNextPage || false;
      cursor = data?.data?.metaobjects?.pageInfo?.endCursor || null;
    }

    const existingMap = new Map();
    for (const mo of existingMetaobjects) {
      const norm = normalizeTitle(mo.course_name);
      if (norm) existingMap.set(norm, mo);
    }

    // 5. Build Mutations Based on 'operation' Mode
    const jsonlLinesUpsert = [];
    const jsonlLinesDelete = [];
    const processedMetaobjectIds = new Set();

    const summary = {
      total_blob_courses: incomingCourses.length,
      mode: operation,
      to_create: 0,
      to_update: 0,
      to_delete: 0
    };

    // A. Build Upserts
    if (operation === 'upsert' || operation === 'auto') {
      for (const courseData of incomingCourses) {
        const primaryName = courseData['Course Name (most-searched title)'] || courseData.course_name;
        const originalName = courseData['Original Title (as in Master_list / source)'];

        const normPrimary = normalizeTitle(primaryName);
        const normOriginal = normalizeTitle(originalName);

        let existingMO = existingMap.get(normPrimary);
        if (!existingMO && normOriginal) {
          existingMO = existingMap.get(normOriginal);
        }

        if (existingMO && processedMetaobjectIds.has(existingMO.id)) {
          continue;
        }

        const citation = courseData['Citation (Regulatory Body – Governing Standard)'] || courseData.governing_regulation_citation || '';
        const price = parseFloat(courseData['Price per Seat (USD)'] || courseData.est_msrp || 0).toFixed(2);
        const duration = `${courseData['Duration (Hours)'] || courseData.suggested_duration || ''} Hours`;
        const validity = courseData['Certificate Validity'] || courseData.certificate_validity || '';
        const highlights = courseData['Course Description (bulleted)'] || courseData.course_highlights || '';
        const category = courseData['Category Name'] || courseData.category || '';
        const audience = courseData['Primary Industries / Audience'] || courseData.primary_industries || '';
        const courseType = courseData['Course Type'] || courseData.course_type || '';
        const metaDesc = extractMetaDescription(courseData['Meta Data for Marketing'] || courseData.meta_description || '');
        const bundleClass = courseData['Compliance Pack(s)'] || courseData.bundle_class || '';
        const industryBundleTags = courseData['Industry Library(ies)'] || courseData.industry_bundle_tags || '';

        const fields = [
          { key: 'course_name', value: String(primaryName) },
          { key: 'governing_regulation_citation', value: String(citation) },
          { key: 'est_msrp', value: String(price) },
          { key: 'suggested_duration', value: String(duration) },
          { key: 'certificate_validity', value: String(validity) },
          { key: 'course_highlights', value: String(highlights) },
          { key: 'category', value: String(category) },
          { key: 'primary_industries', value: String(audience) },
          { key: 'course_type', value: String(courseType) },
          { key: 'meta_description', value: String(metaDesc) },
          { key: 'bundle_class', value: String(bundleClass) },
          { key: 'industry_bundle_tags', value: String(industryBundleTags) }
        ];

        if (existingMO) {
          summary.to_update++;
          processedMetaobjectIds.add(existingMO.id);
          jsonlLinesUpsert.push(JSON.stringify({
            id: existingMO.id,
            metaobject: { fields }
          }));
        } else {
          summary.to_create++;
          jsonlLinesUpsert.push(JSON.stringify({
            metaobject: {
              type: "osha_course",
              handle: generateHandle(primaryName),
              fields
            }
          }));
        }
      }
    }

    // B. Build Deletions
    if (operation === 'delete' || operation === 'auto') {
      for (const [normTitle, existingMO] of existingMap.entries()) {
        if (!incomingMap.has(normTitle) && !processedMetaobjectIds.has(existingMO.id)) {
          summary.to_delete++;
          processedMetaobjectIds.add(existingMO.id);
          jsonlLinesDelete.push(JSON.stringify({ id: existingMO.id }));
        }
      }
    }

    // --- DRY RUN INTERCEPTOR ---
    if (isDryRun) {
      return response.status(200).json({
        success: true,
        dry_run: true,
        summary,
        message: 'Dry run completed. No Shopify metaobjects were modified.'
      });
    }

    // 6. Execute Single Targeted Bulk Operation
    let bulkResult = null;

    if (operation === 'delete') {
      if (jsonlLinesDelete.length === 0) {
        return response.status(200).json({ success: true, message: 'No stale metaobjects found to delete.' });
      }
      const deletePayload = jsonlLinesDelete.join('\n');
      const stagedPathDelete = await uploadJsonl(storeCfg, deletePayload, "BULK_MUTATION_VARIABLES");
      const DELETE_MUTATION = `
        mutation metaobjectDelete($id: ID!) {
          metaobjectDelete(id: $id) {
            deletedId
            userErrors { field message }
          }
        }
      `;
      bulkResult = await runBulk(storeCfg, stagedPathDelete, DELETE_MUTATION);

    } else if (operation === 'upsert' || operation === 'auto') {
      if (jsonlLinesUpsert.length === 0) {
        return response.status(200).json({ success: true, message: 'No courses found to upsert.' });
      }
      const upsertPayload = jsonlLinesUpsert.join('\n');
      const stagedPathUpsert = await uploadJsonl(storeCfg, upsertPayload, "BULK_MUTATION_VARIABLES");
      const UPSERT_MUTATION = `
        mutation metaobjectUpsert($id: ID, $metaobject: MetaobjectUpsertInput!) {
          metaobjectUpsert(id: $id, metaobject: $metaobject) {
            metaobject { id handle }
            userErrors { field message }
          }
        }
      `;
      bulkResult = await runBulk(storeCfg, stagedPathUpsert, UPSERT_MUTATION);
    }

    return response.status(200).json({
      success: true,
      summary,
      bulk_job: bulkResult?.data?.bulkOperationRunMutation?.bulkOperation || null
    });

  } catch (error) {
    console.error('[Blob Metaobject Sync Exception Alert]:', error.message);
    return response.status(500).json({ success: false, error: error.message });
  }
}