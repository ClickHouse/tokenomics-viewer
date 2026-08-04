"use strict";

const assert = require("node:assert/strict");
const ChildProcess = require("node:child_process");
const fs = require("node:fs/promises");
const Os = require("node:os");
const Path = require("node:path");
const test = require("node:test");
const Util = require("node:util");

const execFile = Util.promisify(ChildProcess.execFile);
const root = Path.resolve(__dirname, "..");

test("one-line installer is offline-testable, repeatable, and preserves data", async () => {
  const temporary = await fs.mkdtemp(Path.join(Os.tmpdir(), "tokenomics-installer-"));
  const home = Path.join(temporary, "home with ' quote");
  const installRoot = Path.join(home, ".local", "share", "tokenomics-viewer");
  const binDir = Path.join(home, ".local", "bin");
  const launcherConfiguration = Path.join(home, "Library", "Application Support", "Tokenomics Viewer", "tokenomics-launch.json");
  const env = {
    ...process.env,
    HOME: home,
    TOKENOMICS_SOURCE_DIR: root,
    TOKENOMICS_INSTALL_ROOT: installRoot,
    TOKENOMICS_BIN_DIR: binDir,
    TOKENOMICS_NODE_BIN: process.execPath,
    TOKENOMICS_NO_LAUNCH: "1",
    TOKENOMICS_MACOS_LAUNCHER_CONFIG: launcherConfiguration,
  };

  await fs.mkdir(Path.join(installRoot, ".install-lock"), { recursive: true });
  await fs.writeFile(Path.join(installRoot, ".install-lock", "pid"), "99999999\n");
  const first = await execFile("/bin/sh", [Path.join(root, "install.sh")], { env });
  assert.match(first.stdout, /Tokenomics Viewer installed/);
  assert.equal((await fs.lstat(Path.join(installRoot, "current"))).isSymbolicLink(), true);
  assert.equal((await fs.stat(Path.join(binDir, "tokenomics"))).mode & 0o111, 0o111);
  assert.equal((await fs.stat(Path.join(binDir, "tokenomics-launch"))).mode & 0o111, 0o111);
  assert.deepEqual(JSON.parse(await fs.readFile(launcherConfiguration, "utf8")), {
    schema: 1,
    command: Path.join(binDir, "tokenomics-launch"),
    args: [],
  });

  const help = await execFile(Path.join(binDir, "tokenomics-launch"), ["--help"], { env });
  assert.match(help.stdout, /ClickHouse.*default/i);
  assert.match(help.stdout, /--no-clickhouse/);
  assert.doesNotMatch(help.stdout, /reset-clickhouse-choice/);

  const dataMarker = Path.join(installRoot, "persistent-data-marker");
  await fs.writeFile(dataMarker, "keep me\n");
  const previousRelease = await fs.realpath(Path.join(installRoot, "current"));
  const second = await execFile("/bin/sh", [Path.join(root, "install.sh"), "--help"], {
    env: { ...env, TOKENOMICS_NO_LAUNCH: "0" },
  });
  assert.match(second.stdout, /ClickHouse.*default/i, "installer must forward launcher flags");
  const nextRelease = await fs.realpath(Path.join(installRoot, "current"));

  assert.notEqual(nextRelease, previousRelease);
  assert.equal(await fs.readFile(dataMarker, "utf8"), "keep me\n");
  assert.equal(await fs.readFile(Path.join(nextRelease, "package.json"), "utf8"), await fs.readFile(Path.join(root, "package.json"), "utf8"));

  await fs.mkdir(Path.join(installRoot, ".install-lock"));
  await fs.writeFile(Path.join(installRoot, ".install-lock", "pid"), `${process.pid}\n`);
  await assert.rejects(
    execFile("/bin/sh", [Path.join(root, "install.sh")], { env }),
    /another installation is already running/,
  );
});
