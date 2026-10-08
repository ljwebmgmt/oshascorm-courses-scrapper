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

export default async function handler(request, response) {
  // 1. Security Check for Vercel Cron or Manual Invocation
  const authHeader = request.headers.authorization;
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return response.status(401).json({ success: false, error: 'Unauthorized' });
  }

  // Extract Query Parameters
  const isDryRun = request.query.dryRun === 'true';

  const storeCfg = {
    store: process.env.SHOPIFY_STORE_DOMAIN,
    client_id: process.env.SHOPIFY_STORE_CLIENT_ID,
    client_secret: process.env.SHOPIFY_STORE_CLIENT_SECRET,
    api_version: '2026-04'
  };

  try {
    storeCfg.token = await resolveShopifyToken(storeCfg);

    // 2. Concurrency Protection: Avoid overlapping bulk operations
    if (!isDryRun) {
      const statusCheck = await getBulkStatus(storeCfg);
      const currentStatus = statusCheck?.data?.currentBulkOperation?.status;

      if (currentStatus === 'RUNNING' || currentStatus === 'CANCELING') {
        console.warn(`[Bulk Operational Shield] A bulk job is currently ${currentStatus}. Skipping.`);
        return response.status(200).json({ 
          success: true, 
          message: 'Bulk operation already in progress. Skipped.' 
        });
      }
    }

    // 3. Fetch All Products (Titles)
    const productTitles = new Set();
    let hasNextPageProducts = true;
    let productCursor = null;

    while (hasNextPageProducts) {
      const productQuery = `
        query getProducts($after: String) {
          products(first: 250, after: $after) {
            pageInfo { hasNextPage endCursor }
            nodes { title }
          }
        }
      `;

      const prodData = await shopifyGraphql(
        storeCfg.store, 
        storeCfg.token, 
        storeCfg.api_version, 
        productQuery, 
        { after: productCursor }
      );

      const products = prodData?.data?.products?.nodes || [];
      for (const prod of products) {
        const normalized = normalizeTitle(prod.title);
        if (normalized) productTitles.add(normalized);
      }

      hasNextPageProducts = prodData?.data?.products?.pageInfo?.hasNextPage || false;
      productCursor = prodData?.data?.products?.pageInfo?.endCursor || null;
    }

    // 4. Fetch All 'osha_course' Metaobjects
    const courses = [];
    let hasNextPageCourses = true;
    let courseCursor = null;

    while (hasNextPageCourses) {
      const courseQuery = `
        query getMetaobjects($after: String) {
          metaobjects(type: "osha_course", first: 250, after: $after) {
            pageInfo { hasNextPage endCursor }
            nodes {
              id
              field(key: "course_name") { value }
            }
          }
        }
      `;

      const courseData = await shopifyGraphql(
        storeCfg.store, 
        storeCfg.token, 
        storeCfg.api_version, 
        courseQuery, 
        { after: courseCursor }
      );

      const metaobjects = courseData?.data?.metaobjects?.nodes || [];
      for (const obj of metaobjects) {
        courses.push({
          id: obj.id,
          course_name: obj.field ? obj.field.value : ''
        });
      }

      hasNextPageCourses = courseData?.data?.metaobjects?.pageInfo?.hasNextPage || false;
      courseCursor = courseData?.data?.metaobjects?.pageInfo?.endCursor || null;
    }

    // 5. Audit Duplicates & Build JSONL Payload
    let jsonlLines = [];
    let previewObjects = [];

    for (const course of courses) {
      const normalizedCourseName = normalizeTitle(course.course_name);

      if (productTitles.has(normalizedCourseName)) {
        const payload = { id: course.id };
        jsonlLines.push(JSON.stringify(payload));
        previewObjects.push({
          metaobjectId: course.id,
          courseName: course.course_name
        });
      }
    }

    // 6. Handle Zero Duplicates
    if (jsonlLines.length === 0) {
      return response.status(200).json({
        success: true,
        message: 'No duplicate osha_course metaobjects found matching product titles.'
      });
    }

    // --- DRY RUN INTERCEPTOR ---
    if (isDryRun) {
      return response.status(200).json({
        success: true,
        dry_run: true,
        total_duplicates_found: jsonlLines.length,
        message: 'Dry run successful. No metaobjects were deleted from Shopify.',
        preview: previewObjects
      });
    }

    const jsonlPayload = jsonlLines.join('\n');

    // 7. Staged Upload
    const stagedPath = await uploadJsonl(storeCfg, jsonlPayload, "BULK_MUTATION_VARIABLES");

    // 8. Execute Bulk Metaobject Deletion
    const DELETE_METAOBJECT_MUTATION = `
      mutation metaobjectDelete($id: ID!) {
        metaobjectDelete(id: $id) {
          deletedId
          userErrors { field message }
        }
      }
    `;

    const bulkExecution = await runBulk(storeCfg, stagedPath, DELETE_METAOBJECT_MUTATION);

    return response.status(200).json({
      success: true,
      bulk_job_enqueued: true,
      total_duplicates_flagged: jsonlLines.length,
      details: bulkExecution?.data?.bulkOperationRunMutation?.bulkOperation || null
    });

  } catch (error) {
    console.error('[Duplicate Metaobject Audit Exception Alert]:', error.message);
    return response.status(500).json({ success: false, error: error.message });
  }
}