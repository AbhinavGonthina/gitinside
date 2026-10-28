import type { ButtonHTMLAttributes, HTMLAttributes, KeyboardEvent, ReactNode } from "react";
import { useRef } from "react";
import { UiIcon, type UiIconName } from "./uiIcons.js";

/**
 * The chrome's controls (DESIGN_SYSTEM.md §1: quiet, precise, keyboard-first).
 * They are plain, controlled components: they render state from props and
 * report changes through callbacks, so the explorer (M4b) owns the state.
 */

/**
 * Button emphasis: `primary` for the one main action on a surface ("Trace a
 * request"), `secondary` for bordered actions, `quiet` for toolbars and lists.
 */
export type ButtonVariant = "primary" | "secondary" | "quiet";

/** Props for {@link Button}. */
export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  /** `sm` is 28px tall (overlays, inspector), `md` is 32px (top bar). */
  size?: "sm" | "md";
  icon?: UiIconName | undefined;
  /** Keys shown after the label, e.g. `["T"]`. Decorative; set `aria-keyshortcuts` for assistive tech. */
  shortcut?: readonly string[] | undefined;
}

/** A labeled button with an optional leading icon and shortcut hint. */
export function Button({
  variant = "secondary",
  size = "md",
  icon,
  shortcut,
  children,
  className,
  type = "button",
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      {...rest}
      className={className ? `gi-button ${className}` : "gi-button"}
      data-variant={variant}
      data-size={size}
    >
      {icon && <UiIcon name={icon} />}
      {children !== undefined && <span className="gi-button__label">{children}</span>}
      {shortcut && <Kbd keys={shortcut} />}
    </button>
  );
}

/** Props for {@link IconButton}. */
export interface IconButtonProps
  extends Omit<ButtonProps, "icon" | "children" | "shortcut" | "aria-label"> {
  icon: UiIconName;
  /** The button's name, read by screen readers and shown as its tooltip. */
  label: string;
}

/** A square button with only an icon; `label` names it for screen readers and the tooltip. */
export function IconButton({ icon, label, variant = "quiet", title, ...rest }: IconButtonProps) {
  return (
    <Button
      {...rest}
      variant={variant}
      icon={icon}
      aria-label={label}
      title={title ?? label}
      data-icon-only=""
    />
  );
}

/** Keyboard keys as small caps-free key caps: `<Kbd keys={["Ctrl", "K"]} />`. */
export function Kbd({ keys }: { keys: readonly string[] }) {
  return (
    <span className="gi-kbd-group" aria-hidden>
      {keys.map((k) => (
        <kbd key={k} className="gi-kbd">
          {k}
        </kbd>
      ))}
    </span>
  );
}

/** Props for {@link Toggle}. */
export interface ToggleProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "onChange" | "role"> {
  checked: boolean;
  onChange?: ((checked: boolean) => void) | undefined;
  /** Visible label, which also names the switch. */
  children: ReactNode;
}

/** An on/off switch (`role="switch"`) with its label, e.g. "Hide tests and config". */
export function Toggle({ checked, onChange, children, className, ...rest }: ToggleProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      {...rest}
      className={className ? `gi-toggle ${className}` : "gi-toggle"}
      onClick={() => onChange?.(!checked)}
    >
      <span className="gi-toggle__track" aria-hidden>
        <span className="gi-toggle__thumb" />
      </span>
      <span className="gi-toggle__label">{children}</span>
    </button>
  );
}

/** One choice of a {@link SegmentedControl}. */
export interface Segment<T extends string> {
  value: T;
  label: string;
}

/** Props for {@link SegmentedControl}. */
export interface SegmentedControlProps<T extends string>
  extends Omit<HTMLAttributes<HTMLDivElement>, "onChange" | "role"> {
  /** Names the group for screen readers, e.g. "Diff view". */
  label: string;
  options: readonly Segment<T>[];
  value: T;
  onChange?: ((value: T) => void) | undefined;
}

/**
 * A small set of mutually exclusive choices, e.g. Base / Head / Overlay in
 * diff mode. It is a radio group: one tab stop, arrow keys move the choice.
 */
export function SegmentedControl<T extends string>({
  label,
  options,
  value,
  onChange,
  className,
  ...rest
}: SegmentedControlProps<T>) {
  const group = useRef<HTMLDivElement>(null);
  const move = (event: KeyboardEvent, index: number) => {
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
    if (step === undefined) return;
    event.preventDefault();
    const next = (index + step + options.length) % options.length;
    onChange?.((options[next] as Segment<T>).value);
    group.current?.querySelectorAll<HTMLButtonElement>("[role=radio]")[next]?.focus();
  };
  return (
    <div
      ref={group}
      role="radiogroup"
      aria-label={label}
      {...rest}
      className={className ? `gi-segmented ${className}` : "gi-segmented"}
    >
      {options.map((o, i) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          tabIndex={o.value === value ? 0 : -1}
          className="gi-segmented__option"
          onClick={() => onChange?.(o.value)}
          onKeyDown={(e) => move(e, i)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/**
 * What a status chip is about: `trace` (a trace is running), `diff` (comparing
 * two commits), or `neutral` (anything else, e.g. active filters).
 */
export type StatusTone = "trace" | "diff" | "neutral";

/** Props for {@link StatusChip}. */
export interface StatusChipProps extends HTMLAttributes<HTMLDivElement> {
  tone?: StatusTone;
  children: ReactNode;
  /** Shows a close button with this name ("Exit trace", "Clear filters"). */
  exitLabel?: string | undefined;
  onExit?: (() => void) | undefined;
}

/**
 * A mode chip on the canvas's top-left (UX.md "Status chips"): "Tracing
 * POST /api/orders", "Comparing main → PR #12". A trace gets a pulsing dot
 * in the trace color, a diff the compare icon (trace and diff-changed are
 * both amber, so color alone would blur them); the words always say it too.
 */
export function StatusChip({
  tone = "neutral",
  children,
  exitLabel,
  onExit,
  className,
  ...rest
}: StatusChipProps) {
  return (
    <div {...rest} className={className ? `gi-status ${className}` : "gi-status"} data-tone={tone}>
      {tone === "diff" ? (
        <UiIcon name="compare" size={14} />
      ) : (
        <span className="gi-status__dot" aria-hidden />
      )}
      <span className="gi-status__text">{children}</span>
      {exitLabel && <IconButton icon="close" label={exitLabel} size="sm" onClick={onExit} />}
    </div>
  );
}
