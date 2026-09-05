"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const Path = require("node:path");
const test = require("node:test");
const {
  APPEND_CURSOR_VERSION,
  inspectAppendFile,
  validateAppendCursor,
} = require("../lib/ingest/append-cursor");

function storedCursor(snapshot, parserCheckpoint = { kind: "codex" }) {
  return {
    cursor_version: APPEND_CURSOR_VERSION,
    segment_end: snapshot.completeOffset,
    cursor_guard: snapshot.guard,
    cursor_prefix_guard: snapshot.prefixGuard,
    parser_checkpoint: JSON.stringify(parserCheckpoint),
    file_device: snapshot.device,
    file_inode: snapshot.inode,
  };
}

test("append cursor advances only through complete JSONL records", async () => {
  const dir = fs.mkdtempSync(Path.join(os.tmpdir(), "tokenomics-append-cursor-test-"));
  const filename = Path.join(dir, "session.jsonl");
  const firstLine = `${JSON.stringify({ id: 1 })}\n`;
  fs.writeFileSync(filename, `${firstLine}{"id":`);

  const first = await inspectAppendFile(filename);
  assert.equal(first.completeOffset, Buffer.byteLength(firstLine));

  fs.appendFileSync(filename, "2}\n");
  const appended = await inspectAppendFile(filename);
  const appendPlan = await validateAppendCursor(filename, storedCursor(first), appended);
  assert.deepEqual(appendPlan, {
    mode: "append",
    reason: "verified-append",
    start: first.completeOffset,
    end: appended.completeOffset,
  });
});

test("append cursor fails closed on guarded-prefix mutation, truncation, and rotation", async () => {
  const dir = fs.mkdtempSync(Path.join(os.tmpdir(), "tokenomics-append-guard-test-"));
  const filename = Path.join(dir, "session.jsonl");
  fs.writeFileSync(filename, `${JSON.stringify({ id: "original" })}\n`);
  const original = await inspectAppendFile(filename);
  const cursor = storedCursor(original);

  fs.writeFileSync(filename, `${JSON.stringify({ id: "mutated!" })}\n${JSON.stringify({ id: 2 })}\n`);
  assert.equal((await validateAppendCursor(filename, cursor, await inspectAppendFile(filename))).reason, "guard-mismatch");

  fs.truncateSync(filename, 0);
  assert.equal((await validateAppendCursor(filename, cursor, await inspectAppendFile(filename))).reason, "truncated");

  fs.renameSync(filename, `${filename}.old`);
  fs.writeFileSync(filename, `${JSON.stringify({ id: "replacement" })}\n`);
  assert.equal((await validateAppendCursor(filename, cursor, await inspectAppendFile(filename))).reason, "missing-or-incompatible-cursor");
});

test("append cursor detects an earlier prefix rewrite outside the tail guard", async () => {
  const dir = fs.mkdtempSync(Path.join(os.tmpdir(), "tokenomics-prefix-guard-test-"));
  const filename = Path.join(dir, "session.jsonl");
  const lines = Array.from({ length: 700 }, (_, index) => JSON.stringify({ id: index, payload: "x".repeat(40) }));
  fs.writeFileSync(filename, `${lines.join("\n")}\n`);
  const original = await inspectAppendFile(filename);
  const cursor = storedCursor(original);

  const handle = fs.openSync(filename, "r+");
  try {
    fs.writeSync(handle, Buffer.from("MUTATED!"), 0, 8, 128);
  } finally {
    fs.closeSync(handle);
  }
  fs.appendFileSync(filename, `${JSON.stringify({ id: "tail" })}\n`);

  const plan = await validateAppendCursor(filename, cursor, await inspectAppendFile(filename));
  assert.equal(plan.reason, "prefix-guard-mismatch");
});
