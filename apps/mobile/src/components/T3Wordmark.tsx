import type { ColorValue, StyleProp, TextStyle } from "react-native";

import { AppText as Text } from "./AppText";

export function T3Wordmark(props: {
  readonly height: number;
  readonly color?: ColorValue;
  readonly colorClassName?: string;
  readonly style?: StyleProp<TextStyle>;
}) {
  return (
    <Text
      accessibilityLabel="Doer"
      className={props.colorClassName}
      style={[
        {
          color: props.color,
          fontSize: props.height,
          fontWeight: "700",
          letterSpacing: -0.6,
          lineHeight: props.height,
        },
        props.style,
      ]}
    >
      doer
    </Text>
  );
}
