// Shared UI primitives: class helper, icon set, buttons, spinner, rating.
import React, { useEffect, useState } from "react";

export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(" ");
}

// ---- Icons (24x24 stroke paths) ----
const PATHS: Record<string, React.ReactNode> = {
  dashboard: (
    <>
      <rect x="3" y="3" width="7" height="9" rx="1.5" />
      <rect x="14" y="3" width="7" height="5" rx="1.5" />
      <rect x="14" y="12" width="7" height="9" rx="1.5" />
      <rect x="3" y="16" width="7" height="5" rx="1.5" />
    </>
  ),
  book: (
    <>
      <path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v15H6.5A2.5 2.5 0 0 0 4 20.5Z" />
      <path d="M4 20.5A2.5 2.5 0 0 1 6.5 18H20" />
    </>
  ),
  books: (
    <>
      <path d="M5 4h4v16H5zM11 4h4v16h-4z" />
      <path d="M17 5l3.5 15" />
    </>
  ),
  settings: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z" />
    </>
  ),
  scan: (
    <>
      <path d="M3 12a9 9 0 0 1 15-6.7L21 8" />
      <path d="M21 3v5h-5" />
      <path d="M21 12a9 9 0 0 1-15 6.7L3 16" />
      <path d="M3 21v-5h5" />
    </>
  ),
  sparkles: (
    <>
      <path d="M12 3v4M12 17v4M3 12h4M17 12h4" />
      <path d="M12 8.5 13.2 11l2.5 1-2.5 1L12 15.5 10.8 13l-2.5-1 2.5-1Z" />
    </>
  ),
  star: <path d="M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8L3.5 9.7l5.9-.9Z" />,
  folder: <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />,
  check: <path d="M20 6 9 17l-5-5" />,
  x: <path d="M18 6 6 18M6 6l12 12" />,
  warning: (
    <>
      <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" />
      <path d="M12 9v4M12 17h.01" />
    </>
  ),
  chevron: <path d="m9 18 6-6-6-6" />,
  search: (
    <>
      <circle cx="11" cy="11" r="7" />
      <path d="m21 21-4.3-4.3" />
    </>
  ),
  trash: (
    <>
      <path d="M4 7h16" />
      <path d="M10 11v6M14 11v6" />
      <path d="M5 7l1 13a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2l1-13" />
      <path d="M9 7V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v3" />
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </>
  ),
  pages: (
    <>
      <path d="M6 3h9l3 3v15H6z" />
      <path d="M14 3v4h4" />
      <path d="M9 12h6M9 16h6" />
    </>
  ),
  words: (
    <>
      <path d="M4 7V5h16v2" />
      <path d="M9 19h6" />
      <path d="M12 5v14" />
    </>
  ),
  flame: (
    <path d="M12 3s5 4 5 9a5 5 0 0 1-10 0c0-1.6.8-3 1.6-4C9 8.5 9 7 8.5 6c2 .5 3 2 3.5 3 .3-2 0-4 0-6Z" />
  ),
  open: (
    <>
      <path d="M15 3h6v6" />
      <path d="M10 14 21 3" />
      <path d="M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5" />
    </>
  ),
  bookmark: <path d="M6 3h12v18l-6-4-6 4Z" />,
  comics: (
    <>
      <rect x="3" y="4" width="12" height="16" rx="1.6" />
      <path d="M17 6.5h2.6A1.4 1.4 0 0 1 21 7.9v10.7a1.4 1.4 0 0 1-1.4 1.4H17" />
      <path d="M6.5 8.5h5M6.5 12h5M6.5 15.5h3" />
    </>
  ),
  list: (
    <>
      <path d="M8 6h13M8 12h13M8 18h13" />
      <path d="M3.5 6h.01M3.5 12h.01M3.5 18h.01" />
    </>
  ),
  grid: (
    <>
      <rect x="3" y="3" width="7.5" height="7.5" rx="1.5" />
      <rect x="13.5" y="3" width="7.5" height="7.5" rx="1.5" />
      <rect x="3" y="13.5" width="7.5" height="7.5" rx="1.5" />
      <rect x="13.5" y="13.5" width="7.5" height="7.5" rx="1.5" />
    </>
  ),
  type: (
    <>
      <path d="M3 18 8 6l5 12" />
      <path d="M4.6 14.5h6.8" />
      <path d="M20.5 18v-5.2a2.4 2.4 0 0 0-4.6-1" />
      <path d="M20.5 15.2c-3 0-4.5.6-4.5 1.9a1.5 1.5 0 0 0 1.7 1.4c1.5 0 2.8-1 2.8-2.2Z" />
    </>
  ),
  expand: (
    <>
      <path d="M8 3H5a2 2 0 0 0-2 2v3" />
      <path d="M16 3h3a2 2 0 0 1 2 2v3" />
      <path d="M8 21H5a2 2 0 0 1-2-2v-3" />
      <path d="M16 21h3a2 2 0 0 0 2-2v-3" />
    </>
  ),
  collapse: (
    <>
      <path d="M3 8h3a2 2 0 0 0 2-2V3" />
      <path d="M21 8h-3a2 2 0 0 1-2-2V3" />
      <path d="M3 16h3a2 2 0 0 1 2 2v3" />
      <path d="M21 16h-3a2 2 0 0 0-2 2v3" />
    </>
  ),
  onePage: <rect x="7" y="4" width="10" height="16" rx="1.5" />,
  twoPage: (
    <>
      <rect x="3" y="4" width="8" height="16" rx="1.5" />
      <rect x="13" y="4" width="8" height="16" rx="1.5" />
    </>
  ),
  read: (
    <>
      <path d="M12 7.5C10.5 6 8.5 5.2 6 5.2c-1 0-2 .1-3 .4v12.6c1-.3 2-.4 3-.4 2.5 0 4.5.8 6 2.3" />
      <path d="M12 7.5c1.5-1.5 3.5-2.3 6-2.3 1 0 2 .1 3 .4v12.6c-1-.3-2-.4-3-.4-2.5 0-4.5.8-6 2.3Z" />
      <path d="M12 7.5v12.6" />
    </>
  ),
};

export function Icon({
  name,
  className,
  filled,
}: {
  name: keyof typeof PATHS | string;
  className?: string;
  filled?: boolean;
}) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={className}
      fill={filled ? "currentColor" : "none"}
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {PATHS[name] ?? null}
    </svg>
  );
}

/** The Shelfmark mark — mirrors the app icon (see app-icon.svg). */
export function Logo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 1024 1024" className={className} xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="bv-tile" x1="0" y1="0" x2="1024" y2="1024" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#3b0764" />
          <stop offset="0.55" stopColor="#240a45" />
          <stop offset="1" stopColor="#12031f" />
        </linearGradient>
      </defs>
      <rect width="1024" height="1024" rx="225" fill="url(#bv-tile)" />
      <rect x="252" y="282" width="150" height="530" rx="40" fill="#ede9fe" />
      <rect x="437" y="242" width="150" height="570" rx="40" fill="#a78bfa" />
      <rect x="622" y="282" width="150" height="530" rx="40" fill="#ede9fe"
            transform="rotate(13 697 812)" />
    </svg>
  );
}

export function Spinner({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={cx("bv-spin", className)} fill="none">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.2" strokeWidth="3" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

type BtnProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "ghost" | "subtle" | "danger";
  busy?: boolean;
};

export function Button({ variant = "subtle", busy, className, children, disabled, ...rest }: BtnProps) {
  const base =
    "inline-flex items-center gap-2 rounded-lg px-3.5 py-2 text-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed";
  const styles = {
    // `text-on-accent` rather than `text-white`: on a filled button the label
    // has to stay light in both themes, and in light mode `white` is redefined
    // to ink so that every hairline and panel tint inverts with it.
    primary: "bg-accent-600 hover:bg-accent-500 text-on-accent shadow-lg shadow-accent-950/40",
    ghost: "hover:bg-white/5 text-slate-300",
    subtle: "bg-white/5 hover:bg-white/10 text-slate-200 border border-white/10",
    danger: "bg-rose-600/90 hover:bg-rose-500 text-on-accent",
  }[variant];
  return (
    <button className={cx(base, styles, className)} disabled={disabled || busy} {...rest}>
      {busy && <Spinner className="w-4 h-4" />}
      {children}
    </button>
  );
}

/** Interactive 1–5 star ranking. Clicking the current value clears it. */
export function StarRating({
  value,
  onChange,
  size = "h-4 w-4",
}: {
  value: number | null;
  onChange?: (v: number | null) => void;
  size?: string;
}) {
  const [hover, setHover] = React.useState<number | null>(null);
  const shown = hover ?? value ?? 0;
  const readOnly = !onChange;
  return (
    <div className={cx("flex items-center gap-0.5", readOnly ? "text-amber-400" : "text-amber-400")}>
      {[1, 2, 3, 4, 5].map((i) => (
        <button
          key={i}
          type="button"
          disabled={readOnly}
          onMouseEnter={() => !readOnly && setHover(i)}
          onMouseLeave={() => !readOnly && setHover(null)}
          onClick={() => onChange?.(value === i ? null : i)}
          className={cx(!readOnly && "cursor-pointer transition-transform hover:scale-110")}
          title={readOnly ? undefined : `${i} star${i > 1 ? "s" : ""}`}
        >
          <Icon name="star" filled={i <= shown} className={cx(size, i <= shown ? "text-amber-400" : "text-slate-600")} />
        </button>
      ))}
    </div>
  );
}

export function Badge({
  children,
  tone = "slate",
}: {
  children: React.ReactNode;
  tone?: "slate" | "green" | "amber" | "rose" | "accent" | "blue";
}) {
  const tones = {
    slate: "bg-white/5 text-slate-300 border-white/10",
    green: "bg-emerald-500/10 text-emerald-300 border-emerald-500/20",
    amber: "bg-amber-500/10 text-amber-300 border-amber-500/20",
    rose: "bg-rose-500/10 text-rose-300 border-rose-500/20",
    accent: "bg-accent-500/10 text-accent-300 border-accent-500/20",
    blue: "bg-sky-500/10 text-sky-300 border-sky-500/20",
  }[tone];
  return (
    <span className={cx("inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs font-medium", tones)}>
      {children}
    </span>
  );
}

/** Colour + label for a reading status. */
export function statusMeta(status: string): { label: string; tone: "slate" | "accent" | "green" } {
  switch (status) {
    case "reading":
      return { label: "Reading", tone: "accent" };
    case "finished":
      return { label: "Finished", tone: "green" };
    default:
      return { label: "Unread", tone: "slate" };
  }
}

/**
 * The time, for a reader's chrome.
 *
 * Reading fullscreen hides the taskbar, and the usual reason to leave a book is
 * that it has got late. Having it here means not breaking out of the page to
 * find out.
 *
 * It ticks on the minute rather than every minute from whenever the reader
 * opened: a timer started at some arbitrary moment sits up to fifty-nine
 * seconds behind the clock it is meant to be reporting.
 */
export function Clock({ className }: { className?: string }) {
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    let interval: ReturnType<typeof setInterval> | undefined;
    const tick = () => setNow(new Date());
    const start = setTimeout(() => {
      tick();
      interval = setInterval(tick, 60_000);
    }, 60_000 - (Date.now() % 60_000));
    return () => {
      clearTimeout(start);
      if (interval) clearInterval(interval);
    };
  }, []);

  return (
    <div
      className={cx("shrink-0 text-[12px] tabular-nums text-white/50", className)}
      // The full date and time on hover, for the once in a while it is wanted.
      title={now.toLocaleString()}
    >
      {/* The reader's locale decides the shape: a 24-hour clock is not
          universal, and guessing wrong is worse than asking. */}
      {now.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}
    </div>
  );
}
