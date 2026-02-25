import fs from "fs";
import path from "path";

export function readJson(p, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf-8"));
  } catch {
    return fallback;
  }
}

export function writeJson(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(obj, null, 2));
}

export function uniq(arr) {
  return [...new Set(arr)];
}

export function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

export function nowIso() {
  return new Date().toISOString();
}

export function lowerAddr(a) {
  return String(a || "").toLowerCase();
}
