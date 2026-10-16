import { useNavigation } from "@react-navigation/native";
import type { ComponentType } from "react";
import { View } from "react-native";

import { EmptyState } from "../../components/EmptyState";
import { ScreenHeader } from "../../components/ScreenHeader";
import { useSimpleModeEnabled } from "../threads/use-simple-mode-enabled";

/** Register once with the navigator so hidden routes cannot mount their controls or queries. */
export function withAdvancedMode<Props extends object>(Screen: ComponentType<Props>) {
  return function AdvancedModeRoute(props: Props) {
    const simple = useSimpleModeEnabled();
    const navigation = useNavigation();
    if (!simple) return <Screen {...props} />;
    return (
      <View className="flex-1 bg-screen">
        <ScreenHeader title="Advanced mode" />
        <View className="flex-1 items-center justify-center">
          <EmptyState
            variant="plain"
            title="Available in Advanced mode"
            detail="Turn off Simple Mode in Settings → Tasks to use this feature."
            actionLabel="Open settings"
            onAction={() =>
              navigation.navigate("SettingsSheet", {
                screen: "SettingsContent",
                params: { screen: "SettingsThreads" },
              })
            }
          />
        </View>
      </View>
    );
  };
}
