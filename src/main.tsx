import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import ReaderWindow from "./pages/ReaderWindow";
import ImageViewerWindow from "./pages/ImageViewerWindow";
import { applyAppearance, loadAppearance } from "./appearance";

// Reader windows load this same bundle with `?book=<id>`; anything else is the
// library. One entry point means one build and no duplicated styling.
const params = new URLSearchParams(location.search);
const bookId = Number(params.get("book"));
const imageToken = params.get("image") ?? "";
const isReader = Number.isFinite(bookId) && bookId > 0;
const isImageViewer = Boolean(imageToken);

// Before the first paint, so a light theme never flashes dark on the way in.
// The reader takes the accent but not the light/dark choice: its chrome is a
// frame around the page, and the page has its own theme.
applyAppearance(loadAppearance(), { theme: !isReader && !isImageViewer });

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    {isImageViewer ? (
      <ImageViewerWindow token={imageToken} />
    ) : isReader ? (
      <ReaderWindow bookId={bookId} />
    ) : (
      <App />
    )}
  </React.StrictMode>,
);
