import path from "node:path"

export const shutdownsPages = {
  k: "https://www.dtek-kem.com.ua/ua/shutdowns",
  kr: "https://www.dtek-krem.com.ua/ua/shutdowns",
  dn: "https://www.dtek-dnem.com.ua/ua/shutdowns",
  o: "https://www.dtek-oem.com.ua/ua/shutdowns",
  d: "https://www.dtek-dem.com.ua/ua/shutdowns",
}
export const REGION = String(process.env.REGION ?? "")
  .trim()
  .toLowerCase()
export const SHUTDOWNS_PAGE = shutdownsPages[REGION]
export const SHUTDOWNS_DATA_MARKER = /fact\s*=\s*\{/

const GROUP_PREFIX = "GPV"
export const GROUP_NUMBER = String(process.env.GROUP ?? "").trim()
export const GROUP_NUMBER_MATCHER = /^\d+(\.\d+)?$/
export const GROUP = `${GROUP_PREFIX}${GROUP_NUMBER}`

export const PowerState = Object.freeze({
  ON: "yes",
  OFF: "no",
  HALF_ON: "second",
  HALF_OFF: "first",
  MAYBE: "maybe",
  MAYBE_HALF_ON: "msecond",
  MAYBE_HALF_OFF: "mfirst",
})

// Значення `power` у періодах розкладу
export const Power = Object.freeze({
  ON: true,
  OFF: false,
  UNKNOWN: null,
})

export const hours = Array.from({ length: 24 }).map((_, i) => i)

export const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN
export const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID

const ARTIFACTS_DIR = path.resolve("artifacts", process.env.TARGET ?? "")
export const MESSAGES_FILE = path.join(ARTIFACTS_DIR, "messages.json")
export const LEGACY_LAST_MESSAGE_FILE = path.join(
  ARTIFACTS_DIR,
  "last-message.json",
)

export const TIME_ZONE = "Europe/Kyiv"

export const RETRIES_MAX_COUNT = 5
export const RETRIES_TIMEOUT = 5000
