import { registerSW } from "virtual:pwa-register";
import { composeApp } from "./app/compose-app";
import "./styles.css";

// Install the service worker that precaches the app shell. `immediate` picks
// up a new build without waiting for every tab to close, which matches the
// plugin's `autoUpdate` strategy.
registerSW({ immediate: true });

const mount = document.querySelector<HTMLElement>("#app");
if (!mount) {
  throw new Error("Missing #app mount point in index.html");
}

composeApp(mount);
