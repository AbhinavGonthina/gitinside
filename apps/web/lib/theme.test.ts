// @vitest-environment node
import { describe, expect, it } from "vitest";
import { parseTheme, THEME_COOKIE, themeCookie } from "./theme";

describe("parseTheme", () => {
  it("is light only when the cookie says so", () => {
    expect(parseTheme("light")).toBe("light");
  });

  it.each([undefined, "", "dark", "LIGHT", "blue", "light; x=1"])("is dark for %j", (value) => {
    expect(parseTheme(value)).toBe("dark");
  });
});

describe("themeCookie", () => {
  it("remembers the choice for a year across the site", () => {
    expect(themeCookie("light", false)).toBe(
      `${THEME_COOKIE}=light; Path=/; Max-Age=31536000; SameSite=Lax`,
    );
  });

  it("is Secure over https", () => {
    expect(themeCookie("dark", true)).toMatch(/; Secure$/);
  });
});
