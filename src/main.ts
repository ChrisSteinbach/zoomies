import "./styles.css";

/**
 * Placeholder entry point: mounts a heading so the toolchain has something
 * real to build and serve. The app itself is built out in later beads.
 */
const mount = document.querySelector<HTMLDivElement>("#app");
if (!mount) {
  throw new Error("Missing #app mount point in index.html");
}

const heading = document.createElement("h1");
heading.textContent = "Zoomies";

const tagline = document.createElement("p");
tagline.textContent = "Find somewhere for your dog to run.";

mount.append(heading, tagline);
