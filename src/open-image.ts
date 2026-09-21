import { WebviewWindow } from "@tauri-apps/api/webviewWindow";

export type ImageViewerPayload = {
  src: string;
  title: string;
  alt: string;
};

const STORAGE_PREFIX = "shelfmark.image-viewer.";
let nextWindow = 0;
const claimedPayloads = new Map<string, ImageViewerPayload>();

/**
 * Open an image already resolved by the EPUB frame in an isolated viewer.
 *
 * The payload goes through localStorage instead of the query string. EPUBs may
 * legally embed an illustration as a large data URL, and putting that in a
 * window URL is both fragile and likely to exceed platform URL limits.
 */
export function openImageViewer(src: string, title: string, alt = ""): void {
  if (!isReadableImage(src)) return;

  const token = `${Date.now().toString(36)}-${(++nextWindow).toString(36)}`;
  const key = `${STORAGE_PREFIX}${token}`;
  const payload: ImageViewerPayload = {
    src,
    title: title.trim().slice(0, 180) || "EPUB image",
    alt: alt.trim().slice(0, 500),
  };
  localStorage.setItem(key, JSON.stringify(payload));

  const win = new WebviewWindow(`image-${token}`, {
    url: `index.html?image=${encodeURIComponent(token)}`,
    title: payload.title,
    width: 1000,
    height: 760,
    minWidth: 420,
    minHeight: 320,
    center: true,
    titleBarStyle: "overlay",
    hiddenTitle: true,
  });

  win.once("tauri://error", (event) => {
    localStorage.removeItem(key);
    alert(`Couldn't open the image: ${JSON.stringify(event.payload)}`);
  });
  win.once("tauri://destroyed", () => localStorage.removeItem(key));
}

/** Read-once handoff used by the newly created image window. */
export function takeImageViewerPayload(token: string): ImageViewerPayload | null {
  if (!/^[a-z0-9-]+$/i.test(token)) return null;
  const claimed = claimedPayloads.get(token);
  if (claimed) return claimed;
  const key = `${STORAGE_PREFIX}${token}`;
  const raw = localStorage.getItem(key);
  localStorage.removeItem(key);
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<ImageViewerPayload>;
    if (typeof value.src !== "string" || !isReadableImage(value.src)) return null;
    const payload = {
      src: value.src,
      title: typeof value.title === "string" ? value.title : "EPUB image",
      alt: typeof value.alt === "string" ? value.alt : "",
    };
    // React StrictMode intentionally evaluates a new tree twice in development.
    // Keep the read-once payload in this window after removing the shared copy.
    claimedPayloads.set(token, payload);
    return payload;
  } catch {
    return null;
  }
}

/** Only sources the chapter CSP itself permits can cross into the viewer. */
function isReadableImage(src: string): boolean {
  return (
    src.startsWith("http://bookres.localhost/") ||
    src.startsWith("bookres://localhost/") ||
    src.startsWith("data:image/") ||
    src.startsWith("blob:")
  );
}
