import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { restoreSession, installSessionPersistence } from "./session";
import "./styles/globals.css";

// Restore before the first render so the empty deck never flashes.
restoreSession();
installSessionPersistence();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
