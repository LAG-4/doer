import {
  ArrowLeftIcon,
  FolderOpenIcon,
  GlobeIcon,
  HistoryIcon,
  MessageCircleIcon,
  PlaneIcon,
  SendIcon,
  SparklesIcon,
} from "lucide-react";
import type { ScopedProjectRef } from "@t3tools/contracts";
import { useCallback, useRef, useState } from "react";

import { useCompleteOnboarding } from "../../onboarding/firstRun";
import {
  isLastTourSlide,
  nextTourSlide,
  prevTourSlide,
  TOUR_SLIDE_COUNT,
} from "../../onboarding/tour.logic";
import { Button } from "../ui/button";
import { Dialog, DialogPopup } from "../ui/dialog";
import { Spinner } from "../ui/spinner";
import { cn } from "../../lib/utils";
import { toastManager } from "../ui/toast";

const CONTINUE_BUTTON_ID = "doer-tour-continue";

/**
 * First-run tour. An Apple-style 3-slide popup over a fresh workspace:
 * what Doer can do → how to use it → ready. No computer picking, no
 * install terminals, no project import — the server connects this
 * computer and installs the free default agent in the background.
 * Dismissing (Continue through, Start, or Not Now) marks onboarding
 * complete so FirstRunGate never routes here again.
 */
export function WelcomeWizard({
  onDone,
}: {
  /** Whether this client is authenticated to the server serving the app. */
  readonly localAvailable: boolean;
  readonly onDone: (projectRef?: ScopedProjectRef) => void;
}) {
  const completeOnboarding = useCompleteOnboarding();
  const [slide, setSlide] = useState(0);
  const [isFinishing, setIsFinishing] = useState(false);
  const finishingRef = useRef(false);
  const completionErrorToastIdRef = useRef<ReturnType<typeof toastManager.add> | null>(null);

  const finish = useCallback(() => {
    if (finishingRef.current) return;
    finishingRef.current = true;
    setIsFinishing(true);
    if (completionErrorToastIdRef.current !== null) {
      toastManager.close(completionErrorToastIdRef.current);
      completionErrorToastIdRef.current = null;
    }
    void completeOnboarding()
      .then(() => {
        if (completionErrorToastIdRef.current !== null) {
          toastManager.close(completionErrorToastIdRef.current);
          completionErrorToastIdRef.current = null;
        }
        onDone();
      })
      .catch(() => {
        finishingRef.current = false;
        setIsFinishing(false);
        const errorToast = {
          type: "error",
          title: "Could not finish the tour",
          description: "Your settings could not be saved. Try again.",
        } as const;
        if (completionErrorToastIdRef.current === null) {
          completionErrorToastIdRef.current = toastManager.add(errorToast);
        } else {
          toastManager.update(completionErrorToastIdRef.current, errorToast);
        }
      });
  }, [completeOnboarding, onDone]);

  const goNext = useCallback(() => {
    setSlide((current) => {
      if (isLastTourSlide(current)) {
        finish();
        return current;
      }
      return nextTourSlide(current);
    });
  }, [finish]);

  const goBack = useCallback(() => {
    setSlide((current) => prevTourSlide(current));
  }, []);

  // macOS behavior: the popup is app-modal (clicking outside does nothing),
  // arrow keys move between pages, Escape skips the tour.
  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      if (isFinishing) return;
      if (event.key === "Escape") {
        event.preventDefault();
        finish();
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        goNext();
      } else if (event.key === "ArrowLeft") {
        event.preventDefault();
        goBack();
      }
    },
    [finish, goBack, goNext, isFinishing],
  );

  // Native sheets keep focus on the primary action: the button remounts
  // per page (key) and autoFocus moves focus on each page change.
  const last = isLastTourSlide(slide);

  return (
    <Dialog open disablePointerDismissal onOpenChange={(_, event) => event.cancel()}>
      <DialogPopup
        bottomStickOnMobile={false}
        showCloseButton={false}
        aria-label="Welcome to Doer"
        className="max-w-xl overflow-hidden"
        initialFocus={() => document.getElementById(CONTINUE_BUTTON_ID) ?? true}
        onKeyDown={handleKeyDown}
      >
        <TourVisual slide={slide} />
        <div className="px-6 pt-5 pb-6 text-center sm:px-10" aria-live="polite">
          <TourBody slide={slide} />
          <TourDots slide={slide} disabled={isFinishing} onSelect={setSlide} />
          <div className="mx-auto mt-5 max-w-sm">
            <Button
              id={CONTINUE_BUTTON_ID}
              key={slide}
              autoFocus
              size="lg"
              disabled={isFinishing}
              onClick={goNext}
              className="h-12 w-full rounded-full text-base font-semibold"
            >
              {isFinishing ? (
                <>
                  <Spinner className="size-4" />
                  Starting…
                </>
              ) : last ? (
                "Start using Doer"
              ) : (
                "Continue"
              )}
            </Button>
            <div className="mt-1 flex min-h-9 items-center justify-center gap-1">
              {slide > 0 ? (
                <Button variant="ghost-muted" size="sm" disabled={isFinishing} onClick={goBack}>
                  <ArrowLeftIcon className="size-3.5" />
                  Back
                </Button>
              ) : null}
              {!last ? (
                <Button variant="ghost-muted" size="sm" disabled={isFinishing} onClick={finish}>
                  Not Now
                </Button>
              ) : null}
            </div>
            {last ? (
              <p className="mx-auto mt-3 max-w-sm text-xs leading-relaxed text-muted-foreground/70">
                Free models are provided by OpenCode — your data might be used for training.
              </p>
            ) : null}
          </div>
        </div>
      </DialogPopup>
    </Dialog>
  );
}

function TourVisual({ slide }: { readonly slide: number }) {
  return (
    <div className="flex flex-col items-center bg-gradient-to-b from-muted/70 via-muted/25 to-transparent px-6 pt-9 pb-3">
      {slide === 0 ? (
        <img
          src="/apple-touch-icon.png"
          alt=""
          width={76}
          height={76}
          className="size-[76px] rounded-[22%] shadow-lg ring-1 ring-black/10"
          draggable={false}
        />
      ) : slide === 1 ? (
        <div
          aria-hidden
          className="w-full max-w-sm rounded-2xl border border-border/70 bg-card/80 p-3 text-left shadow-md"
        >
          <div className="ml-auto w-fit max-w-[85%] rounded-2xl rounded-br-md bg-primary px-3 py-2 text-xs font-medium text-primary-foreground">
            Find the cheapest Delhi to Goa flight in December
          </div>
          <div className="mt-2 overflow-hidden rounded-2xl rounded-tl-md border border-border/60 bg-background">
            <div className="flex items-center gap-2 border-b border-border/60 bg-muted/50 px-3 py-2">
              <span className="flex gap-1">
                <span className="size-2 rounded-full bg-muted-foreground/30" />
                <span className="size-2 rounded-full bg-muted-foreground/30" />
                <span className="size-2 rounded-full bg-muted-foreground/30" />
              </span>
              <span className="flex min-w-0 flex-1 items-center gap-1.5 rounded-full bg-muted px-2.5 py-1 text-[10px] text-muted-foreground">
                <GlobeIcon className="size-3 shrink-0" />
                <span className="truncate">travel · goa flights</span>
              </span>
            </div>
            <ul className="space-y-1 px-3 py-2.5 text-[11px]">
              <li className="flex items-center gap-2">
                <PlaneIcon className="size-3.5 shrink-0 text-sky-500 dark:text-sky-300" />
                <span className="min-w-0 flex-1 truncate text-foreground">
                  Dec 12 · Nonstop · 2h 10m
                </span>
                <span className="shrink-0 font-semibold text-foreground">₹4,999</span>
              </li>
              <li className="flex items-center gap-2">
                <PlaneIcon className="size-3.5 shrink-0 text-sky-500 dark:text-sky-300" />
                <span className="min-w-0 flex-1 truncate text-foreground">
                  Dec 13 · 1 stop · 4h 05m
                </span>
                <span className="shrink-0 font-semibold text-foreground">₹4,399</span>
              </li>
            </ul>
          </div>
          <span className="mt-2.5 inline-flex rounded-full bg-primary px-3 py-1 text-[11px] font-semibold text-primary-foreground">
            Approve to book
          </span>
        </div>
      ) : (
        <div className="flex flex-wrap items-center justify-center gap-2" aria-hidden>
          <span className="inline-flex items-center gap-1.5 rounded-full border border-border/70 bg-card/80 px-3 py-1.5 text-xs font-medium text-foreground shadow-sm">
            <span className="size-1.5 rounded-full bg-emerald-500" />
            This computer · Ready
          </span>
          <span className="inline-flex items-center gap-1.5 rounded-full border border-border/70 bg-card/80 px-3 py-1.5 text-xs font-medium text-foreground shadow-sm">
            <SparklesIcon className="size-3.5 text-sky-500 dark:text-sky-300" />
            Free models · On
          </span>
        </div>
      )}
    </div>
  );
}

function TourBody({ slide }: { readonly slide: number }) {
  if (slide === 1) {
    return (
      <>
        <h1 className="text-2xl font-semibold tracking-tight text-foreground">
          You stay in charge
        </h1>
        <p className="mx-auto mt-2 max-w-md text-sm leading-relaxed text-muted-foreground">
          Tell Doer what you need. It browses the web, compares options, and acts only when you
          approve.
        </p>
        <ul className="mx-auto mt-6 max-w-md space-y-5 text-left">
          <TourFeature
            icon={<MessageCircleIcon className="size-5 text-sky-500 dark:text-sky-300" />}
            title="Tell it"
            description="Ask in plain words — like finding the cheapest flight."
          />
          <TourFeature
            icon={<GlobeIcon className="size-5 text-sky-500 dark:text-sky-300" />}
            title="Watch it browse"
            description="Doer searches pages and compares options for you."
          />
          <TourFeature
            icon={<HistoryIcon className="size-5 text-sky-500 dark:text-sky-300" />}
            title="Approve, then undo anytime"
            description="It acts only when you approve. Undo any step in History."
          />
        </ul>
      </>
    );
  }
  if (slide === 2) {
    return (
      <>
        <h1 className="text-2xl font-semibold tracking-tight text-foreground">
          Ready when you are
        </h1>
        <p className="mx-auto mt-2 max-w-md text-sm leading-relaxed text-muted-foreground">
          This computer is already set up. Start chatting, or add a folder to your Space first.
        </p>
      </>
    );
  }
  return (
    <>
      <h1 className="text-2xl font-semibold tracking-tight text-foreground">Welcome to Doer</h1>
      <p className="mx-auto mt-2 max-w-md text-sm leading-relaxed text-muted-foreground">
        Your everyday helper for life and work. Tell it what you need in plain words.
      </p>
      <ul className="mx-auto mt-6 max-w-md space-y-5 text-left">
        <TourFeature
          icon={<SparklesIcon className="size-5 text-sky-500 dark:text-sky-300" />}
          title="Do everyday tasks"
          description="Errands, writing, paperwork, schedules — describe it and Doer does the steps."
        />
        <TourFeature
          icon={<FolderOpenIcon className="size-5 text-sky-500 dark:text-sky-300" />}
          title="Work in your spaces"
          description="Point Doer at the folders it may use. Free models are already on."
        />
        <TourFeature
          icon={<SendIcon className="size-5 text-sky-500 dark:text-sky-300" />}
          title="Just ask"
          description="If you can describe it, Doer can probably do it. Detailed, creative prompts get the best results."
        />
        <TourFeature
          icon={<GlobeIcon className="size-5 text-sky-500 dark:text-sky-300" />}
          title="Files, pages and outputs"
          description="Attach files, mention them with @, and get pages you can share."
        />
      </ul>
    </>
  );
}

function TourFeature({
  icon,
  title,
  description,
}: {
  readonly icon: React.ReactNode;
  readonly title: string;
  readonly description: string;
}) {
  return (
    <li className="flex gap-3">
      <span className="mt-0.5 shrink-0" aria-hidden>
        {icon}
      </span>
      <span className="min-w-0">
        <span className="block text-sm font-semibold text-foreground">{title}</span>
        <span className="mt-0.5 block text-sm leading-relaxed text-muted-foreground">
          {description}
        </span>
      </span>
    </li>
  );
}

function TourDots({
  slide,
  disabled,
  onSelect,
}: {
  readonly slide: number;
  readonly disabled: boolean;
  readonly onSelect: (index: number) => void;
}) {
  return (
    <div
      className="mt-6 flex items-center justify-center gap-1.5"
      role="tablist"
      aria-label="Tour pages"
    >
      {Array.from({ length: TOUR_SLIDE_COUNT }, (_, index) => (
        <button
          key={index}
          type="button"
          role="tab"
          aria-selected={index === slide}
          aria-label={`Go to page ${index + 1}`}
          disabled={disabled}
          onClick={() => onSelect(index)}
          className={cn(
            "h-1.5 rounded-full transition-all disabled:cursor-default",
            index === slide
              ? "w-6 bg-foreground"
              : "w-1.5 bg-muted-foreground/40 hover:bg-muted-foreground/70",
          )}
        />
      ))}
    </div>
  );
}
