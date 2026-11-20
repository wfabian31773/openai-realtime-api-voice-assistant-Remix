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
 * EVERY NULL SAYS WHY (v255). From v144 to v254 every Replit publish read
 * buildSha null, and the cause could not be recovered: git's stderr is
 * suppressed here, and a missing git binary, a missing repository and an
 * unreadable HEAD all ended in the same null. So a null SHA now carries a
 * `reason` naming which one it was: `git_unavailable` (no git executable),
 * `not_a_repository` (git runs, but there is no repository, e.g. a build
 * that was not given the .git folder), `head_unreadable` (a repository with
 * no readable HEAD), `dirty` (uncommitted changes) or `status_unreadable`
 * (git status could not run). A clean commit carries `reason: null`.
 *
 * A DIRTY WORKSPACE HAS NO SHA (Codex, #364). Replit publishes from the
 * workspace, and a tracked edit or an untracked source file there means the
 * bundle is NOT the commit HEAD names. So the SHA is reported only when
 * `git status` confirms the tree is clean; dirty (or a status that cannot be
 * read) writes gitSha/gitShaFull null, traceable false, and the commit
 * underneath as baseShaFull for a person to read — never as the build.
 * `dirty` is true only when git status SAW changes; a status that could not
 * run writes `dirty: null`, because the state is unknown (Codex, #502).
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

/** "dirty" = uncommitted changes, "status_unreadable" = git status could not run, null = clean. Ignored files never count. */
function dirtiness() {
  const status = git(["status", "--porcelain", "--untracked-files=normal"]);
  if (status === null) return "status_unreadable";
  return status.length > 0 ? "dirty" : null;
}

/** A path as git compares it for GIT_CEILING_DIRECTORIES: absolute, symlinks resolved where they can be. */
function canonical(p) {
  try {
    return fs.realpathSync(path.resolve(p));
  } catch {
    return path.resolve(p);
  }
}

/**
 * Whether repository metadata is on disk where git would look: $GIT_DIR when
 * it is set, otherwise a `.git` in this directory or a parent, the walk git
 * itself does, which never moves up into a directory named in
 * GIT_CEILING_DIRECTORIES (Codex, #502). Read from the filesystem, not from
 * git, because git refuses a repository it cannot parse (a corrupt .git/HEAD
 * reads "not a git repository") and that must not be reported as a build that
 * was never given .git (Codex, #502).
 */
function gitMetadataPresent() {
  if (process.env.GIT_DIR) return fs.existsSync(process.env.GIT_DIR);
  const ceilings = new Set(
    (process.env.GIT_CEILING_DIRECTORIES || "")
      .split(path.delimiter)
      .filter((d) => path.isAbsolute(d))
      .map(canonical),
  );
  for (let dir = canonical(process.cwd()); ; ) {
    if (fs.existsSync(path.join(dir, ".git"))) return true;
    const parent = path.dirname(dir);
    if (parent === dir || ceilings.has(parent)) return false;
    dir = parent;
  }
}

/** Why HEAD could not be read: the first of the three checks that fails. */
function whyNoSha() {
  if (git(["--version"]) === null) return "git_unavailable";
  if (!gitMetadataPresent()) return "not_a_repository";
  return "head_unreadable";
}

function buildInfo() {
  const full = git(["rev-parse", "HEAD"]);
  const sha = full && /^[0-9a-f]{40}$/.test(full) ? full : null;
  const unclean = sha ? dirtiness() : null;
  if (sha && unclean) {
    return {
      builtAt: new Date().toISOString(),
      gitSha: null,
      gitShaFull: null,
      traceable: false,
      dirty: unclean === "dirty" ? true : null,
      reason: unclean,
      baseShaFull: sha,
    };
  }
  return {
    builtAt: new Date().toISOString(),
    gitSha: sha ? sha.slice(0, 7) : null,
    gitShaFull: sha,
    traceable: sha ? isAncestorOfMain() : null,
    dirty: sha ? false : null,
    reason: sha ? null : whyNoSha(),
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
      info.baseShaFull
        ? info.reason === "status_unreadable"
          ? `[build-info] git status could not run on ${info.baseShaFull.slice(0, 7)}, so the workspace state is unknown (status_unreadable); build SHA reported as unknown`
          : `[build-info] workspace has uncommitted changes on ${info.baseShaFull.slice(0, 7)} (dirty); build SHA reported as unknown`
        : `[build-info] ${info.gitSha ?? `unknown sha (${info.reason})`} traceable=${info.traceable}`,
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
