import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, ProviderInstanceId, ServerProvider } from "@t3tools/contracts";
import { useRef, useState } from "react";

import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { SettingsRow } from "./settingsLayout";

/** Installation runs on the selected computer, including when controlling it remotely. */
export function CliSetupSection(props: {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly instanceId: ProviderInstanceId;
  readonly provider: ServerProvider | undefined;
  readonly displayName: string;
  readonly enabled: boolean;
  readonly readOnly: boolean;
}) {
  if (!props.provider?.setup?.canInstall) {
    return props.provider?.installed ? null : (
      <SettingsRow
        title="Setup"
        description="Update Doer on this computer to install this AI service automatically."
      />
    );
  }
  return <CliSetupActions {...props} />;
}

function CliSetupActions(props: Parameters<typeof CliSetupSection>[0]) {
  const target = { environmentId: props.environmentId, input: { instanceId: props.instanceId } };
  const query = useEnvironmentQuery(serverEnvironment.providerInstallState(target));
  const start = useAtomCommand(serverEnvironment.startProviderInstall, {
    reportFailure: false,
    reportDefect: false,
  });
  const cancel = useAtomCommand(serverEnvironment.cancelProviderInstall, {
    reportFailure: false,
    reportDefect: false,
  });
  const pendingRef = useRef(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const installation = query.data;
  const active =
    installation?.phase === "downloading" ||
    installation?.phase === "extracting" ||
    installation?.phase === "verifying";
  const installed = props.provider?.installed || installation?.phase === "succeeded";
  const failed = installation?.phase === "failed" || installation?.phase === "cancelled";
  const description =
    error ??
    (active || failed
      ? installation?.message
      : installed
        ? `Installed on ${props.environmentLabel}. ${props.provider?.auth.status === "authenticated" ? "Ready to use." : props.provider?.driver === "opencode" ? "Checking available models." : "Connect your account to use this service."}`
        : `Install ${props.displayName} on ${props.environmentLabel}. Doer will handle the download and setup.`);

  async function run(action: "start" | "cancel") {
    if (pendingRef.current) return;
    pendingRef.current = true;
    setPending(true);
    setError(null);
    try {
      const result =
        action === "cancel" && installation?.operationId
          ? await cancel({
              environmentId: props.environmentId,
              input: { instanceId: props.instanceId, operationId: installation.operationId },
            })
          : await start(target);
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        const cause = squashAtomCommandFailure(result);
        setError(cause instanceof Error ? cause.message : "Setup could not finish. Try again.");
      }
    } catch {
      setError("Could not connect to this computer. Try again when it reconnects.");
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  }
  return (
    <SettingsRow
      title={`${props.displayName} setup`}
      description={<span role={error || failed ? "alert" : "status"}>{description}</span>}
      control={
        active ? (
          <Button
            size="sm"
            variant="outline"
            disabled={props.readOnly || pending || !installation?.operationId}
            onClick={() => void run("cancel")}
          >
            Cancel setup
          </Button>
        ) : !installed || !props.enabled || failed ? (
          <Button
            size="sm"
            variant="outline"
            disabled={props.readOnly || pending || Boolean(query.error)}
            onClick={() => void run("start")}
          >
            {pending
              ? "Starting setup…"
              : failed
                ? "Try setup again"
                : `Install and enable ${props.displayName}`}
          </Button>
        ) : null
      }
    />
  );
}
