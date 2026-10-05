import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { Link } from "@tanstack/react-router";
import { MailIcon, PlugIcon, PresentationIcon, Settings2Icon, SheetIcon } from "lucide-react";
import { useRef, useState } from "react";

import { useEnvironment } from "../../state/environments";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { GmailConnectionControl } from "../settings/GmailConnectionControl";
import {
  Menu,
  MenuCheckboxItem,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuTrigger,
} from "../ui/menu";
import {
  ComposerControl,
  ComposerControlChevron,
  ComposerControlIcon,
  type ComposerControlSize,
} from "./ComposerControl";
import { useComposerMenuProps } from "./composerEventScope";
import { useComposerMenuState } from "./useComposerMenuState";

const plugins = [
  {
    key: "enableGmailAccess",
    name: "Gmail",
    description: "Review and send emails",
    icon: MailIcon,
    color: "text-red-500 dark:text-red-400",
  },
  {
    key: "enableLocalSpreadsheetAccess",
    name: "Excel",
    description: "Read and edit local .xlsx files",
    icon: SheetIcon,
    color: "text-emerald-600 dark:text-emerald-400",
  },
  {
    key: "enableLocalPresentationAccess",
    name: "PowerPoint",
    description: "Read and edit local .pptx files",
    icon: PresentationIcon,
    color: "text-orange-600 dark:text-orange-400",
  },
] as const;

export function ComposerPluginsMenu({
  environmentId,
  projectId,
  size = "sm",
  hidden = false,
  embedded = false,
}: {
  environmentId: EnvironmentId;
  projectId: ProjectId | null;
  size?: ComposerControlSize;
  hidden?: boolean;
  /** The narrow composer exposes the same switches in its overflow menu. */
  embedded?: boolean;
}) {
  const environment = useEnvironment(environmentId);
  const config = environment?.serverConfig;
  const settings = config ? resolveProjectSettings(config.settings, projectId).settings : null;
  const persist = useAtomCommand(serverEnvironment.updateSettings, "save plugin settings");
  const [saving, setSaving] = useState(false);
  const [requestConnection, setRequestConnection] = useState(false);
  const savingRef = useRef(false);
  const [open, setOpen] = useComposerMenuState(hidden);
  const floatingLayerProps = useComposerMenuProps();
  const unavailableReason =
    projectId === null
      ? "Choose a Space to use plugins."
      : environment?.connection.phase !== "connected" || !config
        ? "Connect to this computer to change plugins."
        : config.environment.capabilities.projectSettingsOverrides !== true
          ? "Update Doer on this computer to use Space plugins."
          : null;
  const activeCount = settings ? plugins.filter((plugin) => settings[plugin.key]).length : 0;

  const toggle = async (key: (typeof plugins)[number]["key"], enabled: boolean) => {
    if (unavailableReason || !config || projectId === null || savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    try {
      const result = await persist({
        environmentId,
        input: {
          patch: {
            projectSettingsOverrides: {
              [projectId]: {
                ...config.settings.projectSettingsOverrides[projectId],
                [key]: enabled,
              },
            },
          },
        },
      });
      if (result._tag === "Success" && key === "enableGmailAccess") {
        setRequestConnection(enabled);
      }
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  const content = (
    <>
      <div className="px-2 py-2">
        <div className="text-xs font-medium text-foreground">Plugins</div>
        <p className="mt-1 text-xs leading-4 text-muted-foreground">
          {unavailableReason ?? "Allow tools in this Space. Changes apply to its tasks."}
        </p>
      </div>
      {plugins.map(({ key, name, description, icon: Icon, color }) => (
        <MenuCheckboxItem
          key={key}
          variant="switch"
          checked={settings?.[key] ?? false}
          disabled={saving || unavailableReason !== null}
          onCheckedChange={(enabled) => void toggle(key, enabled)}
          closeOnClick={false}
          className="min-h-12 py-2 sm:min-h-12"
        >
          <span className="flex items-center gap-2.5">
            <span className="grid size-8 shrink-0 place-items-center rounded-lg border border-border/60 bg-muted/40">
              <Icon aria-hidden="true" className={`size-4 ${color}`} />
            </span>
            <span className="grid gap-0.5">
              <span className="text-sm font-medium">{name}</span>
              <span className="text-xs leading-4 text-muted-foreground">{description}</span>
            </span>
          </span>
        </MenuCheckboxItem>
      ))}
      {unavailableReason === null && settings ? (
        <div className="flex flex-wrap items-center gap-2 px-2 pt-1 text-xs [&>div]:flex-wrap [&>div>span]:break-all">
          <GmailConnectionControl
            key={environmentId}
            environmentId={environmentId}
            enabled={settings.enableGmailAccess}
            autoConnect={requestConnection}
          />
        </div>
      ) : null}
      <MenuSeparator />
      <MenuItem
        render={
          <Link
            to="/settings/integrations"
            search={{ machine: environmentId }}
            hash="connected-tools"
          />
        }
      >
        <Settings2Icon aria-hidden="true" />
        Manage plugins in Settings
      </MenuItem>
    </>
  );

  if (embedded) return content;

  return (
    <Menu open={open} onOpenChange={setOpen}>
      <MenuTrigger
        render={
          <ComposerControl
            size={size}
            className="shrink-0 whitespace-nowrap"
            aria-label={`Plugins${activeCount ? `, ${activeCount} enabled in this Space` : ""}`}
          />
        }
      >
        <ComposerControlIcon icon={PlugIcon} size={size} />
        <span data-composer-control-label>Plugins{activeCount > 0 ? ` · ${activeCount}` : ""}</span>
        <ComposerControlChevron size={size} />
      </MenuTrigger>
      <MenuPopup
        align="start"
        side="top"
        className="w-72 max-w-[calc(100vw-2rem)]"
        {...floatingLayerProps}
      >
        {content}
      </MenuPopup>
    </Menu>
  );
}
