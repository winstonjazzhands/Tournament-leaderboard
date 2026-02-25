// Tiny GraphQL client + a resilient "try these queries" helper.
export async function gql(endpoint, query, variables = {}, { headers = {}, timeoutMs = 20000 } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);

  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...headers,
      },
      body: JSON.stringify({ query, variables }),
      signal: ctrl.signal,
    });

    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* ignore */ }

    if (!res.ok) {
      const msg = json?.errors?.[0]?.message || text || `${res.status} ${res.statusText}`;
      throw new Error(`${res.status} ${res.statusText} :: ${msg}`);
    }
    if (json?.errors?.length) {
      throw new Error(json.errors[0].message);
    }
    return json?.data ?? null;
  } finally {
    clearTimeout(t);
  }
}

export async function introspect(endpoint) {
  // Standard introspection query (trimmed)
  const query = `
    query IntrospectionQuery {
      __schema {
        queryType { name }
        types {
          kind
          name
          fields(includeDeprecated: true) {
            name
            args { name type { kind name ofType { kind name ofType { kind name } } } }
            type { kind name ofType { kind name ofType { kind name } } }
          }
        }
      }
    }
  `;
  return gql(endpoint, query, {});
}

/**
 * Try a list of query builders until one works.
 * Each builder returns: { query, variables, pick(data) } where pick extracts
 * a [{id,minLevel,maxLevel}] array from the returned data.
 */
export async function tryQueries(endpoint, builders, ids) {
  let lastErr = null;
  for (const b of builders) {
    try {
      const { query, variables, pick } = b(ids);
      const data = await gql(endpoint, query, variables);
      const rows = pick(data);
      if (Array.isArray(rows) && rows.length) return { rows, used: b.name || "anonymous" };
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error("All query attempts failed");
}
