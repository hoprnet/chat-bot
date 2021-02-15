import { getHOPRNodeAddressFromContent } from '../../utils/utils'
import Web3 from 'web3'
import { Bot } from '../bot'
import { IMessage } from '../../message/message'
import { TweetMessage } from '../../lib/twitter/twitter'
//@TODO: Isolate these utilities to avoid importing the entire package
import { convertPubKeyFromB58String, u8aToHex } from '@hoprnet/hopr-utils'
import { Utils } from '@hoprnet/hopr-core-ethereum'
import { pubKeyToPeerId } from '@hoprnet/hopr-core/lib/utils'
import { Networks, HOPR_CHANNELS } from '@hoprnet/hopr-core-ethereum/lib/ethereum/addresses'
import {
  COVERBOT_DEBUG_MODE,
  COVERBOT_CHAIN_PROVIDER,
  COVERBOT_VERIFICATION_CYCLE_IN_MS,
  COVERBOT_XDAI_THRESHOLD,
  HOPR_ENVIRONMENT,
  COVERBOT_DEBUG_HOPR_ADDRESS,
  COVERBOT_TIMESTAMP,
  COVERBOT_RESTORE_SCORE_FROM,
  COVERBOT_SUPPORT_MODE
} from '../../utils/env'
import db from './db'
import { BotCommands, NodeStates, ScoreRewards } from './state'
import { RELAY_VERIFICATION_CYCLE_IN_MS, RELAY_HOPR_REWARD, HOPR_ENVIRONMENTS, AMOUNT_OF_IDENTIFIABLE_LETTERS } from './constants'
import { BotResponses, NodeStateResponses } from './responses'
import { BalancedHoprNode, HoprNode, CoverbotSecret } from './coverbot'
import debug from 'debug'
import Core from '../../lib/hopr/core'
import BN from 'bn.js'


const log = debug('hopr-chatbot:coverbot')
const error = debug('hopr-chatbot:coverbot:error')
const { fromWei } = Web3.utils

const stateDbRef = db.ref(`/${HOPR_ENVIRONMENT}/state`)
const scoreDbRef = db.ref(`/${HOPR_ENVIRONMENT}/score`)
const botsDbRef = db.ref(`/${HOPR_ENVIRONMENT}/bots`)

// 'COVERBOT_RESTORE_SCORE_FROM' must be a valid hopr environment
if (COVERBOT_RESTORE_SCORE_FROM && !HOPR_ENVIRONMENTS.includes(COVERBOT_RESTORE_SCORE_FROM)) {
  log(`- validate | provided 'COVERBOT_RESTORE_SCORE_FROM' = '${COVERBOT_RESTORE_SCORE_FROM}' is not a valid hopr environment`)
  throw Error("Invalid COVERBOT_RESTORE_SCORE_FROM")
}

export class Coverbot implements Bot {
  node: Core
  initialBalance: string
  initialHoprBalance: string
  botName: string
  address: string
  nativeAddress: string
  secret: number
  timestamp: Date
  status: Map<string, NodeStates>
  tweets: Map<string, TweetMessage>
  twitterTimestamp: Date
  relayTimestamp: Date
  bots: CoverbotSecret

  verifiedHoprNodes: Map<string, HoprNode>
  relayTimeouts: Map<string, NodeJS.Timeout>
  verificationTimeout: NodeJS.Timeout

  xdaiWeb3: Web3
  ethereumAddress: string
  chainId: number
  network: Networks
  initialized: boolean

  constructor({ node, hoprBalance, balance }: BalancedHoprNode, nativeAddress: string, address: string, timestamp: Date, twitterTimestamp: Date) {
    this.node = node
    this.initialBalance = balance
    this.initialHoprBalance = hoprBalance
    this.address = address
    this.nativeAddress = nativeAddress
    this.secret = Math.floor(Math.random() * 1e8)
    this.timestamp = timestamp
    this.status = new Map<string, NodeStates>()
    this.tweets = new Map<string, TweetMessage>()
    this.twitterTimestamp = twitterTimestamp
    this.botName = '💰 Coverbot'
    this.initialized = false
    this.relayTimestamp = COVERBOT_TIMESTAMP ? new Date(+COVERBOT_TIMESTAMP * 1000) : new Date(Date.now())

    log(`- constructor | ${this.botName} has been added`)
    log(`- constructor | 🏠 HOPR Address: ${this.address}`)
    log(`- constructor | 🏡 Native Address: ${this.nativeAddress}`)
    log(`- constructor | ⛓ EVM Network: ${COVERBOT_CHAIN_PROVIDER}`)
    log(`- constructor | 📦 DB Environment: ${HOPR_ENVIRONMENT}`)
    log(`- constructor | 💸 Threshold: ${COVERBOT_XDAI_THRESHOLD}`)
    log(`- constructor | 💰 Native Balance: ${this.initialBalance}`)
    log(`- constructor | 💵 HOPR Balance: ${this.initialHoprBalance}`)
    log(`- constructor | 🐛 Debug Mode: ${COVERBOT_DEBUG_MODE}`)
    log(`- constructor | 💊 Support Mode: ${COVERBOT_SUPPORT_MODE}`)
    log(`- constructor | 👀 Verification Cycle: ${COVERBOT_VERIFICATION_CYCLE_IN_MS}`)
    log(`- constructor | 🔍 Relaying Cycle: ${RELAY_VERIFICATION_CYCLE_IN_MS}`)
    log(`- constructor | 🗓 Relaying Starts at: ${this.relayTimestamp}`)

    this.ethereumAddress = null
    this.chainId = null
    this.network = null

    this.xdaiWeb3 = new Web3(new Web3.providers.WebsocketProvider(COVERBOT_CHAIN_PROVIDER))
    this.verificationTimeout = setInterval(this._verificationCycle.bind(this), COVERBOT_VERIFICATION_CYCLE_IN_MS)

    this.verifiedHoprNodes = new Map<string, HoprNode>()
    this.relayTimeouts = new Map<string, NodeJS.Timeout>()
    this.initialize()
  }

  private async _getEthereumAddressFromHOPRAddress(hoprAddress: string): Promise<string> {
    const pubkey = await convertPubKeyFromB58String(hoprAddress)
    const ethereumAddress = u8aToHex(await Utils.pubKeyToAccountId(pubkey.marshal()))
    return ethereumAddress
  }

  private async _getHoprAddressScore(hoprAddress: string): Promise<number> {
    return new Promise((resolve, reject) => {
      scoreDbRef.child(hoprAddress).once('value', (snapshot, error) => {
        if (error) return reject(error)
        return resolve(snapshot.val() || 0)
      })
    })
  }

  private async _loadBotsWithSecrets(): Promise<CoverbotSecret> {
    log(`- _getBotAddressesWithSecrets | Obtaining coverbot addresses`)
    return new Promise((resolve, reject) => {
      botsDbRef.once('value', (snapshot, error) => {
        if (error) return reject(error)
        const bots = snapshot.val()
        log(`- _getBotAddressesWithSecrets | Obtained ${JSON.stringify(bots)} addresses and secrets.`)
        this.bots = bots;
        return resolve(bots || {})
      })
    })
  }

  /**
   * Increase score atomically
   * @param hoprAddress
   * @param update a function that should return the final result, firebase makes sure to run it atomically
   * @returns a promise that resolves to the resulting score
   */
  private async _increaseHoprAddressScore(hoprAddress: string, update: (value?: number) => number | undefined): Promise<number> {
    return new Promise(async (resolve, reject) => {
      scoreDbRef.child(hoprAddress).transaction(
        update,
        (error, _committed, score) => {
          if (error) return reject(error)
          return resolve(score.val() || 0)
        }
      )
    })
  }

  /**
   * Sets score
   * @deprecated
   * @param hoprAddress 
   * @param score 
   */
  private async _setHoprAddressScore(hoprAddress: string, score: number): Promise<void> {
    return new Promise((resolve, reject) => {
      scoreDbRef.child(hoprAddress).setWithPriority(score, -score, (error) => {
        if (error) return reject(error)
        return resolve()
      })
    })
  }

  private async _loadState(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      log(`- loadState | Loading state`)

      stateDbRef.once('value', (snapshot, error) => {
        if (error) return reject(error)
        if (!snapshot.exists()) {
          log(`- loadState | Database hasn’t been created`)
          return resolve()
        }
        const state = snapshot.val()
        const connected = state.connected || []
        log(`- loadState | Loaded ${connected.length} nodes from our Database`)
        this.verifiedHoprNodes = new Map<string, HoprNode>()
        connected.forEach((n) => this.verifiedHoprNodes.set(n.id, n))
        log(`- loadState | Updated ${Array.from(this.verifiedHoprNodes.values()).length} verified nodes in memory`)
        return resolve()
      })
    })
  }

  private async _initializeConnectedNodes(): Promise<void> {
    //@TODO: Rename SCORE_FROM and use its own proper variable
    if (!COVERBOT_RESTORE_SCORE_FROM) return
    log(`- _initializeConnectedNodes | Restoring connected ndoes from '${COVERBOT_RESTORE_SCORE_FROM}' if connected nodes are empty`)

    return new Promise<void>((resolve, reject) => {
      log(`- _initializeConnectedNodes | Loading connected nodes`)

      stateDbRef.child("connected").once("value", async (snapshot, error) => {
        try {
          if (error) return reject(error)
          if (snapshot.exists()) {
            log(`- _initializeConnectedNodes | Connected nodes, will not restore connected nodes`)
            return resolve()
          }

          log(`- _initializeConnectedNodes | Connected nodes not found, restoring nodes from ${COVERBOT_RESTORE_SCORE_FROM}`)
          const previousConnectedNodes = await db.ref(`/${COVERBOT_RESTORE_SCORE_FROM}/state`).child('connected').once("value")
          if (!previousConnectedNodes.exists()) {
            log(`- _initializeConnectedNodes | No connected nodes found in ${COVERBOT_RESTORE_SCORE_FROM}`)
            return resolve()
          }
          const connectedNodes = previousConnectedNodes.val() || []
          log(`- initializeScores | Found ${connectedNodes.length} nodes from ${COVERBOT_RESTORE_SCORE_FROM}.`)
          await stateDbRef.child("connected").set(connectedNodes)
          log(`- initializeScores | Added ${connectedNodes.length} nodes to our connected nodes array.`)

          return resolve()
        } catch (error) {
          return reject(error)
        }
      })
    })
  }

  private async _initializeScores(): Promise<void> {
    if (!COVERBOT_RESTORE_SCORE_FROM) return
    log(`- initializeScores | Restoring scores from '${COVERBOT_RESTORE_SCORE_FROM}' if our scores don't exist`)

    return new Promise<void>((resolve, reject) => {
      log(`- initializeScores | Loading scores`)

      scoreDbRef.once("value", async (snapshot, error) => {
        try {
          if (error) return reject(error)
          if (snapshot.exists()) {
            log(`- initializeScores | Scores found, will not restore scores`)
            return resolve()
          }

          log(`- initializeScores | Scores not found, restoring scores from ${COVERBOT_RESTORE_SCORE_FROM}`)
          const previousScores = await db.ref(`/${COVERBOT_RESTORE_SCORE_FROM}/score`).once("value")
          if (!previousScores.exists()) {
            log(`- initializeScores | No scores found in ${COVERBOT_RESTORE_SCORE_FROM}`)
            return resolve()
          }

          // reset scores to '$ScoreRewards.verified'
          const scores = {}
          for (const id in (previousScores.val() || {})) {
            scores[id] = ScoreRewards.verified
          }

          await scoreDbRef.set(scores)
          log(`- initializeScores | Added ${Object.values(scores).length} scores with value ${ScoreRewards.verified}`)

          return resolve()
        } catch (error) {
          return reject(error)
        }
      })
    })
  }

  private async _saveBotId(): Promise<void> {
    log(`- setBotId | Storing bot ID`)
    await botsDbRef.child(this.address).set(this.secret)
    log(`- setBotId | Stored bot ID`)
  }

  private async initialize(): Promise<void> {
    log(`- initialize | Initializing database data`)

    await Promise.all([
      this._initializeScores(),
      this._initializeConnectedNodes(),
      this._loadState(),
      this._saveBotId(),
    ])

    this.initialized = true
  }

  protected async dumpData() {
    log(`- dumpData | Starting dumping data in Database`)

    const connectedNodes = this.node.listConnectedPeers()
    log(`- dumpData | Detected ${connectedNodes} in the network w/bootstrap servers ${this.node.getBootstrapServers()}`)

    if (COVERBOT_SUPPORT_MODE) {
      log(`- dumpData | ${this.address} is enabled as a support coverbot, no writing done to state table`)
      return;
    }

    //@TODO: Ideally we move this to a more suitable place.
    if (!this.ethereumAddress) {
      this.chainId = await Utils.getChainId(this.xdaiWeb3)
      this.network = Utils.getNetworkName(this.chainId) as Networks
      this.ethereumAddress = await this._getEthereumAddressFromHOPRAddress(this.address)
    }

    const state = {
      connectedNodes,
      env: {
        COVERBOT_CHAIN_PROVIDER,
        COVERBOT_DEBUG_MODE,
        COVERBOT_VERIFICATION_CYCLE_IN_MS,
        COVERBOT_XDAI_THRESHOLD,
        COVERBOT_TIMESTAMP
      },
      hoprCoverbotAddress: await this._getEthereumAddressFromHOPRAddress(this.address),
      hoprChannelContract: HOPR_CHANNELS[this.network],
      address: this.address,
      balance: fromWei(await this.xdaiWeb3.eth.getBalance(this.ethereumAddress)),
      available: fromWei(await this.node.getHoprBalance()),
      locked: 0, //@TODO: Retrieve balances from open channels.
      connected: Array.from(this.verifiedHoprNodes.values()),
      refreshed: new Date().toISOString(),
    }

    return new Promise((resolve, reject) => {
      stateDbRef.set(state, (error) => {
        if (error) return reject(error)
        log(`- dumpData | Saved data in our Database at ${state.refreshed}`)
        return resolve()
      })
    })
  }

  protected _sendMessageFromBot(recipient, message, intermediatePeerIds = [], includeRecipient = true) {
    log(`- sendMessageFromBot | Sending ${intermediatePeerIds.length} hop message to ${recipient}`)
    log(`- sendMessageFromBot | Message: ${message}`)
    return this.node.send({
      peerId: recipient,
      payload: message,
      intermediatePeerIds,
      includeRecipient
    })
  }

  protected async _verificationProcess(_hoprNodeAddress, prevBots = []) {
    log(`- _verificationProcess | Starting verification process, trying to relay ${_hoprNodeAddress}.`)
    prevBots.length > 0 && log(`- _verificationProcess | The following prevBots had been given: ${prevBots.toString()}`)

    this._sendMessageFromBot(_hoprNodeAddress, BotResponses[BotCommands.verify])
      .catch(err => {
        error(`Trying to send ${BotCommands.verify} message to ${_hoprNodeAddress} failed.`, err)
      })
    /*
      * We switched from “send and forget” to “send and listen”
      * 1. We inmediately send a message to user, telling them we find them online.
      * 2. We use them as a relayer, expecting to get our message later.
      * 3. We save a timeout, to fail the node if the relayed package doesnt come back.
      * 4. We wait RELAY_VERIFICATION_CYCLE_IN_MS seconds for the relay to get back.
      *    A) If we don't get the message back before RELAY_VERIFICATION_CYCLE_IN_MS,
      *
      *    B) If we DO get the message back, we’ll get it in the handler function and
      *    processed there as a successful relay.
      */

    // 1.
    console.log(`- verificationCycle | Relaying node ${_hoprNodeAddress}, checking in ${RELAY_VERIFICATION_CYCLE_IN_MS}`)
    this._sendMessageFromBot(_hoprNodeAddress, NodeStateResponses[NodeStates.onlineNode])
      .catch(err => {
        error(`Trying to send ${NodeStates.onlineNode} message to ${_hoprNodeAddress} failed.`, err)
      })

    // 2. Open a payment channel to the hoprNodeAddress
    const pubkey = await convertPubKeyFromB58String(_hoprNodeAddress)
    const counterParty = await pubKeyToPeerId(pubkey.marshal())
    const { channelId } = await this.node.openPaymentChannel(counterParty, new BN(RELAY_HOPR_REWARD));
    this._sendMessageFromBot(_hoprNodeAddress, `Opened a payment channel to you at ${u8aToHex(channelId)}`)
      .catch(err => {
        error(`Trying to send OPENNED_PAYMENT_CHANNEL message to ${_hoprNodeAddress} failed.`, err)
      })

    // 3. Send now a relayed message.
    this._sendMessageFromBot(this.address, ` Relaying package with secret=${this.secret} to ${_hoprNodeAddress}`, [_hoprNodeAddress])
      .catch(err => {
        error(`Trying to send RELAY message to ${_hoprNodeAddress} failed.`, err)
      })

    // 4.
    this.relayTimeouts.set(
      _hoprNodeAddress,
      setTimeout(() => {
        // 4.1
        /*
          * The timeout passed, and we didn‘t get the message back, so now
          * 4.A.1 We identify how many coverbots (other than us) can help us to relay.
          *   4.A.1.1 We create an array of these bots and store that value internally.
          *   4.A.1.2 In case prev bots are passed, we make sure to use these instead.
          * 4.A.2 We pick another coverbot from our bots array to try and relay.
          * 4.A.3 We send that coverbot both the other bots available and help request.
          * NB: UPDATED BY JA FOR Basodino v2 [4.1.1 Internally log that this is the case.]
          * NB: UPDATED BY JA FOR Basodino v2 [4.1.2 Let the node that we couldn't get our response back in time.]
          * NB: UPDATED BY JA FOR Basodino v2 [4.1.3 Remove from timeout so they can try again somehow.]
          * NB: DELETED BY PB AFTER CHAT 10/9 [4.1.4 Remove from our verified node and write to the database]
          */

        // 4.A.1
        log(`- verificationCycle | Timeout :: No response from ${_hoprNodeAddress}, will ask another coverbot to give a try.`)
        const botsAvailable = Object.keys(this.bots)

        let nextBot, otherBotsShortVersion;

        if (prevBots.length <= 0) {
          // 4.A.1.1
          log(`- verificationCycle | Timeout :: We have no prev bots stored in our system, will use all ${botsAvailable.length} bots from database.`)
          log(`- verificationCycle | Timeout :: Since we found ${botsAvailable.length} bots available including myself, I‘ll remove me.`)
          const otherBots = botsAvailable.filter(bot => bot !== this.address)
          log(`- verificationCycle | Timeout :: Currently there are at least ${otherBots.length} other bots willing to help.`)

          // 4.A.2
          nextBot = otherBots[0]
          log(`- verificationCycle | Timeout :: We have found our next bot to be ${nextBot}.`)
          otherBotsShortVersion = otherBots.map(bot => bot.substr(-AMOUNT_OF_IDENTIFIABLE_LETTERS))
          log(`- verificationCycle | Timeout :: We'll be sending the next other bots to our helper: ${otherBotsShortVersion.toString()}.`)
        } else {
          // 4.A.1.2
          log(`- verificationCycle | Timeout :: We have ${prevBots.length} prev bots stored in our system: ${prevBots.toString()}`)
          log(`- verificationCycle | Timeout :: We‘ll remove ourselves from these prev bots, to have ${prevBots.length - 1} prev bots.`)
          const otherPrevBots = prevBots.filter(bot => bot !== this.address.substr(-AMOUNT_OF_IDENTIFIABLE_LETTERS))
          log(`- verificationCycle | Timeout :: We‘ll grab the next prev bot for us to use: ${otherPrevBots[0]}`)
          const otherPrevBot = otherPrevBots[0]

          // 4.A.2
          nextBot = otherPrevBot && botsAvailable.filter(bot => bot.substr(-AMOUNT_OF_IDENTIFIABLE_LETTERS) === otherPrevBot)
          log(`- verificationCycle | Timeout :: We have found our next bot to be ${nextBot} from our prev bots.`)
          otherBotsShortVersion = otherPrevBots;
          log(`- verificationCycle | Timeout :: We'll be sending the remaining prev bots to our helper: ${otherBotsShortVersion.toString()}.`)
        }

        if (!nextBot) {
          // There are no other bots to help us, we default to our normal path.
          log(`- verificationCycle | Timeout :: No bots to ask for help, we’ll just stop here.`)

          // 4.1.2
          this._sendMessageFromBot(_hoprNodeAddress, NodeStateResponses[NodeStates.relayingNodeFailed])
            .catch(err => {
              error(`Trying to send ${NodeStates.relayingNodeFailed} message to ${_hoprNodeAddress} failed.`, err)
            })

          // 4.1.3
          this.relayTimeouts.delete(_hoprNodeAddress)

          // 4.1.4
          //this.verifiedHoprNodes.delete(_hoprNodeAddress)
          //this.dumpData()

        } else {
          // There are at least one additional bot we can ask for help.
          log(`- verificationCycle | Timeout :: A brave bot ${nextBot} is here to help us.`)

          // Let's notify the user that we failed, but other bot might not.
          this._sendMessageFromBot(_hoprNodeAddress, NodeStateResponses[NodeStates.relayingNodeFailedButWillTryWithOtherBot])
            .catch(err => {
              error(`Trying to send ${NodeStates.relayingNodeFailedButWillTryWithOtherBot} message to ${_hoprNodeAddress} failed.`, err)
            })

          // 4.A.3.
          this._sendMessageFromBot(nextBot, ` Help request with secret=${this.secret}, please relay to relayedBot=${_hoprNodeAddress}, if can‘t use otherBots=${otherBotsShortVersion}`)
            .catch(err => {
              error(`Trying to send HELP message to ${nextBot} failed.`, err)
            })

          // We ensure to clear timout to give the node another chance in the next cycle.
          this.relayTimeouts.delete(_hoprNodeAddress)
        }
      }, RELAY_VERIFICATION_CYCLE_IN_MS),
    )
  }

  protected async _verificationCycle() {
    if (!this.initialized) {
      await this.initialize()
    }

    await this.dumpData()

    const now = new Date(Date.now())
    if (now < this.relayTimestamp) {
      log(`- verificationCycle | Not ready to relay. It's ${now}, waiting until ${this.relayTimestamp}`)
      return;
    } else {
      log(`- verificationCycle | Ready to relay. It's ${now}, bigger than ${this.relayTimestamp}`)
    }

    log(`- verificationCycle | ${COVERBOT_VERIFICATION_CYCLE_IN_MS}ms has passed. Verifying nodes...`)
    COVERBOT_DEBUG_MODE && log(`- verificationCycle | DEBUG mode activated, looking for ${COVERBOT_DEBUG_HOPR_ADDRESS}`)

    log(`- verificationCycle | Reloading lists of coverbots`)
    await this._loadBotsWithSecrets()
    log(`- verificationCycle | Coverbots lists completed, currently ${Object.entries(this.bots).length} bots in the system.`)

    const _verifiedNodes = Array.from(this.verifiedHoprNodes.values())
    const randomIndex = Math.floor(Math.random() * _verifiedNodes.length)
    const hoprNode: HoprNode = _verifiedNodes[randomIndex]

    if (!hoprNode) {
      log(`- verificationCycle | No node from our memory. Skipping...`)
      return
    }

    if (this.relayTimeouts.get(hoprNode.id)) {
      log(`- verificationCycle | Node ${hoprNode.id} selected is going through relaying. Skipping...`)
      return
    }

    try {
      log(`- verificationCycle | Verifying node process, looking for tweet ${hoprNode.tweetUrl}`)
      const tweet = new TweetMessage(hoprNode.tweetUrl)
      await tweet.fetch({ mock: COVERBOT_DEBUG_MODE })
      const _hoprNodeAddress = tweet.getHOPRNode({ mock: COVERBOT_DEBUG_MODE, hoprNode: COVERBOT_DEBUG_HOPR_ADDRESS })

      if (_hoprNodeAddress.length === 0) {
        log(`- verificationCycle | No node has been found from our tweet w/content ${tweet.content}`)
        // this.verifiedHoprNodes.delete(hoprNode.id)
        //await this.dumpData()
        return
      } else {
        return this._verificationProcess(_hoprNodeAddress)
      }
    } catch (err) {
      console.log('[ _verificationCycle ] Error caught - ', err)

      // Something failed. We better remove node and update.
      // @TODO: Clean this up, removed for now to ask users to try again.
      // this.verifiedHoprNodes.delete(hoprNode.id)
      // this.dumpData()
    }
  }

  protected async _verifyBalance(message: IMessage): Promise<[number, NodeStates]> {
    const pubkey = await convertPubKeyFromB58String(message.from)
    const nodeEthereumAddress = u8aToHex(await Utils.pubKeyToAccountId(pubkey.marshal()))
    const weiBalance = await this.xdaiWeb3.eth.getBalance(nodeEthereumAddress)
    const balance = +Web3.utils.fromWei(weiBalance)

    return balance >= COVERBOT_XDAI_THRESHOLD
      ? [balance, NodeStates.xdaiBalanceSucceeded]
      : [balance, NodeStates.xdaiBalanceFailed]
  }

  protected async _verifyTweet(message: IMessage): Promise<[TweetMessage, NodeStates]> {
    //@TODO: Catch error here.
    const tweet = new TweetMessage(message.text)
    this.tweets.set(message.from, tweet)

    await tweet.fetch({ mock: COVERBOT_DEBUG_MODE })

    if (tweet.hasTag('basodino')) {
      tweet.status.hasTag = true
    }
    if (tweet.hasMention('hoprnet')) {
      tweet.status.hasMention = true
    }
    if (tweet.hasSameHOPRNode(message.from) || COVERBOT_DEBUG_MODE) {
      tweet.status.sameNode = true
    }

    COVERBOT_DEBUG_MODE && tweet.validateTweetStatus()

    return tweet.status.isValid()
      ? [tweet, NodeStates.tweetVerificationSucceeded]
      : [tweet, NodeStates.tweetVerificationFailed]
  }

  protected async _verifySecret(message: IMessage, secret?: number): Promise<[number, NodeStates]> {
    const secretToVerify = secret || this.secret;
    const correctSecret = message.text.includes(`secret=${secretToVerify}`)

    return correctSecret
      ? [this.secret, NodeStates.secretVerificationSucceeded]
      : [this.secret, NodeStates.secretVerificationFailed]
  }

  async handleMessage(message: IMessage) {
    log(`- handleMessage | ${this.botName} <- ${message.from}: ${message.text}`)

    if (Object.keys(this.bots).includes(message.from)) {
      /*
       * We now listen to both our address and messages from other coverbots. There
       * are help requests we can receive from another coverbot (B), and succesful relays
       * we can receive from ourselves (A)
       *
       * if ourselves (A),
       *   We have done a successful roundtrip
       *
       * if from another coverbot (B)
       *   We are requested for help to do a verify on behalf another coverbot.
       *
       */

      if (message.from === this.address) {
        /*
         * We have done a succesful round trip! (A)
         * 1. Lets avoid sending more messages to eternally loop
         *    messages across the network by returning within this if.
         * 2. Let's verify that the relayed message came from one of our bots.
         * 3. Let's notify the user about the successful relay.
         * 4. Let's recover the timeout from our relayerTimeout
         *    and clear it before it removes the node.
         * 5. Let's update the good node score for being alive
         *    and relaying messages successfully.
         */
        const relayerAddress = getHOPRNodeAddressFromContent(message.text)
        const secretVerification = await this._verifySecret(message).then(res => res[1])

        // 2.
        if (secretVerification === NodeStates.secretVerificationFailed) {
          log(`- handleMessage | Secret verification failed: ${relayerAddress}`)

          this._sendMessageFromBot(relayerAddress, NodeStateResponses[NodeStates.secretVerificationFailed])
            .catch(err => {
              error(`Trying to send ${NodeStates.secretVerificationFailed} message to ${relayerAddress} failed.`, err)
            })

          return
        } else {
          log(`- handleMessage | Secret verification succeeded: ${relayerAddress}`)

          this._sendMessageFromBot(relayerAddress, NodeStateResponses[NodeStates.secretVerificationSucceeded])
            .catch(err => {
              error(`Trying to send ${NodeStates.secretVerificationSucceeded} message to ${relayerAddress} failed.`, err)
            })
        }

        // 3.
        log(`- handleMessage | Successful Relay: ${relayerAddress}`)
        this._sendMessageFromBot(relayerAddress, NodeStateResponses[NodeStates.relayingNodeSucceded])
          .catch(err => {
            error(`Trying to send ${NodeStates.relayingNodeSucceded} message to ${relayerAddress} failed.`, err)
          })

        // 4.
        const relayerTimeout = this.relayTimeouts.get(relayerAddress)
        clearTimeout(relayerTimeout)
        this.relayTimeouts.delete(relayerAddress)

        // 5.
        const [newScore] = await Promise.all([
          this._increaseHoprAddressScore(relayerAddress, (prevScore) => {
            if (!prevScore) return ScoreRewards.relayed
            return prevScore + ScoreRewards.relayed
          }),
          //this.node.withdraw({ currency: 'HOPR', recipient: relayerEthereumAddress, amount: `${RELAY_HOPR_REWARD}`}),
        ])
        log(`- handleMessage | New score ${newScore} updated for ${relayerAddress}`)
        this._sendMessageFromBot(relayerAddress, NodeStateResponses[NodeStates.verifiedNode])

        // 1.
        return

      } else {
        /*
        * We are requested for help! (B)
        */

        log(`- handleMessage | Help Request :: We got a help request from ${message.from} with content ${message.text}`)

        const secretToVerify = this.bots[message.from]
        const secretVerification = await this._verifySecret(message, secretToVerify).then(res => res[1])

        if (secretVerification === NodeStates.secretVerificationFailed) {
          log(`- handleMessage | Help Request :: Secret verification failed, ${message.from} isn’t a recognized coverbot.`)
          return
        } else {
          log(`- handleMessage | Help Request :: Secret verification succeeded, ${message.from} is a valid bot asking for help.`)
          const relayerAddress = getHOPRNodeAddressFromContent(message.text)
          log(`- handleMessage | Help Request :: Identified node ${relayerAddress} that wants to be relayed from help request.`)

          /*
          * Grabbing a=b[c,d...] w/regex ([0]) to do a=b[c,d...].split(=)
          * Grabbing b[c,d...], from [1] to do b[c,d...].split(,)
          */
          const otherBotsRegex = /(\w+)=([^\s]+)/g
          const otherBots = message.text.match(otherBotsRegex)[0].split('=')[1].split(',')
          log(`- handleMessage | Help Request :: Trying to get ${relayerAddress} to relay, passing ${otherBots.toString()} as bots received`)
          this._verificationProcess(relayerAddress, otherBots)
        }

        return
      }
    }

    if (this.relayTimeouts.get(message.from)) {
      /*
       * There‘s a particular case where someone can send us a message while
       * we are trying to relay them a package. We'll skip the entire process
       * if this is the case, as the timeout will clear them out.
       *
       * 1. Detect if we have someone waiting for timeout (this if).
       * 2. If so, then quickly return them a message telling we are waiting.
       * 3. Return as to avoid going through the entire process again.
       *
       */

      // 2.
      this._sendMessageFromBot(message.from, NodeStateResponses[NodeStates.relayingNodeInProgress])
        .catch(err => {
          error(`Trying to send ${NodeStates.relayingNodeInProgress} message to ${message.from} failed.`, err)
        })

      // 3.
      return
    }

    let tweet, nodeState
    if (message.text.match(/https:\/\/twitter.com.*?$/i)) {
      this._sendMessageFromBot(message.from, NodeStateResponses[NodeStates.tweetVerificationInProgress])
        .catch(err => {
          error(`Trying to send ${NodeStates.tweetVerificationFailed} message to ${message.from} failed.`, err)
        })
        ;[tweet, nodeState] = await this._verifyTweet(message)
    } else {
      ;[tweet, nodeState] = [undefined, NodeStates.newUnverifiedNode]
    }

    switch (nodeState) {
      case NodeStates.newUnverifiedNode:
        this._sendMessageFromBot(message.from, NodeStateResponses[nodeState])
          .catch(err => {
            error(`Trying to send ${nodeState} message to ${message.from} failed.`, err)
          })
        break
      case NodeStates.tweetVerificationFailed:
        this._sendMessageFromBot(message.from, NodeStateResponses[nodeState](this.tweets.get(message.from).status))
          .catch(err => {
            error(`Trying to send ${nodeState} message to ${message.from} failed.`, err)
          })
        break
      case NodeStates.tweetVerificationSucceeded:
        this._sendMessageFromBot(message.from, NodeStateResponses[nodeState])
          .catch(err => {
            error(`Trying to send ${nodeState} message to ${message.from} failed.`, err)
          })
        const [balance, xDaiBalanceNodeState] = await this._verifyBalance(message)
        switch (xDaiBalanceNodeState) {
          case NodeStates.xdaiBalanceFailed:
            this._sendMessageFromBot(message.from, NodeStateResponses[xDaiBalanceNodeState](balance))
              .catch(err => {
                error(`Trying to send ${xDaiBalanceNodeState} message to ${message.from} failed.`, err)
              })
            break
          case NodeStates.xdaiBalanceSucceeded: {
            const ethAddress = await this._getEthereumAddressFromHOPRAddress(message.from)

            this.verifiedHoprNodes.set(message.from, {
              id: message.from,
              tweetId: tweet.id,
              tweetUrl: tweet.url,
              address: ethAddress,
            })

            // set initial score
            await this._increaseHoprAddressScore(message.from, (prevScore) => {
              // already set
              if (prevScore) return undefined
              return ScoreRewards.verified
            })

            await this.dumpData()

            this._sendMessageFromBot(message.from, NodeStateResponses[xDaiBalanceNodeState](balance))
              .catch(err => {
                error(`Trying to send ${xDaiBalanceNodeState} message to ${message.from} failed.`, err)
              })
            break
          }
        }
        this._sendMessageFromBot(message.from, BotResponses[BotCommands.status](xDaiBalanceNodeState))
          .catch(err => {
            error(`Trying to send ${BotCommands.status} message to ${message.from} failed.`, err)
          })
        break
    }
    this._sendMessageFromBot(message.from, BotResponses[BotCommands.status](nodeState))
      .catch(err => {
        error(`Trying to send ${BotCommands.status} message to ${message.from} failed.`, err)
      })
  }
}
