#!/usr/bin/env node
/**
 * Probe the exact GraphQL type wrapper chain for Query.tournamentWins
 * so we can see what the subgraph is actually returning.
 *
 * Run:
 *   node scripts/probe-tournamentWins-type.js
 *   node scripts/probe-tournamentWins-type.js --endpoint=https://.../1.7
 */

function parseArgs(argv) {
  const args = {};
  for (const a of argv.slice(2)) {
    const m = a.match(/^--([^=]+)=(.*)$/);
    if (m) args[m[1]] = m[2];
    else if (a.startsWith("--")) args[a.slice(2)] = "1";
  }
  return args;
}

async function gql(endpoint, query, variables) {
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`Non-JSON response (HTTP ${res.status}): ${text.slice(0, 500)}`);
  }
  if (json.errors?.length) {
    throw new Error(`Graph errors:\n${JSON.stringify(json.errors, null, 2)}`);
  }
  return json.data;
}

// TypeRef recursion (10 levels deep)
const TYPE_REF = `
  kind
  name
  ofType {
    kind
    name
    ofType {
      kind
      name
      ofType {
        kind
        name
        ofType {
          kind
          name
          ofType {
            kind
            name
            ofType {
              kind
              name
              ofType {
                kind
                name
                ofType {
                  kind
                  name
                  ofType {
                    kind
                    name
                    ofType {
                      kind
                      name
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  }
`;

const Q = `
query {
  __schema {
    queryType { name }
    types {
      kind
      name
      fields {
        name
        type { ${TYPE_REF} }
        args { name type { ${TYPE_REF} } }
      }
    }
  }
}
`;

function unwrapKinds(t) {
  const out = [];
  let cur = t;
  let guard = 0;
  while (cur && guard++ < 100) {
    out.push(cur.kind + (cur.name ? `(${cur.name})` : ""));
    cur = cur.ofType;
  }
  return out;
}

function findType(schema, name) {
  return schema.__schema.types.find((x) => x.name === name);
}

(async function main() {
  const args = parseArgs(process.argv);

  const endpoint =
    args.endpoint ||
    "https://api.studio.thegraph.com/query/1742426/tournament-leaderboards/1.7";

  console.log("Endpoint:", endpoint);

  const schema = await gql(endpoint, Q, {});
  const queryTypeName = schema.__schema.queryType?.name;
  console.log("Query type:", queryTypeName);

  const queryType = findType(schema, queryTypeName);
  if (!queryType) throw new Error("Could not find Query type object.");

  const winFields = (queryType.fields || []).filter((f) =>
    f.name.toLowerCase().includes("win")
  );

  console.log("\nQuery fields containing 'win':");
  for (const f of winFields) {
    console.log(`- ${f.name}`);
    console.log("  type chain:", unwrapKinds(f.type).join(" -> "));
    console.log("  args:", (f.args || []).map((a) => a.name).join(", ") || "(none)");
  }

  const tw = (queryType.fields || []).find((f) => f.name === "tournamentWins");
  if (!tw) {
    console.log("\nNo field named tournamentWins on Query.");
    process.exit(0);
  }

  console.log("\n===============================");
  console.log("RAW Query.tournamentWins.type:");
  console.log("===============================");
  console.log(JSON.stringify(tw.type, null, 2));

  console.log("\nType chain:", unwrapKinds(tw.type).join(" -> "));
})();