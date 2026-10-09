import { describe, expect, it } from "vite-plus/test";
import {
  GUIDED_STARTER_TASKS,
  buildStarterRequest,
  buildStarterSummary,
  starterFileRequirement,
} from "./guidedStarterTasks";
describe("guided everyday work", () => {
  it("requires source documents for explanation and report comparison", () => {
    const document = GUIDED_STARTER_TASKS.find((task) => task.id === "understand")!;
    const reports = GUIDED_STARTER_TASKS.find((task) => task.id === "reports")!;
    expect(starterFileRequirement(document, 0)).toContain("document");
    expect(starterFileRequirement(document, 1)).toBeNull();
    expect(starterFileRequirement(reports, 1)).toContain("two reports");
    expect(starterFileRequirement(reports, 2)).toBeNull();
  });
  it("retains reviewed goals, source names and existing draft notes in the request", () => {
    const task = GUIDED_STARTER_TASKS.find((task) => task.id === "application")!;
    const summary = buildStarterSummary(task, { role: "Sales", format: "Cover letter" }, [
      "Resume.pdf",
    ]);
    const request = buildStarterRequest({
      task,
      answers: { role: "Sales" },
      summary,
      existingPrompt: "Keep it concise",
      fileNames: ["Resume.pdf"],
    });
    expect(request).toContain("Sales");
    expect(request).toContain("Resume.pdf");
    expect(request).toContain("Keep it concise");
    expect(request).toContain("Never invent qualifications");
    expect(request).toContain("Do not submit");
  });
  it("keeps file organization read-only until the concrete plan is approved", () => {
    const task = GUIDED_STARTER_TASKS.find((task) => task.id === "organize")!;
    expect(
      buildStarterRequest({
        task,
        answers: {},
        summary: "Sort my files",
        existingPrompt: "",
        fileNames: [],
      }),
    ).toContain("Do not move, rename or delete until the user approves");
  });
  it("asks core workflows for downloadable results with sources and new-copy revisions", () => {
    for (const id of ["understand", "application", "meeting"] as const) {
      const request = buildStarterRequest({
        task: GUIDED_STARTER_TASKS.find((task) => task.id === id)!,
        answers: {},
        summary: "Do the task",
        existingPrompt: "",
        fileNames: [],
      });
      expect(request).toContain("built-in output tools");
      expect(request).toMatch(/assumption/i);
      expect(request).toContain("save a new copy");
    }
    expect(
      buildStarterRequest({
        task: GUIDED_STARTER_TASKS.find((task) => task.id === "understand")!,
        answers: {},
        summary: "Explain it",
        existingPrompt: "",
        fileNames: [],
      }),
    ).toContain("missing information");
  });
});
