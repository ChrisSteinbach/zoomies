import { registerSW } from "virtual:pwa-register";
import { composeApp } from "./app/compose-app";
import { markLoad } from "./app/load-timeline";
import { createLoadReport } from "./app/load-report";
import "./styles.css";

// First line in the file that runs: everything the load report measures is
// "since this happened".
markLoad("boot");

// Install the service worker that precaches the app shell. `immediate` picks
// up a new build without waiting for every tab to close, which matches the
// plugin's `autoUpdate` strategy.
registerSW({ immediate: true });

const mount = document.querySelector<HTMLElement>("#app");
if (!mount) {
  throw new Error("Missing #app mount point in index.html");
}

composeApp(mount);

// On `document.body`, not inside `mount`: composeApp rebuilds everything
// under `mount` from scratch, which would delete the report the instant it
// mounted. Opt-in via ?perf — see load-report.ts — so this is a no-op for
// everyone who did not ask for it.
createLoadReport(document.body);
