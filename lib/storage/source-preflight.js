"use strict";

const fsp = require("node:fs/promises");
const { listZipEntries } = require("../ingest/archive");
const { sameAnalyticsDerivation, sameSourceFingerprint } = require("../core/derivation");

async function prepareStorageInputs(inputs, { existingFingerprint, sourceFingerprint }) {
  const preparedInputs = [];
  const changedSourcePaths = new Set();
  let totalSources = 0;
  let reportInvalidated = false;
  for (const input of inputs) {
    const stat = await fsp.stat(input.path);
    if (input.kind === "jsonl") {
      totalSources += 1;
      const fingerprint = sourceFingerprint({ kind: "jsonl", size: stat.size, mtimeMs: stat.mtimeMs });
      const previousFingerprint = await existingFingerprint(input.path);
      if (previousFingerprint && !sameAnalyticsDerivation(previousFingerprint, fingerprint)) reportInvalidated = true;
      if (!sameSourceFingerprint(previousFingerprint, fingerprint)) changedSourcePaths.add(input.path);
      preparedInputs.push({ ...input, stat });
      continue;
    }
    if (input.kind !== "zip") {
      preparedInputs.push({ ...input, stat });
      continue;
    }

    const entries = (await listZipEntries(input.path))
      .filter((entry) => entry.fileName.endsWith(".jsonl"))
      .sort((a, b) => a.fileName.localeCompare(b.fileName));
    totalSources += entries.length;
    for (const entry of entries) {
      const sourcePath = `${input.path}:${entry.fileName}`;
      const fingerprint = sourceFingerprint({
        kind: "zip-entry",
        archiveSize: stat.size,
        archiveMtimeMs: stat.mtimeMs,
        entry: entry.fileName,
        compressedSize: entry.compressedSize,
        uncompressedSize: entry.uncompressedSize,
        localHeaderOffset: entry.localHeaderOffset,
      });
      const previousFingerprint = await existingFingerprint(sourcePath);
      if (previousFingerprint && !sameAnalyticsDerivation(previousFingerprint, fingerprint)) reportInvalidated = true;
      if (!sameSourceFingerprint(previousFingerprint, fingerprint)) changedSourcePaths.add(sourcePath);
    }
    preparedInputs.push({ ...input, stat, entries });
  }
  return { preparedInputs, changedSourcePaths, totalSources, reportInvalidated };
}

module.exports = { prepareStorageInputs };
