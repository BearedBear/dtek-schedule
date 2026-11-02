import { chromium } from "playwright"

import {
  buildSchedule,
  checkIsNight,
  extractFactData,
  generateMessage,
  getCurrentTime,
  getScheduleDays,
  isFactData,
  isMessageLost,
  loadMessages,
  saveMessages,
} from "./helpers.js"
import {
  GROUP,
  GROUP_NUMBER,
  GROUP_NUMBER_MATCHER,
  REGION,
  shutdownsPages,
  SHUTDOWNS_PAGE,
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_ID,
  RETRIES_TIMEOUT,
  RETRIES_MAX_COUNT,
} from "./constants.js"

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function validateConfig() {
  const errors = []

  if (!SHUTDOWNS_PAGE) {
    errors.push(
      `unknown REGION "${REGION}", expected one of: ${Object.keys(shutdownsPages).join(", ")}`,
    )
  }
  if (!GROUP_NUMBER_MATCHER.test(GROUP_NUMBER)) {
    errors.push(`invalid GROUP "${GROUP_NUMBER}", expected format like 1.2`)
  }
  if (!TELEGRAM_BOT_TOKEN) errors.push("missing TELEGRAM_BOT_TOKEN")
  if (!TELEGRAM_CHAT_ID) errors.push("missing TELEGRAM_CHAT_ID")

  if (errors.length) {
    throw Error(`❌ Invalid configuration: ${errors.join("; ")}.`)
  }
}

async function fetchShutdownsData() {
  const browser = await chromium.launch({ headless: true })

  try {
    const browserPage = await browser.newPage()
    await browserPage.goto(SHUTDOWNS_PAGE, {
      waitUntil: "load",
    })

    const fact = await browserPage
      .evaluate(() => window.DisconSchedule?.fact)
      .catch(() => null)
    if (isFactData(fact)) return fact

    const data = extractFactData(await browserPage.content())
    if (isFactData(data)) return data

    throw Error("not found")
  } finally {
    await browser.close()
  }
}

async function getShutdownsData() {
  for (let attempt = 0; attempt <= RETRIES_MAX_COUNT; attempt++) {
    if (attempt > 0) {
      console.log("🌀 Try getting shutdowns data again...")
      await sleep(RETRIES_TIMEOUT)
    }

    console.log("🌀 Getting shutdowns data...")

    try {
      const data = await fetchShutdownsData()
      console.log("✅ Getting shutdowns data finished.")
      return data
    } catch (error) {
      console.error(`❌ Getting shutdowns data failed: ${error.message}.`)
    }
  }

  throw Error(
    `❌ Getting shutdowns data failed after ${RETRIES_MAX_COUNT} retries.`,
  )
}

async function callTelegram(method, body) {
  const response = await fetch(
    `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/${method}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  )

  return response.json()
}

async function sendNotification({ dayKey, text, scheduleText }, messages) {
  console.log("🌀 Sending notification...")

  for (let attempt = 0; attempt <= RETRIES_MAX_COUNT; attempt++) {
    const lastMessage = messages[dayKey] ?? {}
    const isScheduleChanged = lastMessage.scheduleText !== scheduleText
    const isEdit = Boolean(lastMessage.message_id) && !isScheduleChanged
    const isReply = Boolean(lastMessage.message_id) && isScheduleChanged

    try {
      const data = await callTelegram(
        isEdit ? "editMessageText" : "sendMessage",
        {
          chat_id: TELEGRAM_CHAT_ID,
          text,
          parse_mode: "HTML",
          disable_notification: checkIsNight(),
          message_id: isEdit ? lastMessage.message_id : undefined,
          reply_parameters: isReply
            ? {
                message_id: lastMessage.message_id,
                allow_sending_without_reply: true,
              }
            : undefined,
        },
      )

      if (data.description?.includes("not modified")) {
        console.log("🟡 Notification not changed.")
        return
      }

      if (!data.ok) {
        if (isEdit && isMessageLost(data.description)) {
          console.log("🟡 Previous message is gone, sending a new one.")
          delete messages[dayKey]
          continue
        }

        const retryAfter = data.parameters?.retry_after
        if (retryAfter) await sleep(retryAfter * 1000)

        throw Error(data.description)
      }

      messages[dayKey] = {
        message_id: data.result.message_id,
        date: data.result.date,
        scheduleText,
      }
      saveMessages(messages)

      console.log("🟢 Notification sent.")
      return
    } catch (error) {
      console.error(`❌ Sending notification failed: ${error.message}.`)

      if (attempt < RETRIES_MAX_COUNT) {
        console.log("🌀 Try sending notification again...")
        await sleep(RETRIES_TIMEOUT)
      }
    }
  }

  throw Error(
    `❌ Sending notification failed after ${RETRIES_MAX_COUNT} retries.`,
  )
}

async function run() {
  validateConfig()

  const data = await getShutdownsData()
  const messages = loadMessages(String(data.today))
  saveMessages(messages)

  const now = getCurrentTime()
  let hasErrors = false

  for (const { key, isToday } of getScheduleDays(data)) {
    const dayName = isToday ? "today" : "tomorrow"
    const groups = data.data[key] ?? {}

    if (!Object.keys(groups).length) {
      console.log(`🔋 No schedule for ${dayName}.`)
      continue
    }

    const hoursStates = groups[GROUP]
    if (!hoursStates) {
      if (!isToday) continue
      throw Error(`❌ Generating schedule failed: group ${GROUP} not found.`)
    }

    console.log(`🌀 Generating schedule for ${dayName}...`)
    const schedule = buildSchedule(hoursStates, {
      onUnknownState: (hour, state) =>
        console.warn(`🟡 Unknown power state "${state}" at ${hour}:00.`),
    })

    const message = generateMessage({
      schedule,
      update: data.update,
      dayKey: key,
      isToday,
      now,
    })
    message.isShutdownsExists
      ? console.log("🪫 Power shutdowns detected!")
      : console.log("🔋 No power shutdowns!")

    try {
      await sendNotification({ dayKey: key, ...message }, messages)
    } catch (error) {
      console.error(error.message)
      hasErrors = true
    }
  }

  if (hasErrors) process.exitCode = 1
}

run().catch((error) => {
  console.error(error.message)
  process.exitCode = 1
})
