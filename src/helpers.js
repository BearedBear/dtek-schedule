import fs from "node:fs"
import path from "node:path"
import {
  hours,
  LEGACY_LAST_MESSAGE_FILE,
  MESSAGES_FILE,
  Power,
  PowerState,
  SHUTDOWNS_DATA_MARKER,
  TIME_ZONE,
} from "./constants.js"

function addLeadingZero(str) {
  if (typeof str !== "string" && typeof str !== "number") return
  return String(str).padStart(2, "0")
}

export function createPeriod({ hour, startMin = 0, endMin = 0, power }) {
  const begin = `${addLeadingZero(hour)}:${addLeadingZero(startMin)}`
  const end =
    endMin === 0
      ? `${addLeadingZero(hour + 1)}:00`
      : `${addLeadingZero(hour)}:${addLeadingZero(endMin)}`

  return {
    begin,
    end,
    power,
  }
}

export function useSchedule(schedule) {
  const setSchedule = (period) => {
    const last = schedule.at(-1)
    if (last?.power === period.power && last.end === period.begin) {
      last.end = period.end
    } else {
      schedule.push(period)
    }
  }

  return [schedule, setSchedule]
}

function getHourPeriods(hour, state) {
  const full = (power) => [createPeriod({ hour, power })]
  const halves = (first, second) => [
    createPeriod({ hour, endMin: 30, power: first }),
    createPeriod({ hour, startMin: 30, power: second }),
  ]

  switch (state) {
    case PowerState.ON:
      return full(Power.ON)
    case PowerState.OFF:
      return full(Power.OFF)
    case PowerState.HALF_ON:
      return halves(Power.ON, Power.OFF)
    case PowerState.HALF_OFF:
      return halves(Power.OFF, Power.ON)
    case PowerState.MAYBE:
      return full(Power.UNKNOWN)
    case PowerState.MAYBE_HALF_ON:
      return halves(Power.ON, Power.UNKNOWN)
    case PowerState.MAYBE_HALF_OFF:
      return halves(Power.UNKNOWN, Power.ON)
    default:
      return null
  }
}

// Невідомий стан години не пропускається, а показується як можливе відключення,
// щоб у розкладі не було «дірок», через які склеюються сусідні періоди
export function buildSchedule(hoursStates, { onUnknownState } = {}) {
  const [schedule, setSchedule] = useSchedule([])

  hours.forEach((hour) => {
    const state = hoursStates[hour + 1]
    let periods = getHourPeriods(hour, state)

    if (!periods) {
      onUnknownState?.(hour, state)
      periods = [createPeriod({ hour, power: Power.UNKNOWN })]
    }

    periods.forEach(setSchedule)
  })

  return schedule
}

// Дістає JSON-об'єкт після `fact =` з HTML, рахуючи дужки з урахуванням рядків,
// тому зайві `}` далі на сторінці не потрапляють у результат
export function extractFactData(html) {
  const marker = SHUTDOWNS_DATA_MARKER.exec(html)
  if (!marker) return null

  const start = marker.index + marker[0].length - 1
  let depth = 0
  let inString = false
  let isEscaped = false

  for (let i = start; i < html.length; i++) {
    const char = html[i]

    if (inString) {
      if (isEscaped) isEscaped = false
      else if (char === "\\") isEscaped = true
      else if (char === '"') inString = false
      continue
    }

    if (char === '"') inString = true
    else if (char === "{") depth++
    else if (char === "}" && --depth === 0) {
      return JSON.parse(html.slice(start, i + 1))
    }
  }

  return null
}

export function isFactData(data) {
  return (
    typeof data === "object" &&
    data !== null &&
    typeof data.data === "object" &&
    data.data !== null &&
    data.today !== undefined
  )
}

// Сьогоднішній день і найближчий наступний, якщо ДТЕК вже опублікував графік на нього
export function getScheduleDays(data) {
  const todayKey = String(data.today)
  const nextKey = Object.keys(data.data)
    .filter((key) => Number(key) > Number(todayKey))
    .sort((a, b) => Number(a) - Number(b))[0]

  return [
    { key: todayKey, isToday: true },
    ...(nextKey ? [{ key: nextKey, isToday: false }] : []),
  ]
}

export function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
}

export function formatDay(dayKey) {
  return new Date(Number(dayKey) * 1000).toLocaleDateString("uk-UA", {
    timeZone: TIME_ZONE,
    day: "2-digit",
    month: "2-digit",
  })
}

export function generateMessage({ schedule = [], update, dayKey, isToday, now }) {
  const isShutdownsExists = schedule.some(({ power }) => power !== Power.ON)

  const scheduleText = (
    isShutdownsExists
      ? schedule
          .filter(({ power }) => power !== Power.ON)
          .map(({ begin, end, power }) =>
            power === Power.OFF
              ? `🪫 <code>${begin} — ${end}</code>`
              : `❔ <code>${begin} — ${end}</code> <i>можливо</i>`,
          )
      : schedule.map(({ begin, end }) => `🔋 <code>${begin} — ${end}</code>`)
  ).join("\n")

  const dayLabel = isToday ? "сьогодні" : "завтра"

  const text = [
    `⚡️ <b>Графік відключень на ${dayLabel}, ${formatDay(dayKey)}:</b>`,
    scheduleText,
    "",
    `📢 <i>${escapeHtml(update)}</i>`,
    `🤖 <i>${now}</i>`,
  ].join("\n")

  return { text, scheduleText, isShutdownsExists }
}

export function getCurrentTime() {
  const now = new Date()

  const date = now.toLocaleDateString("uk-UA", {
    timeZone: TIME_ZONE,
  })

  const time = now.toLocaleTimeString("uk-UA", {
    timeZone: TIME_ZONE,
    hour: "2-digit",
    minute: "2-digit",
  })

  return `${date} ${time}`
}

export function checkIsNight(date = new Date()) {
  const hour = Number(
    date.toLocaleString("en-US", {
      timeZone: TIME_ZONE,
      hour: "numeric",
      hourCycle: "h23",
    }),
  )
  return hour >= 22 || hour < 8
}

// Помилки, після яких старе повідомлення вже не відредагувати і треба надіслати нове
export function isMessageLost(description = "") {
  return /message to edit not found|message can't be edited|message_id_invalid/i.test(
    description,
  )
}

function getKyivDay(unixSeconds) {
  return new Date(unixSeconds * 1000).toLocaleDateString("en-CA", {
    timeZone: TIME_ZONE,
  })
}

function readJson(file) {
  if (!fs.existsSync(file)) return null
  return JSON.parse(fs.readFileSync(file, "utf8").trim())
}

// Стан: { [dayKey]: { message_id, date, scheduleText } }.
// Записи минулих днів видаляються, старий last-message.json переноситься
export function loadMessages(todayKey) {
  const messages = readJson(MESSAGES_FILE) ?? {}

  const legacy = readJson(LEGACY_LAST_MESSAGE_FILE)
  if (legacy) {
    if (
      legacy.message_id &&
      legacy.date &&
      !messages[todayKey] &&
      getKyivDay(legacy.date) === getKyivDay(Number(todayKey))
    ) {
      messages[todayKey] = legacy
    }
    fs.rmSync(LEGACY_LAST_MESSAGE_FILE, { force: true })
  }

  for (const key of Object.keys(messages)) {
    if (Number(key) < Number(todayKey)) delete messages[key]
  }

  return messages
}

export function saveMessages(messages) {
  fs.mkdirSync(path.dirname(MESSAGES_FILE), { recursive: true })
  fs.writeFileSync(MESSAGES_FILE, JSON.stringify(messages, null, 2))
}
