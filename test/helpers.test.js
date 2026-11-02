import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { describe, it, before, after } from "node:test"

// Стан пишеться в ./artifacts відносно cwd, тому тести працюють у тимчасовій папці
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dtek-schedule-"))
const originalCwd = process.cwd()
process.chdir(tmpDir)

const {
  buildSchedule,
  checkIsNight,
  escapeHtml,
  extractFactData,
  generateMessage,
  getScheduleDays,
  isMessageLost,
  loadMessages,
  saveMessages,
} = await import("../src/helpers.js")
const { LEGACY_LAST_MESSAGE_FILE, MESSAGES_FILE } = await import(
  "../src/constants.js"
)

after(() => {
  process.chdir(originalCwd)
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

// 1-based години, як у даних ДТЕК
const states = (overrides = {}) =>
  Object.fromEntries(
    Array.from({ length: 24 }, (_, i) => [i + 1, overrides[i + 1] ?? "yes"]),
  )

describe("buildSchedule", () => {
  it("merges whole day with power into one period", () => {
    assert.deepEqual(buildSchedule(states()), [
      { begin: "00:00", end: "24:00", power: true },
    ])
  })

  it("handles full and half hours", () => {
    const schedule = buildSchedule(
      states({ 1: "no", 2: "no", 3: "first", 11: "second", 24: "no" }),
    )
    assert.deepEqual(
      schedule.filter(({ power }) => !power),
      [
        { begin: "00:00", end: "02:30", power: false },
        { begin: "10:30", end: "11:00", power: false },
        { begin: "23:00", end: "24:00", power: false },
      ],
    )
  })

  it("shows unknown states instead of skipping them", () => {
    const unknown = []
    const schedule = buildSchedule(states({ 5: "no", 6: "weird", 7: "no" }), {
      onUnknownState: (hour, state) => unknown.push([hour, state]),
    })

    assert.deepEqual(unknown, [[5, "weird"]])
    assert.deepEqual(
      schedule.filter(({ power }) => power !== true),
      [
        { begin: "04:00", end: "05:00", power: false },
        { begin: "05:00", end: "06:00", power: null },
        { begin: "06:00", end: "07:00", power: false },
      ],
    )
  })

  it("treats maybe states as possible outages", () => {
    const schedule = buildSchedule(states({ 9: "maybe", 10: "mfirst" }))
    assert.deepEqual(
      schedule.filter(({ power }) => power !== true),
      [{ begin: "08:00", end: "09:30", power: null }],
    )
  })
})

describe("extractFactData", () => {
  it("stops at the matching brace and ignores later scripts", () => {
    const html = `<script>DisconSchedule.fact = {"data":{"1":{"GPV1.1":{"1":"no"}}},"update":"a } b","today":1}</script>
      <style>.x { color: red }</style><script>var y = {z: 1}</script>`

    assert.deepEqual(extractFactData(html), {
      data: { 1: { "GPV1.1": { 1: "no" } } },
      update: "a } b",
      today: 1,
    })
  })

  it("returns null when there is no data", () => {
    assert.equal(extractFactData("<html></html>"), null)
  })
})

describe("getScheduleDays", () => {
  it("returns today and the nearest next day", () => {
    const data = { today: 100, data: { 300: {}, 100: {}, 200: {} } }
    assert.deepEqual(getScheduleDays(data), [
      { key: "100", isToday: true },
      { key: "200", isToday: false },
    ])
  })

  it("returns only today when tomorrow is not published", () => {
    assert.deepEqual(getScheduleDays({ today: 100, data: { 100: {} } }), [
      { key: "100", isToday: true },
    ])
  })
})

describe("generateMessage", () => {
  // 02.11.2025 00:00 за Києвом
  const dayKey = "1762034400"

  it("lists outages and possible outages", () => {
    const { text, scheduleText, isShutdownsExists } = generateMessage({
      schedule: buildSchedule(states({ 1: "no", 2: "maybe" })),
      update: "02.11.2026 <10:30> & more",
      dayKey,
      isToday: true,
      now: "02.11.2026 10:45",
    })

    assert.equal(isShutdownsExists, true)
    assert.equal(
      scheduleText,
      "🪫 <code>00:00 — 01:00</code>\n❔ <code>01:00 — 02:00</code> <i>можливо</i>",
    )
    assert.match(text, /на сьогодні, 02\.11:/)
    assert.match(text, /02\.11\.2026 &lt;10:30&gt; &amp; more/)
  })

  it("labels tomorrow and shows the day without outages", () => {
    const { text, scheduleText, isShutdownsExists } = generateMessage({
      schedule: buildSchedule(states()),
      update: "",
      dayKey,
      isToday: false,
      now: "",
    })

    assert.equal(isShutdownsExists, false)
    assert.equal(scheduleText, "🔋 <code>00:00 — 24:00</code>")
    assert.match(text, /на завтра, 02\.11:/)
  })
})

describe("escapeHtml", () => {
  it("escapes HTML special characters", () => {
    assert.equal(escapeHtml("<b>&</b>"), "&lt;b&gt;&amp;&lt;/b&gt;")
    assert.equal(escapeHtml(undefined), "")
  })
})

describe("checkIsNight", () => {
  it("detects night hours in Kyiv time", () => {
    assert.equal(checkIsNight(new Date("2026-11-01T22:00:00Z")), true) // 00:00
    assert.equal(checkIsNight(new Date("2026-11-02T05:59:00Z")), true) // 07:59
    assert.equal(checkIsNight(new Date("2026-11-02T06:00:00Z")), false) // 08:00
    assert.equal(checkIsNight(new Date("2026-11-02T19:59:00Z")), false) // 21:59
    assert.equal(checkIsNight(new Date("2026-11-02T20:00:00Z")), true) // 22:00
  })
})

describe("isMessageLost", () => {
  it("only matches errors where the message cannot be edited", () => {
    assert.equal(isMessageLost("Bad Request: message to edit not found"), true)
    assert.equal(isMessageLost("Bad Request: message can't be edited"), true)
    assert.equal(isMessageLost("Too Many Requests: retry after 5"), false)
    assert.equal(isMessageLost("Internal Server Error"), false)
    assert.equal(isMessageLost(undefined), false)
  })
})

describe("messages state", () => {
  const today = 1762034400 // 02.11.2025 00:00 за Києвом
  const yesterday = today - 86400

  before(() => fs.rmSync("artifacts", { recursive: true, force: true }))

  it("drops past days and keeps today and tomorrow", () => {
    saveMessages({
      [yesterday]: { message_id: 1 },
      [today]: { message_id: 2 },
      [today + 86400]: { message_id: 3 },
    })

    assert.deepEqual(loadMessages(String(today)), {
      [today]: { message_id: 2 },
      [today + 86400]: { message_id: 3 },
    })
  })

  it("migrates today's legacy last-message.json", () => {
    fs.rmSync(MESSAGES_FILE, { force: true })
    fs.writeFileSync(
      LEGACY_LAST_MESSAGE_FILE,
      JSON.stringify({ message_id: 7, date: today + 3600, scheduleText: "x" }),
    )

    assert.deepEqual(loadMessages(String(today)), {
      [today]: { message_id: 7, date: today + 3600, scheduleText: "x" },
    })
    assert.equal(fs.existsSync(LEGACY_LAST_MESSAGE_FILE), false)
  })

  it("ignores legacy message from a previous day", () => {
    fs.rmSync(MESSAGES_FILE, { force: true })
    fs.writeFileSync(
      LEGACY_LAST_MESSAGE_FILE,
      JSON.stringify({ message_id: 7, date: yesterday + 3600 }),
    )

    assert.deepEqual(loadMessages(String(today)), {})
  })
})
