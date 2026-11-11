import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

function auth() {
  const elements = new Map();
  const storage = new Map([["dmDeviceId", "a".repeat(64)]]);
  const calls = [];
  let signedIn = 0;
  const element = (id) => {
    if (!elements.has(id))
      elements.set(id, {
        value: "",
        textContent: "",
        disabled: false,
        hidden: false,
        setAttribute() {},
        removeAttribute() {},
        addEventListener() {},
        focus() {},
        classList: { toggle() {} },
      });
    return elements.get(id);
  };
  const context = vm.createContext({
    Aetheris: {
      getToken: () => "",
      storage: {
        getItem: (key) => storage.get(key) ?? null,
        setItem: (key, value) => storage.set(key, value),
        removeItem: (key) => storage.delete(key),
      },
    },
    document: { getElementById: element },
    sessionStorage: { setItem() {}, removeItem() {} },
    setTimeout,
    clearTimeout,
    AbortController,
    fetch: async (url, options) => {
      calls.push({ url, body: JSON.parse(options.body) });
      return {
        ok: true,
        json: async () => ({
          ok: true,
          token: "test-session-token",
          username: "ChatUser",
        }),
      };
    },
    showapp: () => {
      signedIn++;
    },
  });
  vm.runInContext(
    fs.readFileSync(
      new URL("../public/js/dm-shared.js", import.meta.url),
      "utf8",
    ),
    context,
  );
  element("f-user").value = "ChatUser";
  element("f-pass").value = "test-password";
  return { context, element, calls, signedIn: () => signedIn };
}

test("chat registration blocks password mismatches before sending credentials", async () => {
  const { context, element, calls } = auth();
  context.switchtab("register");
  element("f-confirm").value = "different-password";
  await context.submitauth();
  assert.equal(calls.length, 0);
  assert.match(element("auth-err").textContent, /match/);
  element("f-confirm").value = "test-password";
  await context.submitauth();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "/api/accounts/register");
  assert.equal(calls[0].body.deviceId, "a".repeat(64));
  assert.equal(element("f-confirm").value, "");
  assert.equal(element("f-pass").value, "");
});

test("chat login works without a device fingerprint and retains short legacy passwords", async () => {
  const { context, element, calls, signedIn } = auth();
  context.getdeviceid = () => {
    throw new Error("Device storage unavailable");
  };
  element("f-pass").value = "abcd";
  await context.submitauth();
  assert.equal(calls[0].url, "/api/accounts/login");
  assert.equal(Object.hasOwn(calls[0].body, "deviceId"), false);
  assert.equal(signedIn(), 1);
  assert.equal(element("auth-submit").disabled, false);
});
