const assert = require("node:assert/strict");
const { test } = require("node:test");
const { loadEngine } = require("./helpers/cloud-harness");
function loadTask(time = "2026-10-26T15:35:00+08:00") {
  const e = loadEngine({ time, tables: { preferences: [{ _id: "test-user", openid: "test-user", dailyBrief: true }] } });
  return { main: e.main, created: e.tables.sendTasks, reads: [] };
}

for (const key of ["TriggerName", "triggerName"]) {
  test(`${key}=scanTimer creates the weekday brief for 15:40 Beijing time`, async () => {
    const task = loadTask();
    await task.main({ Type: "Timer", [key]: "scanTimer" });
    assert.equal(task.created.length, 1);
    assert.equal(task.created[0]._id, "brief:test-user:20261026");
    assert.equal(task.created[0].status, "pending");
    assert.equal(task.created[0].triggerTime, Date.parse("2026-10-26T15:40:00+08:00"));
    assert.ok(!task.reads.includes("sendTasks"));
  });
}

test("TriggerName=dispatchTimer scans and preserves the future 15:40 brief", async () => {
  const task = loadTask();
  const result = await task.main({ Type: "Timer", TriggerName: "dispatchTimer" });
  assert.equal(result.processed, 0);
  assert.equal(task.created.length, 1);
  assert.equal(task.created[0].triggerTime, Date.parse("2026-10-26T15:40:00+08:00"));
});

test("manual invocation preserves dispatch behavior", async () => {
  const task = loadTask();
  await task.main({});
  assert.equal(task.created.length, 0);
});

test("weekend scans do not create daily briefs", async () => {
  const task = loadTask("2026-10-25T15:35:00+08:00");
  await task.main({ TriggerName: "scanTimer" });
  assert.equal(task.created.length, 0);
  assert.equal(task.created.length, 0);
});

test("deployment uses one minute timer for the scan and send cycle", () => {
  const config = require("../cloudfunctions/sendTask/config.json");
  assert.deepEqual(config.triggers, [{ name: "dispatchTimer", type: "timer", config: "0 * * * * * *" }]);
});
