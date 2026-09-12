import type { HTMLAttributes } from "react";

import { cn } from "../lib/utils";

const WORDMARK_ASPECT = "1006 / 339";
const WORDMARK_MASK = "url(/doer-wordmark.png)";

export function T3Wordmark({ className, style, ...props }: HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      aria-hidden
      className={cn("inline-block shrink-0 bg-current", className)}
      style={{
        aspectRatio: WORDMARK_ASPECT,
        maskImage: WORDMARK_MASK,
        maskSize: "contain",
        maskRepeat: "no-repeat",
        maskPosition: "center",
        WebkitMaskImage: WORDMARK_MASK,
        WebkitMaskSize: "contain",
        WebkitMaskRepeat: "no-repeat",
        WebkitMaskPosition: "center",
        ...style,
      }}
      {...props}
    />
  );
}
