import { API_URL, BOT_NAME, DRY_RUN, BOUNTY_MODE, BOUNTY_VALUE, BOUNTY_COUNT } from './env'
import { getHoprAddress  } from './utils'
import { setupBot, Bot } from './bot'
import { setupPayDai, payDai } from './linkdrop'
import process from 'process'

var stdin = process.openStdin() 

const start = async () => {
  console.log(`Connecting to ${API_URL}`)

  let hoprAddress = ''
  if (!DRY_RUN) {
    hoprAddress = await getHoprAddress()
    console.log(`My HOPR address is ${hoprAddress}`)
  }

  let bot: Bot
  switch(BOT_NAME) {
    case 'randobot': 
      const { Randombot } = await import("./randobot")
      bot = new Randombot(hoprAddress)
      break
    case 'bouncerbot':
      const { Bouncebot } = await import("./bouncerbot")
      bot = new Bouncebot(hoprAddress)
      break
    case 'tweetbot':
      const { Tweetbot } = await import("./tweetbot")
      bot = new Tweetbot(hoprAddress)
      break
    case 'mysterybot':
      const { Mysterybot } = await import("./mysterybot")
      bot = new Mysterybot(hoprAddress, BOUNTY_MODE, BOUNTY_COUNT, BOUNTY_VALUE)
      break
  }
  await setupPayDai(10)
  await setupBot(bot)

  // Interact with the bot directly with the commandline, only for debugging purpose
  if (DRY_RUN) stdin.addListener("data", function(d) {
    const message = d.toString().trim()
    // The first 5 chatecter are the address, and rest is the message
    bot.handleMessage({
      text: message.substring(5),
      from: message.substring(0, 5)
    })
  })
}

start().catch((err) => {
  console.error('Fatal Error:', err)
  process.exit()
})
