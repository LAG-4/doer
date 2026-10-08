/**
 * Fictional sample asset for the first-task onboarding experience.
 *
 * The wizard attaches this file to the new user's first real turn, so it is
 * an intentional product asset: keep it small (a few KB), self-contained,
 * and obviously fictional. The monthly prompt built by
 * `buildSampleReportPrompt` asks Doer to explain what improved or declined, the most important figures,
 * and three useful follow-ups — the content below carries exactly the
 * inputs that answer needs (current vs previous month, target performance,
 * product/region differences, a short management note).
 */

export const SAMPLE_REPORT_FILENAME = "sample-sales-report.md";
export const SAMPLE_REPORT_MIME = "text/markdown";
export const SAMPLE_REPORT_LABEL = "Sample report — fictional data.";

export const SAMPLE_SALES_REPORT = `# Monthly Sales Report — September 2026
${SAMPLE_REPORT_LABEL} All companies, products, and figures are invented for demonstration.

## Summary
- Total sales: $184,500 (September) vs $162,300 (August) — up 13.7%.
- Target for September was $175,000, so the team beat target by 5.4%.
- Orders: 1,240 in September vs 1,105 in August — up 12.2%.

## By product
- Everyday Blender: $72,400 (Sep) vs $58,900 (Aug) — up 22.9%. Bestseller,
  helped by the back-to-school promotion in the second half of the month.
- Cozy Lamp: $54,800 (Sep) vs $56,200 (Aug) — down 2.5%. Returns ticked up
  after a batch with faulty dimmer switches shipped in week 2.
- Trail Backpack: $33,100 (Sep) vs $24,600 (Aug) — up 34.6%. A hiking
  influencer mentioned it on September 14 and online orders doubled that week.
- Desk Organizer: $24,200 (Sep) vs $22,600 (Aug) — up 7.1%. Steady, no
  notable events.

## By region
- North: $78,900 (Sep) vs $70,400 (Aug) — up 12.1%.
- South: $61,300 (Sep) vs $58,700 (Aug) — up 4.4%.
- West: $44,300 (Sep) vs $33,200 (Aug) — up 33.4%, almost entirely Trail
  Backpack online orders shipping from the Reno warehouse.

## Management note
October's target is $190,000. The faulty dimmer-switch batch is contained —
the supplier confirmed a fix starting October 3 — but lamp stock runs low
until then. The team is debating whether to repeat the blender promotion or
spend that budget fixing the lamp listings' reviews first.
`;

/**
 * The monthly prompt for Doer's fictional sample sales report. Plain
 * language, no jargon: it names the file, then asks for exactly the
 * explanation the onboarding promises (improved/declined, key figures,
 * three follow-ups).
 */
export function buildSampleReportPrompt(fileName: string): string {
  return [
    `I've attached "${fileName}". Please explain it in plain language:`,
    "",
    "1. What improved or declined since last month.",
    "2. The most important figures I should know.",
    "3. Three useful follow-up questions or actions.",
  ].join("\n");
}

/**
 * The generic prompt for an arbitrary user document. It never assumes the
 * file is a sales report: plain-language summary, key dates, important
 * points, and next steps grounded in the document itself.
 */
export function buildDocumentPrompt(fileName: string): string {
  return [
    `I've attached "${fileName}". Please explain it in plain language:`,
    "",
    "1. A short summary of what this document says.",
    "2. Key dates, deadlines, or time-sensitive points.",
    "3. The most important points I should know.",
    "4. Suggested next steps based only on what the document actually says. Say what is unclear or missing instead of guessing.",
  ].join("\n");
}

export interface FirstTaskPromptInput {
  readonly fileName: string;
  /** True for Doer's fictional sample report; false for the user's own file. */
  readonly isSample: boolean;
}

/**
 * Picks the sample monthly prompt for Doer's sample report and the generic
 * document prompt for everything else.
 */
export function buildFirstTaskPrompt(input: FirstTaskPromptInput): string {
  return input.isSample
    ? buildSampleReportPrompt(input.fileName)
    : buildDocumentPrompt(input.fileName);
}

/** Short thread title for the first task. Never calls every file a report. */
export function buildFirstTaskTitle(fileName: string): string {
  const base = fileName
    .replace(/\.[^.]+$/, "")
    .replace(/[-_]+/g, " ")
    .trim();
  return `Explain ${base.length > 0 ? base : "my document"}`.slice(0, 80);
}
