import { describe, expect, it } from "vite-plus/test";
import {
  GUIDED_STARTER_TASKS,
  buildStarterRequest,
  buildStarterSummary,
  starterFileRequirement,
} from "./guidedStarterTasks";

const jobs = GUIDED_STARTER_TASKS.find((task) => task.id === "jobs")!;
const reports = GUIDED_STARTER_TASKS.find((task) => task.id === "reports")!;

describe("guided starter requests", () => {
  it("includes the supplied preferences, existing draft, files and expected result", () => {
    const answers = {
      work: "Marketing",
      location: "Bengaluru or remote",
      experience: "Five years in sales",
    };
    const summary = buildStarterSummary(jobs, answers, ["Resume.pdf"]);
    const request = buildStarterRequest({
      task: jobs,
      answers,
      summary,
      existingPrompt: "Part-time would suit me",
      fileNames: ["Resume.pdf"],
    });
    expect(summary).toContain("five current job openings");
    expect(summary).toContain("Bengaluru or remote");
    expect(request).toContain("Five years in sales");
    expect(request).toContain("Part-time would suit me");
    expect(request).toContain("Resume.pdf");
    expect(request).toContain("Do not apply automatically");
    expect(request).toContain("user-controlled handoff");
  });

  it("keeps skipped and uncertain answers unknown instead of inventing a location or currency", () => {
    const prices = GUIDED_STARTER_TASKS.find((task) => task.id === "prices")!;
    const request = buildStarterRequest({
      task: prices,
      answers: { item: "Laptop", location: "I'm not sure" },
      summary: "Compare laptops",
      existingPrompt: "",
      fileNames: [],
    });
    expect(request).toContain("Where are you shopping? I'm not sure");
    expect(request).toContain(
      "What is your budget, and what matters to you? Unknown; not supplied.",
    );
    expect(request).toContain("do not assume India or a currency");
    expect(request).toContain("Attached files: None.");
    expect(request).not.toContain("Additional notes");
  });

  it("uses the edited review and names both source reports", () => {
    const request = buildStarterRequest({
      task: reports,
      answers: { goal: "Performance", detail: "Quick overview" },
      summary: "Compare spending instead, in detail.",
      existingPrompt: "",
      fileNames: ["May.xlsx", "June.xlsx"],
    });
    expect(request.startsWith("Compare spending instead, in detail.")).toBe(true);
    expect(request).toContain("follow the reviewed summary");
    expect(request).toContain("May.xlsx, June.xlsx");
    expect(request).toContain("mismatched periods or units");
    expect(starterFileRequirement(reports, 0)).toBeTruthy();
    expect(starterFileRequirement(reports, 1)).toBeTruthy();
    expect(starterFileRequirement(reports, 2)).toBeNull();
    expect(starterFileRequirement(jobs, 0)).toBeNull();
  });
});
