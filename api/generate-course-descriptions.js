// Course Description Generator Script
// Uses Shopify GraphQL API and existing utilities to generate descriptions for osha_course metaobjects

import { shopifyGraphql, resolveShopifyToken } from './utils/shopify.js';

export const config = {
  maxDuration: 60,
  memory: 1024
};

const PAGE_SIZE = 250;
const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 20;
const PROCESSING_DELAY_MS = 500;

function getFieldValue(node, key) {
  return node?.[key]?.value || '';
}

function hasDescription(node) {
  return getFieldValue(node, 'description').trim() !== '';
}

function buildContentPayload(node) {
  return {
    course_name: getFieldValue(node, 'course_name'),
    governing_regulation_citation: getFieldValue(node, 'governing_regulation_citation'),
    suggested_duration: getFieldValue(node, 'suggested_duration'),
    course_highlights: getFieldValue(node, 'course_highlights'),
    primary_industries: getFieldValue(node, 'primary_industries'),
    regulatory_body: getFieldValue(node, 'regulatory_body'),
    course_type: getFieldValue(node, 'course_type'),
    course_family: getFieldValue(node, 'course_family')
  };
}

async function fetchMetaobjectsNeedingDescriptions(storeCfg, token, limit) {
  const candidates = [];
  let hasNextPage = true;
  let cursor = null;
  let scanned = 0;

  while (hasNextPage && candidates.length < limit) {
    const query = `
      query getMetaobjects($after: String) {
        metaobjects(type: "osha_course", first: ${PAGE_SIZE}, after: $after) {
          pageInfo { hasNextPage endCursor }
          nodes {
            id
            handle
            course_name: field(key: "course_name") { value }
            governing_regulation_citation: field(key: "governing_regulation_citation") { value }
            suggested_duration: field(key: "suggested_duration") { value }
            course_highlights: field(key: "course_highlights") { value }
            primary_industries: field(key: "primary_industries") { value }
            regulatory_body: field(key: "regulatory_body") { value }
            course_type: field(key: "course_type") { value }
            course_family: field(key: "course_family") { value }
            description: field(key: "description") { value }
          }
        }
      }
    `;

    const data = await shopifyGraphql(
      storeCfg.store,
      token,
      storeCfg.api_version,
      query,
      { after: cursor }
    );

    const nodes = data?.data?.metaobjects?.nodes || [];
    scanned += nodes.length;

    for (const node of nodes) {
      if (!hasDescription(node)) {
        candidates.push(node);
        if (candidates.length >= limit) break;
      }
    }

    hasNextPage = data?.data?.metaobjects?.pageInfo?.hasNextPage || false;
    cursor = data?.data?.metaobjects?.pageInfo?.endCursor || null;
  }

  console.log(`[Course Descriptions] Scanned ${scanned} metaobjects, found ${candidates.length} needing descriptions.`);
  return candidates;
}

async function generateContent(request, node) {
  const protocol = request.headers['x-forwarded-proto'] || 'https';
  const host = request.headers['host'];
  const contentUrl = `${protocol}://${host}/api/generate-course-content`;

  const response = await fetch(contentUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(buildContentPayload(node))
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.success || !data.content) {
    throw new Error(data.message || data.error || `Content generation failed with HTTP ${response.status}`);
  }

  return data.content;
}

async function updateMetaobjectDescription(storeCfg, token, metaobjectId, description) {
  const mutation = `
    mutation metaobjectUpdate($id: ID!, $metaobject: MetaobjectUpdateInput!) {
      metaobjectUpdate(id: $id, metaobject: $metaobject) {
        metaobject {
          id
          handle
        }
        userErrors {
          field
          message
        }
      }
    }
  `;

  const variables = {
    id: metaobjectId,
    metaobject: {
      fields: [
        {
          key: 'description',
          value: description
        }
      ]
    }
  };

  const data = await shopifyGraphql(
    storeCfg.store,
    token,
    storeCfg.api_version,
    mutation,
    variables
  );

  const update = data?.data?.metaobjectUpdate;
  if (update?.userErrors?.length > 0) {
    throw new Error(update.userErrors.map(error => error.message).join('; '));
  }

  return update?.metaobject || null;
}

export default async function handler(request, response) {
  if (request.method !== 'GET' && request.method !== 'POST') {
    return response.status(405).json({ success: false, error: 'Method not allowed' });
  }

  const cronSecret = process.env.CRON_SECRET;
  const authHeader = request.headers.authorization;
  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return response.status(401).json({ success: false, error: 'Unauthorized' });
  }

  const isDryRun = request.query.dryRun === 'true';
  const parsedLimit = parseInt(request.query.limit, 10);
  const limit = Number.isFinite(parsedLimit)
    ? Math.min(Math.max(parsedLimit, 1), MAX_LIMIT)
    : DEFAULT_LIMIT;

  const storeCfg = {
    store: process.env.SHOPIFY_STORE_DOMAIN,
    client_id: process.env.SHOPIFY_STORE_CLIENT_ID,
    client_secret: process.env.SHOPIFY_STORE_CLIENT_SECRET,
    api_version: '2026-04'
  };

  try {
    storeCfg.token = await resolveShopifyToken(storeCfg);

    const candidates = await fetchMetaobjectsNeedingDescriptions(storeCfg, storeCfg.token, limit);

    if (candidates.length === 0) {
      return response.status(200).json({
        success: true,
        message: 'No metaobjects found needing descriptions.',
        processed: 0,
        failed: 0
      });
    }

    if (isDryRun) {
      return response.status(200).json({
        success: true,
        dry_run: true,
        candidates_found: candidates.length,
        candidates: candidates.map(node => ({
          id: node.id,
          handle: node.handle,
          course_name: getFieldValue(node, 'course_name')
        }))
      });
    }

    let processed = 0;
    let failed = 0;
    const results = [];

    for (const node of candidates) {
      try {
        const description = await generateContent(request, node);
        const updated = await updateMetaobjectDescription(storeCfg, storeCfg.token, node.id, description);

        if (updated) {
          processed++;
          results.push({ id: node.id, handle: node.handle, status: 'updated' });
          console.log(`Updated ${node.handle}`);
        } else {
          failed++;
          results.push({ id: node.id, handle: node.handle, status: 'failed', error: 'Metaobject update returned no result' });
        }
      } catch (error) {
        failed++;
        results.push({ id: node.id, handle: node.handle, status: 'failed', error: error.message });
        console.error(`Error processing ${node.handle}:`, error.message);
      }

      await new Promise(resolve => setTimeout(resolve, PROCESSING_DELAY_MS));
    }

    return response.status(200).json({
      success: failed === 0,
      processed,
      failed,
      results
    });

  } catch (error) {
    console.error('[Course Description Generation Exception Alert]:', error.message);
    return response.status(500).json({ success: false, error: error.message });
  }
}
