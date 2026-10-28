import type { Preview } from "@storybook/react";
import { ViewerRoot, type Theme } from "../src/index.js";
import "../src/fonts.js";
import "./preview.css";

// Every story renders inside ViewerRoot with the toolbar's theme, so each
// state can be checked in dark and light. Visual tests (M4a.8) pick the theme
// with the URL global `&globals=theme:light`.
const preview: Preview = {
  globalTypes: {
    theme: {
      description: "Color theme",
      toolbar: {
        title: "Theme",
        icon: "mirror",
        items: [
          { value: "dark", title: "Dark" },
          { value: "light", title: "Light" },
        ],
        dynamicTitle: true,
      },
    },
  },
  initialGlobals: { theme: "dark" },
  parameters: { layout: "fullscreen" },
  decorators: [
    (Story, context) => (
      <ViewerRoot theme={context.globals["theme"] as Theme}>
        <Story />
      </ViewerRoot>
    ),
  ],
};

export default preview;
