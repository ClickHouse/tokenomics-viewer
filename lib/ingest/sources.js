"use strict";

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const Path = require("node:path");
const readline = require("node:readline");
const zlib = require("node:zlib");
const { newReport } = require("../core/report-model");
const {
  codexTraceIds,
  normalizeCodexUuid,
  sameCodexUuid,
} = require("../core/usage");
const { finalizeRateLimits } = require("../core/rate-limits");
const { createLineProcessor } = require("./parser");
const { listZipEntries, openZipEntryStream } = require("./archive");

function resolveOmpAgentDir(home) {
  // A1: PI_CODING_AGENT_DIR moves ~/.omp/agent outright (highest precedence
  // among omp-native vars). PI_CONFIG_DIR renames the config root (~/.omp).
  if (process.env.PI_CODING_AGENT_DIR) {
    return Path.resolve(process.env.PI_CODING_AGENT_DIR);
  }
  const configDir = process.env.PI_CONFIG_DIR || ".omp";
  return Path.join(home, configDir, "agent");
}

function createIngestSources({
  finishSession,
  formatBytes,
  formatInt,
  logProgress,
  startSession,
}) {
  function isJsonlPath(path) {
    return path.endsWith(".jsonl") || path.endsWith(".jsonl.zst");
  }

  function preferPlainRollouts(paths) {
    const available = new Set(paths);
    return paths.filter((path) => !path.endsWith(".jsonl.zst") || !available.has(path.slice(0, -4)));
  }

  function openJsonlStream(filename) {
    if (!filename.endsWith(".jsonl.zst")) {
      return fs.createReadStream(filename, { encoding: "utf8" });
    }
    const input = fs.createReadStream(filename);
    const decoder = zlib.createZstdDecompress();
    input.on("error", (error) => decoder.destroy(error));
    decoder.on("close", () => input.destroy());
    input.pipe(decoder);
    decoder.setEncoding("utf8");
    return decoder;
  }

  async function processJsonlFile(filename, report, options) {
    report.sources.files += 1;
    const stat = await fsp.stat(filename);
    const session = startSession(report, options, {
      kind: "jsonl",
      path: filename,
      sizeBytes: stat.size,
    });
    const processor = createLineProcessor(report, options, filename, session);
    const stream = openJsonlStream(filename);
    try {
      await processLineStream(stream, processor, session);
    } finally {
      finishSession(session, options);
    }
  }

  async function processLineStream(stream, processor, session = null) {
    const rl = readline.createInterface({
      input: stream,
      crlfDelay: Infinity,
    });
    let lineNo = 0;
    for await (const line of rl) {
      lineNo += 1;
      if (session) session.lines += 1;
      processor(line, lineNo);
      if (typeof processor.afterLine === "function") {
        const drain = processor.afterLine();
        if (drain && typeof drain.then === "function") await drain;
      }
    }
    if (typeof processor.finalize === "function") {
      const drain = processor.finalize();
      if (drain && typeof drain.then === "function") await drain;
    }
  }

  async function processZipEntry(zipFile, entry, report, options) {
    report.sources.zipEntries += 1;
    const session = startSession(report, options, {
      kind: "zip-entry",
      path: `${zipFile}:${entry.fileName}`,
      archivePath: zipFile,
      entryName: entry.fileName,
      sizeBytes: entry.uncompressedSize,
      compressedSizeBytes: entry.compressedSize,
    });
    const stream = await openZipEntryStream(zipFile, entry);
    const processor = createLineProcessor(report, options, `${zipFile}:${entry.fileName}`, session);
    try {
      await processLineStream(stream, processor, session);
    } finally {
      finishSession(session, options);
    }
  }

  async function processZipFile(zipFile, report, options, limiter) {
    report.sources.zipFiles += 1;
    const stat = await fsp.stat(zipFile);
    const entries = (await listZipEntries(zipFile))
      .filter((entry) => entry.fileName.endsWith(".jsonl"))
      .sort((a, b) => a.fileName.localeCompare(b.fileName));
    logProgress(options, `[zip] ${zipFile} size=${formatBytes(stat.size)} entries=${formatInt(entries.length)}`);
    for (const entry of entries) {
      if (!limiter.take()) {
        report.sources.skippedFiles += 1;
        continue;
      }
      await processZipEntry(zipFile, entry, report, options);
    }
  }

  async function walkFiles(root, predicate, out = []) {
    let entries;
    try {
      entries = await fsp.readdir(root, { withFileTypes: true });
    } catch (error) {
      if (error.code === "ENOENT") return out;
      throw error;
    }

    for (const entry of entries) {
      const fullPath = Path.join(root, entry.name);
      if (entry.isDirectory()) {
        await walkFiles(fullPath, predicate, out);
      } else if (entry.isFile() && predicate(fullPath)) {
        out.push(fullPath);
      }
    }
    return out;
  }

  async function discoverInputs(options) {
    const inputs = [];
    const home = options.home;
    const source = options.source;

    if (options.paths.length > 0) {
      for (const inputPath of options.paths) {
        await addInputPath(Path.resolve(inputPath), inputs, options.includeArchives);
      }
      return sortInputs(inputs);
    }

    if (source === "all" || source === "claude") {
      const claudeRoot = Path.join(home, ".claude", "projects");
      const files = await walkFiles(claudeRoot, (p) => p.endsWith(".jsonl"));
      inputs.push(...files.map((p) => ({ kind: "jsonl", path: p })));
    }

    if (source === "all" || source === "codex") {
      const codexHome = options.codexHome || Path.join(home, ".codex");
      const codexRoot = Path.join(codexHome, "sessions");
      const files = preferPlainRollouts(await walkFiles(codexRoot, isJsonlPath));
      inputs.push(...files.map((p) => ({ kind: "jsonl", path: p })));

      if (options.includeArchives) {
        const archivesRoot = Path.join(codexHome, "archived_sessions");
        const archiveFiles = await walkFiles(archivesRoot, (p) => isJsonlPath(p) || p.endsWith(".zip"));
        const rollouts = preferPlainRollouts(archiveFiles.filter(isJsonlPath));
        const zipFiles = archiveFiles.filter((p) => p.endsWith(".zip"));
        inputs.push(...rollouts.map((p) => ({ kind: "jsonl", path: p })));
        inputs.push(...zipFiles.map((p) => ({ kind: "zip", path: p })));
      }
    }

    if (source === "all" || source === "omp") {
      const ompAgentDir = options.ompHome || resolveOmpAgentDir(home);
      const ompRoot = Path.join(ompAgentDir, "sessions");
      // A6: include ALL .jsonl in the tree — parent transcripts AND omp's own
      // subagent sidecar files (sessions/<slug>/<ts>_<uuid>/*.jsonl).
      const files = await walkFiles(ompRoot, (p) => p.endsWith(".jsonl"));
      inputs.push(...files.map((p) => ({ kind: "jsonl", path: p })));
    }

    return sortInputs(inputs);
  }

  function codexJsonlSource(path) {
    return {
      kind: "jsonl",
      label: path,
      sourcePath: path,
      archivePath: null,
      entryName: null,
      openStream: () => openJsonlStream(path),
    };
  }

  function codexZipEntrySource(archivePath, entry) {
    return {
      kind: "zip-entry",
      label: `${archivePath}:${entry.fileName}`,
      sourcePath: `${archivePath}:${entry.fileName}`,
      archivePath,
      entryName: entry.fileName,
      openStream: () => openZipEntryStream(archivePath, entry),
    };
  }

  function storedCodexZipEntrySource(sourcePath, archivePath, entryName) {
    return {
      kind: "zip-entry",
      label: sourcePath,
      sourcePath,
      archivePath,
      entryName,
      openStream: async () => {
        const entry = (await listZipEntries(archivePath)).find((candidate) => candidate.fileName === entryName);
        if (!entry) throw new Error(`Archived Codex source is missing: ${sourcePath}`);
        return openZipEntryStream(archivePath, entry);
      },
    };
  }

  function storedCodexSessionHeader(row) {
    const id = normalizeCodexUuid(row.sessionId ?? row.session_id);
    const forkedFromId = normalizeCodexUuid(row.parentSessionId ?? row.parent_session_id);
    const kind = row.kind;
    const sourcePath = row.sourcePath ?? row.source_path;
    const archivePath = row.archivePath ?? row.archive_path;
    const entryName = row.entryName ?? row.entry_name;
    let source = null;

    if (kind === "jsonl" && sourcePath) {
      source = codexJsonlSource(sourcePath);
    } else if (kind === "zip-entry" && sourcePath && archivePath && entryName) {
      source = storedCodexZipEntrySource(sourcePath, archivePath, entryName);
    }

    return id && source ? { id, forkedFromId, source } : null;
  }

  async function collectCodexSources(inputs, sourcePaths = null) {
    const sources = [];
    for (const input of inputs) {
      if (input.kind === "jsonl") {
        if (!sourcePaths || sourcePaths.has(input.path)) sources.push(codexJsonlSource(input.path));
        continue;
      }
      if (input.kind !== "zip") continue;

      const entries = (input.entries || await listZipEntries(input.path))
        .filter((entry) => entry.fileName.endsWith(".jsonl"));
      for (const entry of entries) {
        const sourcePath = `${input.path}:${entry.fileName}`;
        if (!sourcePaths || sourcePaths.has(sourcePath)) sources.push(codexZipEntrySource(input.path, entry));
      }
    }
    return sources;
  }

  async function readCodexSessionHeader(source) {
    const stream = await source.openStream();
    const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
    try {
      for await (const line of lines) {
        if (!line.trim()) continue;
        const json = JSON.parse(line);
        const id = normalizeCodexUuid(json.payload?.id);
        if (json.type !== "session_meta" || !id) return null;
        return {
          id,
          forkedFromId: normalizeCodexUuid(json.payload.forked_from_id),
          cwd: typeof json.payload.cwd === "string" ? json.payload.cwd : null,
          source,
        };
      }
      return null;
    } catch {
      return null;
    } finally {
      lines.close();
      stream.destroy();
    }
  }

  async function collectCodexOwnTraceIds(
    source,
    inheritedTraces,
    inheritedSessionId,
    childCwd = null,
    parentMissing = false,
  ) {
    const ownTraces = new Set();
    let currentChildBoundaryTraces = null;
    let skippingInheritedReplay = false;
    let sawInheritedReplay = false;
    let sawChildCwdEvidence = false;
    let sawUsageBeforeChildBoundary = false;
    const tracesBeforeChildBoundary = new Set();
    const tracesByTurn = new Map();
    const missingParentBoundary = Boolean(parentMissing && inheritedSessionId);

    const rememberTraceIds = (traceIds, turnId) => {
      if (turnId) {
        const turnTraces = tracesByTurn.get(turnId) || new Set();
        for (const traceId of traceIds) turnTraces.add(traceId);
        tracesByTurn.set(turnId, turnTraces);
      }
      if (missingParentBoundary && !currentChildBoundaryTraces) {
        for (const traceId of traceIds) tracesBeforeChildBoundary.add(traceId);
      }
    };

    const matchingChildBoundary = (json, traceIds) => {
      if (!missingParentBoundary || typeof childCwd !== "string") return null;
      const payload = json.payload || {};
      const isBoundaryRecord = (
        json.type === "turn_context" ||
        (json.type === "event_msg" && payload.type === "task_started")
      );
      if (!isBoundaryRecord || typeof payload.cwd !== "string") return null;
      if (Path.normalize(payload.cwd) !== Path.normalize(childCwd)) return null;

      return {
        turnId: typeof payload.turn_id === "string" ? payload.turn_id : null,
        traceIds,
      };
    };
    let stream;
    try {
      stream = await source.openStream();
    } catch {
      return { ownTraces, sawInheritedReplay, currentChildBoundaryTraces };
    }
    const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
    try {
      for await (const line of lines) {
        if (!line.trim()) continue;
        let json;
        try {
          json = JSON.parse(line);
        } catch {
          continue;
        }
        if (json.type === "session_meta" && inheritedSessionId && sameCodexUuid(json.payload?.id, inheritedSessionId)) {
          skippingInheritedReplay = true;
          sawInheritedReplay = true;
          currentChildBoundaryTraces = null;
          continue;
        }
        const traceIds = codexTraceIds(json);
        const turnId = typeof json.payload?.turn_id === "string" ? json.payload.turn_id : null;
        if (
          missingParentBoundary &&
          !currentChildBoundaryTraces &&
          json.type === "event_msg" &&
          json.payload?.type === "token_count"
        ) {
          sawUsageBeforeChildBoundary = true;
        }
        rememberTraceIds(traceIds, turnId);
        if (!currentChildBoundaryTraces) {
          const childBoundary = matchingChildBoundary(json, traceIds);
          if (childBoundary) {
            sawChildCwdEvidence = true;
            if (childBoundary.turnId) {
              const boundaryTraces = new Set(childBoundary.traceIds);
              const turnTraces = tracesByTurn.get(childBoundary.turnId) || new Set();
              for (const traceId of turnTraces) boundaryTraces.add(traceId);
              boundaryTraces.add(`turn:${childBoundary.turnId}`);
              currentChildBoundaryTraces = boundaryTraces;
              for (const traceId of boundaryTraces) tracesBeforeChildBoundary.delete(traceId);
              if (tracesBeforeChildBoundary.size > 0 || sawUsageBeforeChildBoundary) {
                sawInheritedReplay = true;
                for (const traceId of tracesBeforeChildBoundary) ownTraces.delete(traceId);
              }
            }
          }
        }
        if (traceIds.some((traceId) => inheritedTraces.has(traceId))) {
          skippingInheritedReplay = true;
          sawInheritedReplay = true;
          continue;
        }
        if (skippingInheritedReplay) {
          if (traceIds.length === 0) continue;
          skippingInheritedReplay = false;
        }
        if (
          sawInheritedReplay &&
          currentChildBoundaryTraces === null &&
          ((json.type === "turn_context" && json.payload?.turn_id) ||
            (json.type === "event_msg" && json.payload?.type === "task_started" && json.payload.turn_id))
        ) {
          currentChildBoundaryTraces = new Set(traceIds);
        }
        for (const traceId of traceIds) ownTraces.add(traceId);
      }
    } catch {
      return { ownTraces, sawInheritedReplay, currentChildBoundaryTraces };
    } finally {
      lines.close();
      stream.destroy();
    }
    if (
      missingParentBoundary &&
      !currentChildBoundaryTraces &&
      !(sawChildCwdEvidence && tracesBeforeChildBoundary.size === 0)
    ) {
      // A missing parent with no explicit child boundary is ambiguous. Keep
      // the source fail-closed instead of guessing from UUID shape or size.
      sawInheritedReplay = true;
    }
    return { ownTraces, sawInheritedReplay, currentChildBoundaryTraces };
  }

  async function prepareCodexForkRegistry(inputs, options) {
    if (options.codexForkRegistry) return options.codexForkRegistry;
    const codexInputs = await collectCodexSources(inputs, options.codexSourcePaths || null);
    const currentHeaders = [];
    for (const input of codexInputs) {
      const header = await readCodexSessionHeader(input);
      if (header) currentHeaders.push(header);
    }
    const persistedHeaders = (options.persistedCodexSessionHeaders || [])
      .map(storedCodexSessionHeader)
      .filter(Boolean);
    const headersBySession = new Map(persistedHeaders.map((header) => [header.id, header]));
    for (const header of currentHeaders) headersBySession.set(header.id, header);
    const parentSessionIds = new Set(currentHeaders.map((header) => header.forkedFromId).filter(Boolean));
    const tracesBySession = new Map();
    const replaySessions = new Set();
    const replayBoundariesBySession = new Map();
    const visiting = new Set();

    const collectSessionTraces = async (sessionId) => {
      if (tracesBySession.has(sessionId)) return tracesBySession.get(sessionId);
      if (visiting.has(sessionId)) return new Set();
      const header = headersBySession.get(sessionId);
      if (!header) return new Set();
      visiting.add(sessionId);
      const parentHeader = header.forkedFromId ? headersBySession.get(header.forkedFromId) : null;
      const inheritedTraces = header.forkedFromId
        ? await collectSessionTraces(header.forkedFromId)
        : new Set();
      const { ownTraces, sawInheritedReplay, currentChildBoundaryTraces } = await collectCodexOwnTraceIds(
        header.source,
        inheritedTraces,
        header.forkedFromId,
        header.cwd,
        Boolean(header.forkedFromId && !parentHeader),
      );
      if (sawInheritedReplay) replaySessions.add(sessionId);
      if (currentChildBoundaryTraces?.size > 0) {
        replayBoundariesBySession.set(sessionId, currentChildBoundaryTraces);
      }
      const traces = new Set(inheritedTraces);
      for (const traceId of ownTraces) traces.add(traceId);
      visiting.delete(sessionId);
      tracesBySession.set(sessionId, traces);
      return traces;
    };

    for (const parentSessionId of parentSessionIds) await collectSessionTraces(parentSessionId);
    for (const header of currentHeaders) await collectSessionTraces(header.id);
    return currentHeaders.length > 0
      ? { tracesBySession, replaySessions, replayBoundariesBySession, currentHeaders }
      : null;
  }

  async function processingOptionsWithCodexForkRegistry(options, inputs) {
    const registry = await prepareCodexForkRegistry(inputs, options);
    return registry ? { ...options, codexForkRegistry: registry } : options;
  }

  function sortInputs(inputs) {
    return inputs.sort((a, b) => {
      const byKind = a.kind.localeCompare(b.kind);
      if (byKind !== 0) return byKind;
      return a.path.localeCompare(b.path);
    });
  }

  async function addInputPath(inputPath, inputs, includeArchives) {
    const stat = await fsp.stat(inputPath);
    if (stat.isDirectory()) {
      const files = await walkFiles(inputPath, (p) => isJsonlPath(p) || (includeArchives && p.endsWith(".zip")));
      for (const file of preferPlainRollouts(files)) {
        inputs.push({ kind: file.endsWith(".zip") ? "zip" : "jsonl", path: file });
      }
    } else if (inputPath.endsWith(".zip")) {
      if (includeArchives) inputs.push({ kind: "zip", path: inputPath });
    } else if (isJsonlPath(inputPath)) {
      inputs.push({ kind: "jsonl", path: inputPath });
    }
  }

  function createLimiter(limit) {
    let used = 0;
    return {
      take() {
        if (!Number.isFinite(limit)) return true;
        if (used >= limit) return false;
        used += 1;
        return true;
      },
    };
  }

  async function buildReport(options) {
    const report = newReport();
    const inputs = await discoverInputs(options);
    const processingOptions = await processingOptionsWithCodexForkRegistry(options, inputs);
    const limiter = createLimiter(options.limitFiles);

    for (const input of inputs) {
      if (input.kind === "jsonl") {
        if (!limiter.take()) {
          report.sources.skippedFiles += 1;
          continue;
        }
        await processJsonlFile(input.path, report, processingOptions);
      } else if (input.kind === "zip") {
        await processZipFile(input.path, report, processingOptions, limiter);
      }
    }

    finalizeRateLimits(report);
    return report;
  }

  return {
    buildReport,
    createLimiter,
    discoverInputs,
    processJsonlFile,
    processZipEntry,
    processZipFile,
    processingOptionsWithCodexForkRegistry,
  };
}

module.exports = {
  createIngestSources,
  resolveOmpAgentDir,
};
