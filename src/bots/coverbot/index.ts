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
  COVERBOT_RESTORE_SCORE_FROM
} from '../../utils/env'
import db from './db'
import { BotCommands, NodeStates, ScoreRewards } from './state'
import { RELAY_VERIFICATION_CYCLE_IN_MS, RELAY_HOPR_REWARD, HOPR_ENVIRONMENTS } from './constants'
import { BotResponses, NodeStateResponses } from './responses'
import { BalancedHoprNode, HoprNode } from './coverbot'
import debug from 'debug'
import Core from '../../lib/hopr/core'
import BN from 'bn.js'


const log = debug('hopr-chatbot:coverbot')
const error = debug('hopr-chatbot:coverbot:error')
const { fromWei } = Web3.utils

const scoreDbRef = db.ref(`/${HOPR_ENVIRONMENT}/score`)
const stateDbRef = db.ref(`/${HOPR_ENVIRONMENT}/state`)

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
  nativeAddress: string
  address: string
  timestamp: Date
  status: Map<string, NodeStates>
  tweets: Map<string, TweetMessage>
  twitterTimestamp: Date
  relayTimestamp: Date

  verifiedHoprNodes: Map<string, HoprNode>
  relayTimeouts: Map<string, NodeJS.Timeout>
  verificationTimeout: NodeJS.Timeout

  xdaiWeb3: Web3
  ethereumAddress: string
  chainId: number
  network: Networks
  loadedDb: boolean

  constructor({ node, hoprBalance, balance }: BalancedHoprNode, nativeAddress: string, address: string, timestamp: Date, twitterTimestamp: Date) {
    this.node = node
    this.initialBalance = balance
    this.initialHoprBalance = hoprBalance
    this.address = address
    this.nativeAddress = nativeAddress
    this.timestamp = timestamp
    this.status = new Map<string, NodeStates>()
    this.tweets = new Map<string, TweetMessage>()
    this.twitterTimestamp = twitterTimestamp
    this.botName = '💰 Coverbot'
    this.loadedDb = false
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
    this.loadData()
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

  private async _setHoprAddressScore(hoprAddress: string, score: number): Promise<void> {
    return new Promise((resolve, reject) => {
      scoreDbRef.child(hoprAddress).setWithPriority(score, -score, (error) => {
        if (error) return reject(error)
        return resolve()
      })
    })
  }

  private async loadData(): Promise<void> {
    log(`- loadData | Loading data from our Database`)

    // initialize state
    await new Promise<void>((resolve, reject) => {
      log(`- loadData | Loading state`)

      stateDbRef.once('value', (snapshot, error) => {
        if (error) return reject(error)
        if (!snapshot.exists()) {
          log(`- loadData | Database hasn’t been created`)
          return resolve()
        }
        const state = snapshot.val()
        const connected = state.connected || []
        log(`- loadData | Loaded ${connected.length} nodes from our Database`)
        this.verifiedHoprNodes = new Map<string, HoprNode>()
        connected.forEach((n) => this.verifiedHoprNodes.set(n.id, n))
        log(`- loadData | Updated ${Array.from(this.verifiedHoprNodes.values()).length} verified nodes in memory`)
        return resolve()
      })
    })

    // restore scores only if 'COVERBOT_RESTORE_SCORE_FROM' is provided
    if (COVERBOT_RESTORE_SCORE_FROM) {
      log(`- loadData | Restoring scores from '${COVERBOT_RESTORE_SCORE_FROM}' if our scores don't exist`)

      await new Promise<void>((resolve, reject) => {
        log(`- loadData | Loading scores`)
  
        scoreDbRef.once("value", async (snapshot, error) => {
          try {
            if (error) return reject(error)
            if (snapshot.exists()) {
              log(`- loadData | Scores found, will not restore scores`)
              return resolve()
            }
  
            log(`- loadData | Scores not found, restoring scores from ${COVERBOT_RESTORE_SCORE_FROM}`)
            const previousScores = await db.ref(`/${COVERBOT_RESTORE_SCORE_FROM}/score`).once("value")
            if (!previousScores.exists()) {
              log(`- loadData | No scores found in ${COVERBOT_RESTORE_SCORE_FROM}`)
              return resolve()
            }
  
            // reset scores to '$ScoreRewards.verified'
            const scores = {}
            for (const id in (previousScores.val() || {})) {
              scores[id] = ScoreRewards.verified
            }

            await scoreDbRef.set(scores)
            log(`- loadData | Added ${Object.values(scores).length} scores with value ${ScoreRewards.verified}`)

            return resolve()
          } catch (error) {
            return reject(error)
          }
        })
      })
    }

    this.loadedDb = true
  }

  protected async dumpData() {
    log(`- dumpData | Starting dumping data in Database`)
    //@TODO: Ideally we move this to a more suitable place.
    if (!this.ethereumAddress) {
      this.chainId = await Utils.getChainId(this.xdaiWeb3)
      this.network = Utils.getNetworkName(this.chainId) as Networks
      this.ethereumAddress = await this._getEthereumAddressFromHOPRAddress(this.address)
    }

    const connectedNodes = this.node.listConnectedPeers()
    log(`- loadData | Detected ${connectedNodes} in the network w/bootstrap servers ${this.node.getBootstrapServers()}`)

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

  protected async _verificationCycle() {
    if (!this.loadedDb) {
      await this.loadData()
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
         *    4.1 If we don't get the message back before RELAY_VERIFICATION_CYCLE_IN_MS,
         *        then we remove the node from the verification table and redump data.
         *    4.2 If we DO get the message back, then we go and execute the payout function.
         */

        // 1.
        console.log(`Relaying node ${_hoprNodeAddress}, checking in ${RELAY_VERIFICATION_CYCLE_IN_MS}`)
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
        this._sendMessageFromBot(this.address, ` Relaying package to ${_hoprNodeAddress}`, [_hoprNodeAddress])
          .catch(err => {
            error(`Trying to send RELAY message to ${_hoprNodeAddress} failed.`, err)
          })

        // 3.
        this.relayTimeouts.set(
          _hoprNodeAddress,
          setTimeout(() => {
            // 4.1
            /*
             * The timeout passed, and we didn‘t get the message back.
             * 4.1.1 Internally log that this is the case.
             * 4.1.2 Let the node that we couldn't get our response back in time.
             * 4.1.3 Remove from timeout so they can try again somehow.
             * NB: DELETED BY PB AFTER CHAT 10/9 [4.1.4 Remove from our verified node and write to the database]
             */

            // 4.1.1
            console.log(`No response from ${_hoprNodeAddress}.`) // Removing as valid node.`)

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
          }, RELAY_VERIFICATION_CYCLE_IN_MS),
        )
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

  async handleMessage(message: IMessage) {
    log(`- handleMessage | ${this.botName} <- ${message.from}: ${message.text}`)

    if (message.from === this.address) {
      /*
       * We have done a succeful round trip!
       * 1. Lets avoid sending more messages to eternally loop
       *    messages across the network by returning within this if.
       * 2. Let's notify the user about the successful relay.
       * 3. Let's recover the timeout from our relayerTimeout
       *    and clear it before it removes the node.
       * 4. Let's update the good node score for being alive
       *    and relaying messages successfully.
       */
      const relayerAddress = getHOPRNodeAddressFromContent(message.text)

      // 2.
      log(`- handleMessage | Successful Relay: ${relayerAddress}`)
      this._sendMessageFromBot(relayerAddress, NodeStateResponses[NodeStates.relayingNodeSucceded])
        .catch(err => {
          error(`Trying to send ${NodeStates.relayingNodeSucceded} message to ${relayerAddress} failed.`,err)
        })

      // 3.
      const relayerTimeout = this.relayTimeouts.get(relayerAddress)
      clearTimeout(relayerTimeout)
      this.relayTimeouts.delete(relayerAddress)

      // 4.
      const score = await this._getHoprAddressScore(relayerAddress)
      const newScore = score + ScoreRewards.relayed

      await Promise.all([
        this._setHoprAddressScore(relayerAddress, newScore),
        //this.node.withdraw({ currency: 'HOPR', recipient: relayerEthereumAddress, amount: `${RELAY_HOPR_REWARD}`}),
      ])
      console.log(`New score ${newScore} updated for ${relayerAddress}`)
      this._sendMessageFromBot(relayerAddress, NodeStateResponses[NodeStates.verifiedNode])

      // 1.
      return
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
          error(`Trying to send ${NodeStates.relayingNodeInProgress} message to ${message.from} failed.`,err)
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

            const score = await this._getHoprAddressScore(message.from)
            if (score === 0) {
              await this._setHoprAddressScore(message.from, ScoreRewards.verified)
            }

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
