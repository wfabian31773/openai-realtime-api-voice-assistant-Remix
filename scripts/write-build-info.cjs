#!/usr/bin/env node
/**
 * Writes build-info.json at BUILD time: which commit this bundle was built
 * from. Read at runtime by server/buildInfo.ts, served at /api/build-info, and
 * stamped on every call row as call_logs.build_sha (Stage C, A6).
 *
 * WHY THIS FILE EXISTS. build-info.json used to be committed, and the
 * deployment build in .replit never rewrote it, so from 2026-08-12 every
 * deployment reported `3f4ec74` as its SHA — two months of builds wearing one
 * stale commit. A stale SHA is worse than none, because it is believed. So:
 *
 *  1. The old file is DELETED FIRST. It is gitignored now and would otherwise
 *     survive in the workspace from the previous build; if anything below
 *     fails, there is no file and the runtime reports null ("unknown").
 *  2. Every field is null when it cannot be read. Nothing is guessed.
 *  3. It fails the build in exactly one case: an old file it could neither
 *     remove nor replace is still there, because that build would advertise
 *     the previous deployment's SHA (Codex, #364). Otherwise it never fails
 *     the build: a deploy that cannot say its SHA is still a deploy; it just
 *     says "unknown".
 *
 * `traceable` answers whether this commit is on GitHub's main: true or false
 * from LOCAL git only (`merge-base --is-ancestor HEAD origin/main`), null when
 * there is no origin/main ref to compare with. No network fetch, so a build
 * can never hang or fail on GitHub. A workspace commit that never reached
 * GitHub reads false — the SHA is still the true SHA of what was built.
 *
 * A DIRTY WORKSPACE HAS NO SHA (Codex, #364). Replit publishes from the
 * workspace, and a tracked edit or an untracked source file there means the
 * bundle is NOT the commit HEAD names. So the SHA is reported only when
 * `git status` confirms the tree is clean; dirty (or a status that cannot be
 * read) writes gitSha/gitShaFull null, traceable false, dirty true, and the
 * commit underneath as baseShaFull for a person to read — never as the build.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

function git(args) {
  try {
    return execFileSync("git", args, { stdio: ["ignore", "pipe", "ignore"], timeout: 5000 })
      .toString()
      .trim();
  } catch {
    return null;
  }
}

function isAncestorOfMain() {
  if (git(["rev-parse", "--verify", "--quiet", "origin/main"]) === null) return null;
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", "HEAD", "origin/main"], {
      stdio: "ignore",
      timeout: 5000,
    });
    return true;
  } catch (error) {
    // Exit status 1 is "not an ancestor"; anything else is "could not tell".
    return error && error.status === 1 ? false : null;
  }
}

/** true = uncommitted changes (or status unreadable), false = clean. Ignored files never count. */
function isDirty() {
  const status = git(["status", "--porcelain", "--untracked-files=normal"]);
  return status === null ? true : status.length > 0;
}

function buildInfo() {
  const full = git(["rev-parse", "HEAD"]);
  const sha = full && /^[0-9a-f]{40}$/.test(full) ? full : null;
  if (sha && isDirty()) {
    return { builtAt: new Date().toISOString(), gitSha: null, gitShaFull: null, traceable: false, dirty: true, baseShaFull: sha };
  }
  return {
    builtAt: new Date().toISOString(),
    gitSha: sha ? sha.slice(0, 7) : null,
    gitShaFull: sha,
    traceable: sha ? isAncestorOfMain() : null,
    dirty: sha ? false : null,
  };
}

/** true when the build may proceed; false only when a stale file survives. */
function main(out = path.join(process.cwd(), "build-info.json")) {
  try {
    fs.rmSync(out, { force: true });
  } catch {
    /* tried below: the write replaces it, or the stale check catches it */
  }
  try {
    const info = buildInfo();
    fs.writeFileSync(out, JSON.stringify(info));
    console.log(
      info.dirty
        ? `[build-info] workspace has uncommitted changes on ${info.baseShaFull.slice(0, 7)}; build SHA reported as unknown`
        : `[build-info] ${info.gitSha ?? "unknown sha"} traceable=${info.traceable}`,
    );
    return true;
  } catch (error) {
    console.warn(`[build-info] not written: ${error && error.message}`);
  }
  if (fs.existsSync(out)) {
    console.error(
      "[build-info] an old build-info.json could not be removed or replaced; failing the build so it cannot report the previous deployment's SHA",
    );
    return false;
  }
  return true;
}

if (require.main === module && !main()) process.exitCode = 1;

module.exports = { buildInfo, main };
