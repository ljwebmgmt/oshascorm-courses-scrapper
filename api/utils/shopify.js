export async function shopifyGraphql(store, token, apiVersion, query, variables = {}) {
  const resp = await fetch(`https://${store}/admin/api/${apiVersion}/graphql.json`, {
    method: 'POST',
    headers: {
      'X-Shopify-Access-Token': token,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ query, variables })
  });
  const json = await resp.json();
  const limit = resp.headers.get('x-shopify-shop-api-call-limit') || resp.headers.get('X-Shopify-Shop-Api-Call-Limit');
  if (limit) console.log(`[API Limit] ${store}: ${limit}`);
  if (json.errors) throw new Error(JSON.stringify(json.errors));
  return json;
}

/* ================= BULK OPS ================= */

export async function uploadJsonl(storeCfg, jsonl, resource = "BULK_MUTATION_VARIABLES") {
  const response = await shopifyGraphql(storeCfg.store, storeCfg.token, storeCfg.api_version, `
    mutation stagedUploadsCreate($input: [StagedUploadInput!]!) {
      stagedUploadsCreate(input: $input) {
        stagedTargets {
          url
          parameters { name value }
        }
        userErrors { field message }
      }
    }`,
    {
      input: [{
        resource,
        filename: "bulk_input.jsonl",
        mimeType: "text/jsonl",
        httpMethod: "POST"
      }]
    }
  );

  const result = response?.data?.stagedUploadsCreate || response?.stagedUploadsCreate;
  if (result?.userErrors?.length > 0) {
    throw new Error(`Shopify stagedUploadsCreate Error: ${result.userErrors[0].message}`);
  }
  if (!result?.stagedTargets || result.stagedTargets.length === 0) {
    console.error("Full Shopify Response:", JSON.stringify(response, null, 2));
    throw new Error("Failed to get stagedTargets from Shopify. Check the console for the full response.");
  }
  const target = result.stagedTargets[0];
  const keyParam = target.parameters.find(p => p.name === 'key');
  
  // The 'key' parameter is the relative path Shopify needs for the bulkRun mutation
  const actualPath = keyParam.value;

  const form = new FormData();
  target.parameters.forEach(p => form.append(p.name, p.value));
  form.append('file', new Blob([jsonl], { type: 'text/jsonl' }));

  const resp = await fetch(target.url, { method: 'POST', body: form });
  if (!resp.ok) throw new Error(`GCS Upload Failed: ${resp.status}`);

  return actualPath;
}

export async function runBulk(storeCfg, stagedPath, mutationString) {
  const finalMutation = mutationString || `
    mutation metafieldsSet($input: MetafieldsSetInput!) {
      metafieldsSet(metafields: [$input]) {
        userErrors { message }
      }
    }
  `;
  const result = await shopifyGraphql(storeCfg.store, storeCfg.token, storeCfg.api_version, `
    mutation bulkRun($mutation: String!, $stagedUploadPath: String!) {
      bulkOperationRunMutation(mutation: $mutation, stagedUploadPath: $stagedUploadPath) {
        bulkOperation { id status }
        userErrors { message }
      }
    }`,
    {
      mutation: finalMutation,
      stagedUploadPath: stagedPath
    }
  );
  if (result?.data?.bulkOperationRunMutation?.userErrors?.length > 0) {
    const error = result.data.bulkOperationRunMutation.userErrors[0].message;
    if (error.includes("already in progress")) {
      console.warn("A bulk job is already running on Shopify. Skipping this update to avoid timeout.");
      return { skipped: true }; 
    }
    throw new Error(`Bulk Operation Error: ${error}`);
  }

  return result;
}

export async function getBulkStatus(storeCfg) {
  return shopifyGraphql(storeCfg.store, storeCfg.token, storeCfg.api_version, `
    query {
      currentBulkOperation {
        id
        status
        errorCode
        type
        url
      }
    }`);
}

export async function resolveShopifyToken(storeCfg) {
  if (storeCfg.token) return storeCfg.token;
  if (storeCfg.client_id && storeCfg.client_secret) {
    console.log(`Generating temporary token for ${storeCfg.store}...`);

    const response = await fetch(`https://${storeCfg.store}/admin/oauth/access_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: storeCfg.client_id,
        client_secret: storeCfg.client_secret,
        grant_type: 'client_credentials'
      })
    });
    const data = await response.json();

    if (!response.ok) {
      throw new Error(`Shopify Auth Error [${storeCfg.store}]: ${data.error_description || data.error}`);
    }
    return data.access_token;
  }

  throw new Error(`Missing credentials for store: ${storeCfg.store}`);
}
