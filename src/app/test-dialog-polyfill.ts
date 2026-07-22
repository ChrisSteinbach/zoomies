// jsdom doesn't implement HTMLDialogElement methods — polyfill minimally.
// Ported from tour-guide's test-dialog-polyfill.ts: about.test.ts is the only
// place that needs it, so it is imported for its side effect there rather
// than wired into a global test setup.
/* eslint-disable @typescript-eslint/unbound-method */
if (typeof HTMLDialogElement !== "undefined") {
  HTMLDialogElement.prototype.showModal ??= function () {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close ??= function () {
    this.removeAttribute("open");
    this.dispatchEvent(new Event("close"));
  };
}
/* eslint-enable @typescript-eslint/unbound-method */
