import type { ComposerThreadTarget } from "~/composerDraftStore";
import { useComposerDraftStore, useComposerThreadDraft } from "~/composerDraftStore";

export interface DraftHeroSuggestion {
  readonly title: string;
  readonly description: string;
  readonly prompt: string;
}

// Starter cards for the fresh-chat hero. Written for first-time users with
// no AI background: plain words, each prompt tells the agent to ask simple
// follow-up questions and to explain every step. The job and trip cards
// speak to the most common needs; the price card shows off what the
// agent can operate on the user's behalf. The computer cards cover everyday
// tech chores — printers, Wi-Fi and devices, installing and setting things
// up, slow machines, and boring forms — and each one tells the agent to ask
// for the user's OK before opening, changing, submitting, or paying for
// anything.
export const DRAFT_HERO_SUGGESTIONS: ReadonlyArray<DraftHeroSuggestion> = [
  {
    title: "Get a better job",
    description: "Find real openings for you and apply on your behalf.",
    prompt:
      "I want a better job in India. Please ask me questions step by step in simple words: what work I do, my experience, my city, and what salary I want. Keep asking until you have enough details. Then use the browser to find 5 real current job openings that fit me. Then open those websites in the inbuilt browser and ask me to log in on each job website, and once I am logged in, apply for those jobs on my behalf. Explain every step in plain language.",
  },
  {
    title: "Plan a cheap trip",
    description: "Flights, stays, daily plan and full cost per person.",
    prompt:
      "I am planning a trip in India or abroad but I do not know where to start. Please ask me questions step by step in simple words: where I want to go, how many people are coming, my budget per person, and how many days I have. Keep asking until you have enough details. Then use the browser to research everything yourself: what this place is famous for, cheapest flights, best places to stay, things to do each day with their cost, and what things I can buy there with cheaper options. If my budget is too low for this place, suggest a cheaper similar place instead. Then show me the full plan as a day-by-day table plus a cost table with the total per person. Keep everything short and easy to read: small tables and bullet points, no big paragraphs. Explain every step in plain language.",
  },
  {
    title: "Sort out a document",
    description: "Resumes, leave letters and applications from a few lines.",
    prompt:
      "Please help me write a document. Ask me questions step by step in simple words: first what I need, for example a resume, a leave application, or a job application, then the basic details. Keep asking until you have enough. Then write a clean, polite final draft I can copy and use. Explain what you wrote in plain language.",
  },
  {
    title: "Find the cheapest price",
    description: "Check Amazon, Flipkart and more, and show the best deal.",
    prompt:
      "I want to buy something online in India but I do not want to overpay. Please ask me questions step by step in simple words: what I want to buy and my budget. Keep asking until you have enough details. Then use the browser to check the price yourself on Amazon, Flipkart and other Indian stores, and show me a simple table with the cheapest option and its link. Explain every step in plain language.",
  },
  {
    title: "Fix my printer or Wi-Fi",
    description: "Printer, Wi-Fi or a device that will not connect.",
    prompt:
      "My printer, Wi-Fi, or another device connected to my computer is not working. Please ask me questions step by step in simple words: which device it is, what goes wrong, what computer I have, and what I already tried. Keep asking until you have enough details. Then help me fix it yourself: check what you can on my computer, and before you open any settings app or change anything, tell me what you want to open and ask for my OK. If something needs downloading, find it on the official website with the browser. Explain every step in plain language.",
  },
  {
    title: "Set up my computer",
    description: "Install apps, update drivers and change settings.",
    prompt:
      "I need to install, update, or fix something on my computer, for example an app, a driver, or a setting. Please ask me questions step by step in simple words: what computer I have, what I want to install or change, and what is not working today. Keep asking until you have enough details. Then do it with me one small step at a time: if it needs a download, find it on the official website with the browser, and before you open or change anything on my computer, tell me what you want to do and ask for my OK. Explain every step in plain language.",
  },
  {
    title: "Fix a slow computer",
    description: "Slow laptop, full storage or updates stuck.",
    prompt:
      "My computer is slow or full. Please ask me questions step by step in simple words: what computer I have, what feels slow, and when it started. Keep asking until you have enough details. Then check what you can on my computer: what is using space, what starts automatically, and whether updates are stuck. Before you delete or change anything, tell me what you found and ask for my OK. Explain every step in plain language.",
  },
  {
    title: "Fill a boring form",
    description: "Online forms, applications and PDFs, filled with you.",
    prompt:
      "I have a boring form to fill, for example an online application, a government form, or a PDF. Please ask me questions step by step in simple words: where the form is, what it asks for, and what details I want to use. Keep asking until you have enough. Never guess my personal details, always ask me. Then fill the form with me: open it in the browser if it is online, show me what you filled, and ask for my OK before you submit or pay anything. Explain every step in plain language.",
  },
];

/**
 * The cards spoonfeed the first prompt, so they only make sense on an
 * untouched composer. Once the user has typed (or picked) something they
 * get out of the way instead of pushing the input around.
 */
export function shouldShowHeroSuggestions(prompt: string): boolean {
  return prompt.trim().length === 0;
}

interface DraftHeroSuggestionsProps {
  readonly draftTarget: ComposerThreadTarget;
  readonly onPick?: () => void;
}

export function DraftHeroSuggestions({ draftTarget, onPick }: DraftHeroSuggestionsProps) {
  const setPrompt = useComposerDraftStore((store) => store.setPrompt);
  const draft = useComposerThreadDraft(draftTarget);

  if (!shouldShowHeroSuggestions(draft.prompt)) {
    return null;
  }

  return (
    <div className="pointer-events-auto mx-auto grid w-full max-w-3xl grid-cols-1 gap-2.5 pt-4 sm:grid-cols-2">
      {DRAFT_HERO_SUGGESTIONS.map((suggestion) => (
        <button
          key={suggestion.title}
          type="button"
          onClick={() => {
            setPrompt(draftTarget, suggestion.prompt);
            onPick?.();
          }}
          className="rounded-2xl border border-border/50 bg-card px-4 py-3.5 text-left transition-colors hover:border-border hover:bg-accent/50 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
        >
          <span className="block text-[15px] font-medium text-foreground">{suggestion.title}</span>
          <span className="mt-0.5 block text-sm text-muted-foreground">
            {suggestion.description}
          </span>
        </button>
      ))}
    </div>
  );
}
