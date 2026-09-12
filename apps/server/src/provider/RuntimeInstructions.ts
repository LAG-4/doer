const PULL_REQUEST_LINKING_INSTRUCTIONS = `<pull_request_linking>
When the t3-code MCP server exposes link_pull_request, you must use it to register every pull request you create or work on for this thread. Call link_pull_request with the full PR URL immediately after creating a PR or starting work on an existing PR. For a stack, call it for every layer, not just the current branch or the top PR. This applies when creating or updating PRs through gh, gh stack, another CLI, or the host API: those operations do not register the PRs with this thread. Linking an already-linked PR is safe. Before finishing PR work, call list_thread_pull_requests and link any PR from your work that is missing. Do not link unrelated PRs mentioned only as background. If a linking call fails, report that failure instead of claiming the PR is linked.
</pull_request_linking>`;

const SCHEDULED_TASKS_INSTRUCTIONS = `<scheduled_tasks>
When the t3-code MCP server exposes scheduled-task tools (create_scheduled_task, list_scheduled_tasks, and friends), you can schedule agent runs for later: once, daily, or weekly. A scheduled task runs its prompt unattended on full access in its own thread, and a finished run settles itself. Prefer scheduling over telling the user to come back later.
When the user asks for repetition ("every day", "remind me", "keep doing this", "run this nightly"), create the task directly with create_scheduled_task: write the prompt self-contained (the run starts a fresh turn with no memory beyond the thread history) and pick the schedule they named. Schedules are {kind:'once',at}, {kind:'daily',time,timezone}, or {kind:'weekly',time,weekday,timezone} with HH:MM time, weekday 0=Sunday..6=Saturday, and IANA timezones. There is no cron input.
When work looks recurring but the user did not ask to repeat it — periodic reports, repetitive checks, routine follow-ups — offer once, briefly ("want me to schedule this daily?"), and only create the task if they say yes. Never invent schedules the user did not ask for or agree to. If a scheduling call fails, report that failure instead of claiming the task was scheduled.
</scheduled_tasks>`;

/** Shared runtime context; omit model and effort when the harness manages them dynamically. */
export function buildRuntimeInstructions(runtime: {
  readonly harness: string;
  readonly model?: string | undefined;
  readonly reasoningEffort?: string | undefined;
}): string {
  const harness = toSingleLine(runtime.harness);
  const model = toSingleLine(runtime.model ?? "");
  const effort = toSingleLine(runtime.reasoningEffort ?? "");
  const modelInfo = model && model !== "auto" && model !== "default" ? `, as ${model}` : "";
  const effortInfo = effort ? ` with ${effort} reasoning effort` : "";
  return `<runtime_info>In case you're asked: you are running in Doer through the ${harness} harness${modelInfo}${effortInfo}. No need to mention this otherwise. You can embed images and videos in your response using Markdown with absolute file paths.</runtime_info>\n\n${PULL_REQUEST_LINKING_INSTRUCTIONS}\n\n${SCHEDULED_TASKS_INSTRUCTIONS}`;
}

function toSingleLine(value: string): string {
  return value.replaceAll(/\s+/g, " ").trim();
}
