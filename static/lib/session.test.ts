import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { reloadToSignIn, signedOut } from "./session.ts";

const res = (status: number, contentType: string | null, type: ResponseType = "basic") =>
  ({ status, type, headers: new Headers(contentType ? { "content-type": contentType } : {}) });

test("Access's 401 for an expired session counts as signed out", () => {
  assert.equal(signedOut(res(401, "text/html")), true);
  assert.equal(signedOut(res(401, null)), true);
});

test("a redirect (Access sending the request to its login page) counts as signed out", () => {
  assert.equal(signedOut(res(0, null, "opaqueredirect")), true);
});

test("the app's own JSON 401 (GitHub rejected the token) is an ordinary error", () => {
  assert.equal(signedOut(res(401, "application/json; charset=utf-8")), false);
});

test("other statuses are not sign-in problems", () => {
  assert.equal(signedOut(res(200, "application/json")), false);
  assert.equal(signedOut(res(403, "text/plain; charset=utf-8")), false);
  assert.equal(signedOut(res(500, "text/html")), false);
});

// reloadToSignIn() reads the browser's sessionStorage and location; stub both on globalThis.
let reloads = 0;
function stubBrowser(storage: Pick<Storage, "getItem" | "setItem">): void {
  reloads = 0;
  Object.defineProperty(globalThis, "sessionStorage", { value: storage, configurable: true });
  Object.defineProperty(globalThis, "location", { value: { reload: () => { reloads++; } }, configurable: true });
}
function memoryStorage(): Pick<Storage, "getItem" | "setItem"> {
  const items = new Map<string, string>();
  return { getItem: (k) => items.get(k) ?? null, setItem: (k, v) => { items.set(k, v); } };
}

afterEach(() => {
  delete (globalThis as { sessionStorage?: unknown }).sessionStorage;
  delete (globalThis as { location?: unknown }).location;
});

test("the first sign-in reload goes ahead", () => {
  stubBrowser(memoryStorage());
  assert.equal(reloadToSignIn(1_000_000), true);
  assert.equal(reloads, 1);
});

test("a second reload within a minute is refused, so a refusing gate can't loop the page", () => {
  stubBrowser(memoryStorage());
  reloadToSignIn(1_000_000);
  assert.equal(reloadToSignIn(1_000_000 + 59_999), false);
  assert.equal(reloads, 1);
});

test("a reload a minute or more later goes ahead again", () => {
  stubBrowser(memoryStorage());
  reloadToSignIn(1_000_000);
  assert.equal(reloadToSignIn(1_000_000 + 60_000), true);
  assert.equal(reloads, 2);
});

test("blocked storage still reloads", () => {
  stubBrowser({
    getItem: () => { throw new Error("blocked"); },
    setItem: () => { throw new Error("blocked"); },
  });
  assert.equal(reloadToSignIn(1_000_000), true);
  assert.equal(reloads, 1);
});
