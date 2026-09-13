import { describe, expect, it } from "vite-plus/test";

import { computerUseQuickStart } from "./handlers.ts";

describe("computer tool helpers", () => {
  it("writes the quick start around the pinned launcher", () => {
    const text = computerUseQuickStart("/tmp/t3 tools/computer-use", false);
    expect(text).toContain("/tmp/t3 tools/computer-use call list_apps");
    expect(text).toContain(
      `/tmp/t3 tools/computer-use call get_app_state --args '{"app":"TextEdit"}'`,
    );
    expect(text).toContain("Prefer element_index targets");
    expect(text).toContain("Never drive an app the user did not approve");
  });

  it("tells the agent to run doctor while permissions are missing", () => {
    const text = computerUseQuickStart("computer-use", true);
    expect(text).toContain("computer-use doctor");
    expect(text).toContain("Accessibility and Screen Recording");
    expect(text).toContain("then call computer_start again");
  });

  it("keeps the doctor fallback once permissions are granted", () => {
    const text = computerUseQuickStart("computer-use", false);
    expect(text).not.toContain("then call computer_start again");
    expect(text).toContain("computer-use doctor");
  });
});
