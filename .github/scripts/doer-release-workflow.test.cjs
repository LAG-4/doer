const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { test } = require("node:test");
const { parse } = require("yaml");

const source = readFileSync(join(__dirname, "../workflows/release.yml"), "utf8");
const workflow = parse(source);
const jobs = workflow.jobs;

function dependsOn(job, prerequisite, visited = new Set()) {
  assert.ok(jobs[job], `Unknown release dependency: ${job}`);
  if (visited.has(job)) return false;
  visited.add(job);
  const dependencies = [].concat(jobs[job].needs ?? []);
  return (
    dependencies.includes(prerequisite) ||
    dependencies.some((dependency) => dependsOn(dependency, prerequisite, visited))
  );
}

test("release builds and publishers wait for successful quality checks", () => {
  for (const job of ["build", "publish_cli", "release"]) {
    assert.ok(dependsOn(job, "quality"), `${job} must wait for quality`);
    assert.doesNotMatch(jobs[job].if ?? "", /always\(\)/);
    assert.equal(jobs[job]["continue-on-error"], undefined);
  }
  assert.ok(
    dependsOn("build", "build_wsl_runtime"),
    "WSL archive must exist before desktop builds",
  );
  assert.ok(dependsOn("build_wsl_runtime", "quality"), "WSL builds wait for quality");
  assert.match(jobs.build.if, /needs\.build_wsl_runtime\.result == 'success'/);
  assert.ok(dependsOn("release", "publish_cli"), "CLI must publish before desktop release");
  assert.equal(jobs.quality["continue-on-error"], undefined);
  const commands = jobs.quality.steps.map((step) => step.run ?? "").join("\n");
  assert.match(commands, /vp check/);
  assert.match(commands, /vp run typecheck/);
  assert.match(commands, /vp run test/);
});

test("fork releases do not depend on upstream hosted services", () => {
  assert.doesNotMatch(
    source,
    /relay_public_config|needs\.relay|environment:\s*\n\s*name: production/,
  );
  assert.equal(workflow.concurrency.group, "release-stable");
  assert.equal(workflow.concurrency["cancel-in-progress"], false);
  assert.equal(workflow.on.schedule, undefined);
  assert.ok(workflow.on.workflow_dispatch);
  assert.ok(workflow.on.push.tags.includes("v*.*.*"));
  assert.doesNotMatch(source, /pingdotgg\/t3code|finalize:/);
});
