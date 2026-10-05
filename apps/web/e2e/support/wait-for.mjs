#!/usr/bin/env node
// Waits until a URL answers 2xx (or 60 s pass), then exits; used to order e2e servers:
// the API server fetches the IdP's discovery document at boot.
const [url] = process.argv.slice(2);
const deadline = Date.now() + 60_000;
while (Date.now() < deadline) {
  try {
    const res = await fetch(url);
    if (res.ok) process.exit(0);
  } catch {
    // Not up yet.
  }
  await new Promise((resolve) => setTimeout(resolve, 200));
}
console.error(`wait-for: ${url} did not come up within 60 s`);
process.exit(1);
