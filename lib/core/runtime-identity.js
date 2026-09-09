"use strict";

const Crypto = require("node:crypto");
const Fs = require("node:fs");
const Path = require("node:path");

const RUNTIME_IDENTITY_PATHS = ["app.js", "launcher.js", "package.json", "lib", "public"];

function addPathToHash(hash, root, relativePath) {
  const absolutePath = Path.join(root, relativePath);
  const stat = Fs.lstatSync(absolutePath);
  if (stat.isDirectory()) {
    for (const entry of Fs.readdirSync(absolutePath).sort()) {
      addPathToHash(hash, root, Path.join(relativePath, entry));
    }
    return;
  }
  if (!stat.isFile()) return;
  hash.update(relativePath.split(Path.sep).join("/"));
  hash.update("\0");
  hash.update(Fs.readFileSync(absolutePath));
  hash.update("\0");
}

function runtimeIdentity(root = Path.resolve(__dirname, "../..")) {
  const hash = Crypto.createHash("sha256");
  for (const relativePath of RUNTIME_IDENTITY_PATHS) addPathToHash(hash, root, relativePath);
  return `sha256:${hash.digest("hex")}`;
}

const RUNTIME_ID = runtimeIdentity();

module.exports = {
  RUNTIME_ID,
  RUNTIME_IDENTITY_PATHS,
  runtimeIdentity,
};
