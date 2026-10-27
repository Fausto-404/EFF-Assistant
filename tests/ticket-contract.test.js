const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "../EFF-Assistant/background/service-worker.js"), "utf8");

function setup(reply) {
  const storage = {};
  const requests = [];
  const tabsOpened = [];
  const chrome = {
    runtime: { onInstalled: { addListener() {} }, onStartup: { addListener() {} }, onMessage: { addListener() {} } },
    tabs: {
      onUpdated: { addListener() {} }, onActivated: { addListener() {} },
      query: async () => [], create: async (tab) => tabsOpened.push(tab),
    },
    storage: { local: { get: async (key) => ({ [key]: storage[key] }), set: async (values) => Object.assign(storage, values) } },
  };
  const context = vm.createContext({
    chrome, URL, URLSearchParams, Headers, AbortController, structuredClone, setTimeout, clearTimeout,
    console, fetch: async (url, init) => {
      requests.push({ url, init });
      const result = await reply(url, init);
      return { ok: result.status < 400, status: result.status, text: async () => JSON.stringify(result.body) };
    },
  });
  vm.runInContext(source, context);
  const send = (message) => vm.runInContext("handleMessage", context)(message, {});
  return { send, requests, tabsOpened };
}

const fullScopes = ["plugin:devices:read", "plugin:parse", "plugin:alert:create"];
const me = { platform: "EFF-Monitoring", scopes: fullScopes, capabilities: { ticket_creation: true } };

test("connection test rejects a token without ticket permissions", async () => {
  const app = setup(async () => ({ status: 200, body: { ...me, scopes: ["plugin:devices:read", "plugin:parse"] } }));
  await assert.rejects(app.send({ type: "TEST_PLATFORM", baseUrl: "http://localhost:8000", token: "limited" }), /plugin:alert:create/);
});

test("ticket submission carries text and request ID even with a stale parse token", async () => {
  const app = setup(async () => ({ status: 200, body: me }));
  await app.send({ type: "SAVE_PLATFORM", baseUrl: "http://localhost:8000", token: "valid", meta: me });
  await app.send({ type: "CREATE_TICKET", requestId: "8e91ab74-b765-4cca-9b1e-715a7b08997b", parseToken: "old", deviceId: 7, text: "alert text" });
  const payload = JSON.parse(app.requests.at(-1).init.body);
  assert.equal(payload.text, "alert text");
  assert.equal(payload.request_id, "8e91ab74-b765-4cca-9b1e-715a7b08997b");
});

test("connection recheck marks an expired token as unauthorized", async () => {
  const app = setup(async () => ({ status: 401, body: { detail: "expired" } }));
  await app.send({ type: "SAVE_PLATFORM", baseUrl: "http://localhost:8000", token: "expired" });
  const checked = await app.send({ type: "CHECK_PLATFORM" });
  assert.equal(checked.platform.connected, false);
  assert.equal(checked.platform.connectionStatus, "unauthorized");
});

test("ticket authorization failure refreshes the cached connection state", async () => {
  const app = setup(async (url) => url.endsWith("/alerts")
    ? { status: 403, body: { detail: "insufficient scope" } }
    : { status: 200, body: { ...me, scopes: ["plugin:devices:read", "plugin:parse"], capabilities: { ticket_creation: false } } });
  await app.send({ type: "SAVE_PLATFORM", baseUrl: "http://localhost:8000", token: "limited", meta: me });
  await assert.rejects(app.send({ type: "CREATE_TICKET", text: "alert text" }), /insufficient scope/);
  const state = await app.send({ type: "GET_STATE" });
  assert.equal(state.platform.ticketCreation, false);
});

test("an old connection check cannot overwrite a newly saved platform token", async () => {
  let release;
  let started;
  const startedPromise = new Promise((resolve) => { started = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  const app = setup(async () => { started(); await gate; return { status: 401, body: { detail: "expired" } }; });
  await app.send({ type: "SAVE_PLATFORM", baseUrl: "http://old.example", token: "old" });
  const checking = app.send({ type: "CHECK_PLATFORM" });
  await startedPromise;
  await app.send({ type: "SAVE_PLATFORM", baseUrl: "http://new.example", token: "new", meta: me });
  release();
  await checking;
  const state = await app.send({ type: "GET_STATE" });
  assert.equal(state.platform.baseUrl, "http://new.example");
  assert.equal(state.platform.connectionStatus, "connected");
});

test("relative workbench URL opens on the configured platform origin", async () => {
  const app = setup(async () => ({ status: 200, body: me }));
  await app.send({ type: "SAVE_PLATFORM", baseUrl: "http://localhost:8000", token: "valid" });
  await app.send({ type: "OPEN_URL", url: "/?page=alerts&alert_hash=abc" });
  assert.equal(app.tabsOpened[0].url, "http://localhost:8000/?page=alerts&alert_hash=abc");
  await assert.rejects(app.send({ type: "OPEN_URL", url: "javascript:alert(1)" }), /无效的页面地址/);
});
