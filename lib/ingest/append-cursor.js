"use strict";

const { createHash } = require("node:crypto");
const fsp = require("node:fs/promises");

const APPEND_CURSOR_VERSION = 2;
const APPEND_GUARD_BYTES = 4 * 1024;
const APPEND_PREFIX_SAMPLES = 4;
const NEWLINE_SCAN_BYTES = 64 * 1024;

async function readRange(filename, start, length) {
  if (length <= 0) return Buffer.alloc(0);
  const handle = await fsp.open(filename, "r");
  try {
    const buffer = Buffer.allocUnsafe(length);
    const { bytesRead } = await handle.read(buffer, 0, length, start);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

async function lastCompleteJsonlOffset(filename, size) {
  let end = Number(size) || 0;
  while (end > 0) {
    const start = Math.max(0, end - NEWLINE_SCAN_BYTES);
    const buffer = await readRange(filename, start, end - start);
    const newline = buffer.lastIndexOf(0x0a);
    if (newline >= 0) return start + newline + 1;
    end = start;
  }
  return 0;
}

async function appendGuard(filename, offset) {
  const end = Number(offset) || 0;
  const start = Math.max(0, end - APPEND_GUARD_BYTES);
  const buffer = await readRange(filename, start, end - start);
  return createHash("sha256").update(buffer).digest("hex");
}

async function appendPrefixGuard(filename, offset) {
  const end = Number(offset) || 0;
  const hash = createHash("sha256");
  hash.update(String(end));
  if (end <= 0) return hash.digest("hex");
  const window = Math.min(APPEND_GUARD_BYTES, end);
  const maxStart = Math.max(0, end - window);
  const starts = new Set([0]);
  for (let sample = 1; sample < APPEND_PREFIX_SAMPLES; sample += 1) {
    starts.add(Math.floor(maxStart * sample / APPEND_PREFIX_SAMPLES));
  }
  for (const start of [...starts].sort((a, b) => a - b)) {
    hash.update(String(start));
    hash.update(await readRange(filename, start, window));
  }
  return hash.digest("hex");
}

async function inspectAppendFile(filename, suppliedStat = null) {
  const stat = suppliedStat || await fsp.stat(filename);
  const completeOffset = await lastCompleteJsonlOffset(filename, stat.size);
  return {
    version: APPEND_CURSOR_VERSION,
    size: Number(stat.size),
    mtimeMs: Number(stat.mtimeMs),
    device: String(stat.dev),
    inode: String(stat.ino),
    completeOffset,
    guard: await appendGuard(filename, completeOffset),
    prefixGuard: await appendPrefixGuard(filename, completeOffset),
  };
}

async function validateAppendCursor(filename, previous, current) {
  if (
    !previous ||
    Number(previous.cursor_version) !== APPEND_CURSOR_VERSION ||
    !previous.parser_checkpoint ||
    !previous.cursor_prefix_guard ||
    String(previous.file_device) !== current.device ||
    String(previous.file_inode) !== current.inode
  ) {
    return { mode: "full", reason: "missing-or-incompatible-cursor" };
  }

  const cursorOffset = Number(previous.segment_end);
  if (!Number.isSafeInteger(cursorOffset) || cursorOffset < 0 || current.completeOffset < cursorOffset) {
    return { mode: "full", reason: "truncated" };
  }
  const guard = await appendGuard(filename, cursorOffset);
  if (guard !== previous.cursor_guard) return { mode: "full", reason: "guard-mismatch" };
  const prefixGuard = await appendPrefixGuard(filename, cursorOffset);
  if (prefixGuard !== previous.cursor_prefix_guard) return { mode: "full", reason: "prefix-guard-mismatch" };
  if (current.completeOffset === cursorOffset) return { mode: "unchanged", reason: "no-complete-record" };
  return { mode: "append", reason: "verified-append", start: cursorOffset, end: current.completeOffset };
}

module.exports = {
  APPEND_CURSOR_VERSION,
  APPEND_GUARD_BYTES,
  appendGuard,
  appendPrefixGuard,
  inspectAppendFile,
  lastCompleteJsonlOffset,
  validateAppendCursor,
};
