import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { takeImageViewerPayload } from "../open-image";
import { Icon } from "../ui";

const MIN_ZOOM = 0.1;
const MAX_ZOOM = 8;

export default function ImageViewerWindow({ token }: { token: string }) {
  const payload = useMemo(() => takeImageViewerPayload(token), [token]);
  const [zoom, setZoom] = useState<number | null>(null);
  const [natural, setNatural] = useState({ width: 0, height: 0 });
  const [failed, setFailed] = useState(false);
  const [, setViewportVersion] = useState(0);
  const viewportRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (payload && "__TAURI_INTERNALS__" in window) {
      getCurrentWindow().setTitle(payload.title).catch(() => {});
    }
  }, [payload]);

  const setActualSize = useCallback(() => setZoom(1), []);
  const setFit = useCallback(() => setZoom(null), []);
  const stepZoom = useCallback((direction: 1 | -1) => {
    setZoom((current) => {
      const start = current ?? fitScale(viewportRef.current, natural);
      const factor = direction > 0 ? 1.25 : 0.8;
      return clamp(start * factor, MIN_ZOOM, MAX_ZOOM);
    });
  }, [natural]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const observer = new ResizeObserver(() => setViewportVersion((value) => value + 1));
    observer.observe(viewport);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "+" || event.key === "=") stepZoom(1);
      else if (event.key === "-") stepZoom(-1);
      else if (event.key === "0") setActualSize();
      else if (event.key.toLowerCase() === "f") setFit();
      else if (event.key === "Escape" && "__TAURI_INTERNALS__" in window) {
        getCurrentWindow().close().catch(() => {});
      }
      else return;
      event.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setActualSize, setFit, stepZoom]);

  if (!payload) {
    return (
      <main className="grid h-full place-items-center bg-[#171816] p-8 text-center text-sm text-slate-300">
        This image is no longer available. Double-click it again in the book.
      </main>
    );
  }

  const percent = Math.round((zoom ?? fitScale(viewportRef.current, natural)) * 100);
  const actual = zoom === 1;

  return (
    <main className="flex h-full select-none flex-col overflow-hidden bg-[#171816] text-slate-100">
      <header
        data-tauri-drag-region
        className="flex h-14 shrink-0 items-center gap-2 border-b border-white/10 bg-[#22231f] px-4"
      >
        <div data-tauri-drag-region className="min-w-0 flex-1 pl-16">
          <p data-tauri-drag-region className="truncate text-sm text-slate-300" title={payload.title}>
            {payload.title}
          </p>
        </div>
        <ViewerButton active={zoom === null} title="Fit the whole image (F)" onClick={setFit}>
          Fit
        </ViewerButton>
        <ViewerButton title="Zoom out (−)" onClick={() => stepZoom(-1)}>
          <Icon name="minus" className="h-4 w-4" />
        </ViewerButton>
        <ViewerButton active={actual} title="Actual pixels (0)" onClick={setActualSize} wide>
          {zoom === null ? `${Math.min(100, percent)}%` : `${percent}%`}
        </ViewerButton>
        <ViewerButton title="Zoom in (+)" onClick={() => stepZoom(1)}>
          <Icon name="plus" className="h-4 w-4" />
        </ViewerButton>
      </header>

      <div
        ref={viewportRef}
        className="min-h-0 flex-1 overflow-auto bg-[radial-gradient(circle_at_center,#2d2e29_0,#171816_72%)]"
      >
        {failed ? (
          <div className="grid h-full place-items-center p-8 text-sm text-slate-300">
            The image could not be loaded.
          </div>
        ) : (
          <div
            className={`flex items-center justify-center p-5 ${
              zoom === null ? "h-full w-full" : "min-h-full min-w-full"
            }`}
            style={zoom === null ? undefined : { width: "max-content", height: "max-content" }}
          >
            <img
              src={payload.src}
              alt={payload.alt}
              draggable={false}
              onLoad={(event) => {
                setNatural({
                  width: event.currentTarget.naturalWidth,
                  height: event.currentTarget.naturalHeight,
                });
              }}
              onError={() => setFailed(true)}
              onDoubleClick={() => setZoom((current) => (current === null ? 1 : null))}
              className="block shrink-0 object-contain shadow-2xl shadow-black/50"
              style={
                zoom === null
                  ? { maxWidth: "100%", maxHeight: "100%", width: "auto", height: "auto" }
                  : {
                      width: natural.width ? `${natural.width * zoom}px` : "auto",
                      height: natural.height ? `${natural.height * zoom}px` : "auto",
                      maxWidth: "none",
                      maxHeight: "none",
                    }
              }
            />
          </div>
        )}
      </div>
    </main>
  );
}

function ViewerButton({
  children,
  title,
  onClick,
  active = false,
  wide = false,
}: {
  children: React.ReactNode;
  title: string;
  onClick: () => void;
  active?: boolean;
  wide?: boolean;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-pressed={active || undefined}
      onClick={onClick}
      className={`grid h-8 place-items-center rounded-lg border text-xs font-medium transition-colors ${
        wide ? "min-w-14 px-2" : "min-w-8 px-2"
      } ${
        active
          ? "border-accent-500/60 bg-accent-500/20 text-accent-300"
          : "border-white/10 bg-white/5 text-slate-300 hover:bg-white/10 hover:text-white"
      }`}
    >
      {children}
    </button>
  );
}

function fitScale(
  viewport: HTMLDivElement | null,
  natural: { width: number; height: number },
): number {
  if (!viewport || !natural.width || !natural.height) return 1;
  const width = Math.max(1, viewport.clientWidth - 40);
  const height = Math.max(1, viewport.clientHeight - 40);
  return Math.min(1, width / natural.width, height / natural.height);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
