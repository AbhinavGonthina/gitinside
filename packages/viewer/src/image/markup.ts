import { Fragment, isValidElement, type ReactNode } from "react";
import { glyphs, type GlyphName } from "../icons/glyphs.js";

/**
 * Building blocks for SVG written as text (the README badge and live image,
 * M5.9). These images are served from our own origin, so every string from a
 * graph (package names, hosts, paths: all chosen by whoever owns the repo)
 * goes through {@link esc}, and no attribute is ever built from one unescaped.
 */

/**
 * XML 1.0 can't carry most control characters or lone surrogates, even
 * escaped, and a browser refuses the whole image if it sees one.
 */
const NOT_XML = new RegExp(
  [
    "[\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f\\ufffe\\uffff]",
    "[\\ud800-\\udbff](?![\\udc00-\\udfff])",
    "(?<![\\ud800-\\udbff])[\\udc00-\\udfff]",
  ].join("|"),
  "g",
);

/** Text or an attribute value made safe for XML: `& < > " '` escaped, unencodable characters replaced with U+FFFD. */
export function esc(text: string): string {
  return text
    .replace(NOT_XML, "�")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** A number as SVG text: at most two decimals, never `-0`. */
export function num(n: number): string {
  const r = Math.round(n * 100) / 100;
  return String(Object.is(r, -0) ? 0 : r);
}

/** `name="value"` pairs, escaped, in the given order; `undefined` values are left out. */
export function attrs(values: Readonly<Record<string, string | number | undefined>>): string {
  return Object.entries(values)
    .filter((entry): entry is [string, string | number] => entry[1] !== undefined)
    .map(([k, v]) => ` ${k}="${esc(typeof v === "number" ? num(v) : v)}"`)
    .join("");
}

/** React's camelCase SVG props as attribute names (`strokeDasharray` ⇒ `stroke-dasharray`). */
function attributeName(prop: string): string {
  return prop.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
}

/**
 * The SVG markup of a glyph's artwork (`glyphs[name].body`), so the image and
 * the canvas draw the same glyph from one source. The bodies are plain
 * elements and fragments; anything else (a component, a non-string prop)
 * throws, because it would be drawn differently here.
 */
export function glyphMarkup(name: GlyphName): string {
  return elementMarkup(glyphs[name].body);
}

function elementMarkup(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (Array.isArray(node)) return node.map(elementMarkup).join("");
  if (!isValidElement<Record<string, unknown>>(node)) {
    throw new Error("glyph artwork may only hold SVG elements");
  }
  const { children, ...props } = node.props;
  if (node.type === Fragment) return elementMarkup(children as ReactNode);
  if (typeof node.type !== "string") throw new Error("glyph artwork may only hold SVG elements");
  const pairs: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(props)) {
    if (typeof value !== "string" && typeof value !== "number") {
      throw new Error(`glyph prop ${key} isn't a string or number`);
    }
    pairs[attributeName(key)] = value;
  }
  const inner = elementMarkup(children as ReactNode);
  return inner === ""
    ? `<${node.type}${attrs(pairs)}/>`
    : `<${node.type}${attrs(pairs)}>${inner}</${node.type}>`;
}

/**
 * Width of a character in ems for a sans face, roughly (Geist / system UI).
 * Image text can't be measured on the server, so text is sized from these and
 * cut short with an ellipsis well before it could overflow.
 */
function sansEm(c: string): number {
  if (" il.,:;'|!`".includes(c)) return 0.28;
  if ("fjrt()[]{}/\\-".includes(c)) return 0.38;
  if ("mwMW@".includes(c)) return 0.86;
  if (/[A-Z]/.test(c)) return 0.68;
  if (/[0-9]/.test(c)) return 0.6;
  return 0.56;
}

/** Monospace characters are 0.6em in every face the stack names. */
const MONO_EM = 0.6;

/** Estimated width in px of `text` at `size` px, sans or mono, a little on the wide side. */
export function textWidth(text: string, size: number, mono = false): number {
  let ems = 0;
  for (const c of text) ems += mono ? MONO_EM : sansEm(c);
  return ems * size;
}

/** `text`, cut with "…" so its estimated width is at most `max` px. */
export function fit(text: string, max: number, size: number, mono = false): string {
  if (textWidth(text, size, mono) <= max) return text;
  const chars = [...text];
  while (chars.length > 0 && textWidth(`${chars.join("")}…`, size, mono) > max) chars.pop();
  return `${chars.join("").trimEnd()}…`;
}
