import { createFileRoute, redirect, useLocation } from "@tanstack/react-router";
import { useState } from "react";

import { NoProjectsHero } from "../components/NoProjectsHero";
import { WelcomeWizard } from "../components/onboarding/WelcomeWizard";

/** Onboarding overlays the workspace. Visiting /welcome reopens setup. */
export const Route = createFileRoute("/welcome")({
  beforeLoad: ({ context }) => {
    const { authGateState } = context;
    if (authGateState.status !== "authenticated" && authGateState.status !== "hosted-static") {
      throw redirect({ to: "/pair", replace: true });
    }
  },
  component: WelcomeRouteView,
});

function WelcomeRouteView() {
  // The root shell can remount this pending outlet after the location changes.
  // Never reopen setup while the destination route is still loading.
  const isWelcomeRoute = useLocation({ select: (location) => location.pathname === "/welcome" });
  const [dismissed, setDismissed] = useState(false);
  return (
    <>
      <NoProjectsHero />
      {isWelcomeRoute && !dismissed ? (
        <WelcomeWizard
          onDone={() => {
            // The hero behind the wizard is the destination: dismissing
            // reveals "Start chatting" with no navigation, so no
            // intermediate screen can flash. Starting a chat opens the
            // default folder (the auto-provisioned inbox); adding a folder
            // stays optional. A submitted first task navigates itself to
            // its conversation before calling back here.
            setDismissed(true);
          }}
        />
      ) : null}
    </>
  );
}
