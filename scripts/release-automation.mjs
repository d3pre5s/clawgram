// Shared release safeguards. Reads may be retried; ambiguous writes may not.
import { setTimeout as sleep } from "node:timers/promises";

export async function readNpmRelease(release, options = {}) {
  const url = `https://registry.npmjs.org/${encodeURIComponent(release.name)}/${encodeURIComponent(release.version)}`;
  return readRegistry(url, "npm", options);
}

async function readRegistry(url, registry, options = {}) {
  const request = options.fetch ?? fetch;
  const wait = options.sleep ?? sleep;
  for (let attempt = 0; attempt < 3; attempt++) {
    let response;
    try {
      response = await request(url, { signal: AbortSignal.timeout(30000), cache: "no-store" });
    } catch (error) {
      if (attempt === 2) throw error;
      await wait((attempt + 1) * 2000);
      continue;
    }
    if (response.status === 404) return null;
    if (response.ok) return response.json();
    if ((response.status === 429 || response.status >= 500) && attempt < 2) {
      await wait((attempt + 1) * 2000);
      continue;
    }
    throw new Error(`${registry} registry returned HTTP ${response.status}; release state is unknown.`);
  }
}

function clawhubVersionUrl(release) {
  return `https://clawhub.ai/api/v1/packages/${encodeURIComponent(release.name)}/versions/${encodeURIComponent(release.version)}`;
}

export async function readClawhubPublication(release, options = {}) {
  const state = await readRegistry(`${clawhubVersionUrl(release)}/publication`, "ClawHub", options);
  // Compatibility with servers predating the publication endpoint.
  if (!state || state.state === undefined) {
    const version = await readRegistry(clawhubVersionUrl(release), "ClawHub", options);
    return { state: version ? "published" : "absent" };
  }
  if (state.name !== release.name || state.version !== release.version ||
      !["absent", "pending", "published", "failed"].includes(state.state)) {
    throw new Error("Invalid ClawHub publication response.");
  }
  return state;
}

export async function verifyClawhubRelease(release, options = {}) {
  const metadata = await readRegistry(clawhubVersionUrl(release), "ClawHub", options);
  const repo = metadata?.version?.verification?.sourceRepo?.replace(/^https:\/\/github\.com\//, "").replace(/\.git$/, "");
  if (metadata?.package?.name !== release.name || metadata?.version?.version !== release.version ||
      metadata.version.verification?.sourceCommit !== release.commit || repo !== "d3pre5s/clawgram") {
    throw new Error("Published ClawHub version does not match the checked-out release commit.");
  }
}

export async function ensureClawhubRelease(release, options) {
  const read = options.read ?? (() => readClawhubPublication(release));
  const verify = options.verify ?? (() => verifyClawhubRelease(release));
  const wait = options.sleep ?? sleep;
  const log = options.log ?? console.log;
  let state = await read();
  if (state.state === "absent") {
    await options.publish();
    state = await read();
  }
  for (let attempt = 0; attempt <= (options.polls ?? 60); attempt++) {
    if (state.state === "published") {
      await verify();
      log(`Verified ${release.name}@${release.version} published on ClawHub from ${release.commit}.`);
      return;
    }
    if (state.state !== "pending") throw new Error(`ClawHub publication is ${state.state}; inspect the registry diagnostics.`);
    if (attempt === (options.polls ?? 60)) break;
    log(`ClawHub ${release.name}@${release.version} is pending ${state.stage ?? "security checks"}; waiting without uploading again.`);
    await wait(30000);
    state = await read();
  }
  throw new Error("ClawHub publication is still pending after the publication deadline.");
}

function verifyNpmRelease(release, metadata) {
  if (metadata.name !== release.name || metadata.version !== release.version || metadata.gitHead !== release.commit) {
    throw new Error("Published npm version does not match the checked-out release commit.");
  }
}

export async function ensureNpmRelease(release, options) {
  const read = options.read ?? (() => readNpmRelease(release));
  const wait = options.sleep ?? sleep;
  const log = options.log ?? console.log;
  const existing = await read();
  if (existing) {
    verifyNpmRelease(release, existing);
    log(`${release.name}@${release.version} already published from ${release.commit}; verified, skipping npm write.`);
    return "already-published";
  }
  if (options.recovery) throw new Error("Release is not published to npm; ClawHub recovery cannot publish npm.");

  let publishError;
  try {
    await options.publish();
  } catch (error) {
    publishError = error;
    log("npm publish failed; checking whether the exact release reached the registry before stopping.");
  }
  // Registry propagation can lag behind a successful upload. Do not repeat the
  // upload: verify its result instead, including when the connection was lost.
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt) await wait(attempt * 3000);
    const metadata = await read();
    if (metadata) {
      verifyNpmRelease(release, metadata);
      log(`Verified ${release.name}@${release.version} on npm.`);
      return "published";
    }
  }
  throw publishError ?? new Error("npm publish returned success but its release could not be verified.");
}

export async function retryClawhub(operation, options = {}) {
  const wait = options.sleep ?? sleep;
  const log = options.log ?? console.error;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      return await operation();
    } catch (error) {
      if (attempt === 4 || !/too many writes|rate.?limit|HTTP 429/i.test(error.message)) throw error;
      const seconds = Math.min(Number(error.message.match(/reset in (\d+)s/i)?.[1] ?? 30), 60) + 1;
      log(`ClawHub throttled; retrying in ${seconds}s (attempt ${attempt}/4).`);
      await wait(seconds * 1000);
    }
  }
}
