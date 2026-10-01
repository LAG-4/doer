import type { EnvironmentId } from "@t3tools/contracts";
import {
  EMPTY_DOER_CONTEXT,
  parseDoerContext,
  type DoerContext,
} from "@t3tools/shared/doerContext";
import { useState } from "react";
import { useProjectEntriesQuery, useProjectFileQuery } from "../files/projectFilesQueryState";
import { projectEnvironment } from "~/state/projects";
import { useAtomCommand } from "~/state/use-atom-command";
import { Button } from "../ui/button";
import { Label } from "../ui/label";
import { Textarea } from "../ui/textarea";
import { SettingsSection } from "./settingsLayout";

export function DoerContextEditor(props: {
  environmentId: EnvironmentId;
  cwd: string;
  relativePath: string;
  personal?: boolean;
}) {
  const file = useProjectFileQuery(props.environmentId, props.cwd, props.relativePath, true);
  const directory = useProjectEntriesQuery(props.environmentId, props.cwd, "");
  if (file.isPending && !file.data)
    return (
      <p role="status" className="text-sm text-muted-foreground">
        Loading saved details…
      </p>
    );
  // File errors crossing the wire can lose the underlying ENOENT code. Confirm
  // absence through the complete folder listing rather than treating any read failure as empty.
  const missing =
    file.error &&
    directory.data !== null &&
    !directory.data.truncated &&
    !directory.data.entries.some((entry) => entry.path === props.relativePath);
  if (file.error && directory.isPending && !directory.data)
    return <p role="status">Loading saved details…</p>;
  if (file.error && !missing)
    return (
      <p role="alert" className="text-sm text-destructive">
        Could not load your saved details. {file.error}
      </p>
    );
  let context = EMPTY_DOER_CONTEXT;
  try {
    if (file.data) context = parseDoerContext(file.data.contents);
  } catch {
    return (
      <p role="alert" className="text-sm text-destructive">
        Your saved details could not be read. Open the context file from Files to repair it; it has
        been kept.
      </p>
    );
  }
  return (
    <ContextForm
      key={`${props.environmentId}:${props.cwd}:${props.relativePath}`}
      {...props}
      initial={context}
      onSaved={file.refresh}
    />
  );
}

function ContextForm(props: {
  environmentId: EnvironmentId;
  cwd: string;
  relativePath: string;
  personal?: boolean;
  initial: DoerContext;
  onSaved: () => void;
}) {
  const [draft, setDraft] = useState(props.initial);
  const [baseline, setBaseline] = useState(props.initial);
  const [lastLoaded, setLastLoaded] = useState(props.initial);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const write = useAtomCommand(projectEnvironment.writeFile, { reportFailure: false });
  const changed = JSON.stringify(draft) !== JSON.stringify(baseline);
  if (JSON.stringify(lastLoaded) !== JSON.stringify(props.initial)) {
    setLastLoaded(props.initial);
    if (!changed) {
      setDraft(props.initial);
      setBaseline(props.initial);
    }
  }
  const savedChanged = JSON.stringify(props.initial) !== JSON.stringify(baseline);
  async function save(next: DoerContext) {
    if (busy) return;
    if (JSON.stringify(props.initial) !== JSON.stringify(baseline)) {
      setMessage(
        "Saved details changed while you were editing. Your draft is kept. Discard changes to load the saved version before editing again.",
      );
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      const result = await write({
        environmentId: props.environmentId,
        input: {
          cwd: props.cwd,
          relativePath: props.relativePath,
          contents: JSON.stringify(next, null, 2) + "\n",
        },
      });
      if (result._tag === "Failure") {
        setMessage("Could not save your details. Your edits are kept. Reconnect and try again.");
        return;
      }
      setDraft(next);
      setBaseline(next);
      setMessage("Saved. These details apply to your next message and new Tasks.");
      props.onSaved();
    } catch {
      setMessage("Could not save your details. Your edits are kept. Try again.");
    } finally {
      setBusy(false);
    }
  }
  const prefix = props.personal ? "personal" : "space";
  return (
    <SettingsSection
      id={props.personal ? "personal-preferences" : "space-context"}
      title={props.personal ? "Personal preferences" : "About this Space"}
    >
      <p className="text-sm text-muted-foreground">
        {props.personal
          ? "Used across your Spaces on the selected computer."
          : "Used for Tasks in this Space, including reminders."}{" "}
        You choose what Doer remembers. Review, edit or forget it here.
      </p>
      {(["about", "preferences", "remembered"] as const).map((field) => (
        <div key={field} className="flex flex-col gap-1.5">
          <Label htmlFor={`${prefix}-${field}`}>
            {field === "about"
              ? props.personal
                ? "About you"
                : "What is this Space for?"
              : field === "preferences"
                ? "Preferences"
                : "Remembered details"}
          </Label>
          <Textarea
            id={`${prefix}-${field}`}
            value={draft[field]}
            rows={3}
            maxLength={8000}
            disabled={busy}
            placeholder={
              field === "about"
                ? "Work reports, job search, family planning…"
                : field === "preferences"
                  ? "Use rupees, concise summaries and my report template…"
                  : "Preferred roles, locations, definitions or reference file names…"
            }
            onChange={(event) => setDraft({ ...draft, [field]: event.target.value })}
          />
        </div>
      ))}
      <p className="text-xs text-muted-foreground">
        Keep passwords and sign-in codes out of saved details. Facts in an attached document are
        used for that Task unless you choose to save them here.
      </p>
      <div className="flex gap-2">
        <Button size="sm" disabled={busy || !changed} onClick={() => void save(draft)}>
          {busy ? "Saving…" : "Save details"}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={busy || !Object.values(draft).some(Boolean)}
          onClick={() => void save(EMPTY_DOER_CONTEXT)}
        >
          Forget these details
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={busy || (!changed && !savedChanged)}
          onClick={() => {
            setDraft(props.initial);
            setBaseline(props.initial);
          }}
        >
          Discard changes
        </Button>
      </div>
      {message ? (
        <p role="status" className="text-sm text-muted-foreground">
          {message}
        </p>
      ) : null}
    </SettingsSection>
  );
}
