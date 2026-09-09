"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const Os = require("node:os");
const Path = require("node:path");
const test = require("node:test");
const { RUNTIME_ID, runtimeIdentity } = require("../lib/core/runtime-identity");

test("runtime identity is deterministic and changes with shipped backend content", async (t) => {
  const root = Path.resolve(__dirname, "..");
  assert.equal(runtimeIdentity(root), RUNTIME_ID);

  const temporary = await fs.mkdtemp(Path.join(Os.tmpdir(), "tokenomics-runtime-id-"));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  await Promise.all([
    fs.mkdir(Path.join(temporary, "lib")),
    fs.mkdir(Path.join(temporary, "public")),
  ]);
  await Promise.all([
    fs.writeFile(Path.join(temporary, "app.js"), "app\n"),
    fs.writeFile(Path.join(temporary, "launcher.js"), "launcher\n"),
    fs.writeFile(Path.join(temporary, "package.json"), "{}\n"),
    fs.writeFile(Path.join(temporary, "lib", "module.js"), "one\n"),
    fs.writeFile(Path.join(temporary, "public", "index.html"), "html\n"),
  ]);
  const first = runtimeIdentity(temporary);
  assert.equal(runtimeIdentity(temporary), first);
  await fs.writeFile(Path.join(temporary, "lib", "module.js"), "two\n");
  assert.notEqual(runtimeIdentity(temporary), first);
});
