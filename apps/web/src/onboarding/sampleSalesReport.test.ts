import { describe, expect, it } from "vite-plus/test";

import {
  buildFirstTaskPrompt,
  buildFirstTaskTitle,
  SAMPLE_REPORT_FILENAME,
  SAMPLE_REPORT_LABEL,
  SAMPLE_SALES_REPORT,
} from "./sampleSalesReport";

describe("sample sales report", () => {
  it("stays a small self-contained markdown file", () => {
    expect(SAMPLE_REPORT_FILENAME.endsWith(".md")).toBe(true);
    expect(new TextEncoder().encode(SAMPLE_SALES_REPORT).length).toBeLessThan(8 * 1024);
  });

  it("labels itself as fictional sample data", () => {
    expect(SAMPLE_SALES_REPORT).toContain(SAMPLE_REPORT_LABEL);
    expect(SAMPLE_SALES_REPORT).toContain("fictional");
  });

  it("carries current and previous month sales plus target performance", () => {
    expect(SAMPLE_SALES_REPORT).toMatch(/\$[\d,]+.*\$[\d,]+/);
    expect(SAMPLE_SALES_REPORT.toLowerCase()).toContain("target");
    expect(SAMPLE_SALES_REPORT).toContain("August");
    expect(SAMPLE_SALES_REPORT).toContain("September");
  });

  it("shows product and region differences plus a management note", () => {
    expect(SAMPLE_SALES_REPORT).toContain("Everyday Blender");
    expect(SAMPLE_SALES_REPORT).toContain("Trail Backpack");
    expect(SAMPLE_SALES_REPORT).toContain("North");
    expect(SAMPLE_SALES_REPORT).toContain("West");
    expect(SAMPLE_SALES_REPORT.toLowerCase()).toContain("management note");
  });

  it("builds a prompt asking for the promised explanation", () => {
    const prompt = buildFirstTaskPrompt(SAMPLE_REPORT_FILENAME);
    expect(prompt).toContain(SAMPLE_REPORT_FILENAME);
    expect(prompt).toContain("improved or declined");
    expect(prompt).toContain("most important figures");
    expect(prompt).toMatch(/three useful follow-up/i);
  });

  it("builds a short non-empty thread title", () => {
    const title = buildFirstTaskTitle(SAMPLE_REPORT_FILENAME);
    expect(title.length).toBeGreaterThan(0);
    expect(title.length).toBeLessThanOrEqual(80);
  });
});
