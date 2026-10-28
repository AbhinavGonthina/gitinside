import type { Meta, StoryObj } from "@storybook/react";
import { ViewerRoot } from "./ViewerRoot.js";

const meta = {
  title: "Foundations/ViewerRoot",
  component: ViewerRoot,
  args: { children: "Everything inside inherits this theme." },
} satisfies Meta<typeof ViewerRoot>;

export default meta;
type Story = StoryObj<typeof meta>;

/** The default theme. */
export const Dark: Story = { args: { theme: "dark" } };

/** The light theme, nested inside the toolbar's theme to show it overrides. */
export const Light: Story = { args: { theme: "light" } };
