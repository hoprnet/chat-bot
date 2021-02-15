import Hopr from '@hoprnet/hopr-core'
import type { HoprOptions } from '@hoprnet/hopr-core'
import type { Types } from '@hoprnet/hopr-core-connector-interface'
import HoprCoreConnector, { Currencies } from '@hoprnet/hopr-core-connector-interface'
import { getBootstrapAddresses, u8aToHex, parseHosts } from '@hoprnet/hopr-utils'
import BN from 'bn.js'
import PeerId from 'peer-id'
import { EventEmitter } from 'events'
import { encode, decode } from 'rlp'
import debug from 'debug'


const log = debug('hopr-chatbot:core')
const error = debug('hopr-chatbot:core:error')

export default class Core {
  public events: EventEmitter
  node: Hopr<HoprCoreConnector>
  options: HoprOptions
  protected started: Boolean

  static mustBeStarted(): MethodDecorator {
    return (_target: Core, _key: string, descriptor: TypedPropertyDescriptor<any>): TypedPropertyDescriptor<any> => {
      const originalFn = descriptor.value
      descriptor.value = function (...args: any[]) {
        if (!this.started) {
          throw Error('HOPR node is not started')
        }
        return originalFn.bind(this)(...args)
      }
      return descriptor
    }
  }

  private _functor(msg: Uint8Array) {
    log('- functor | Received message')
    try {
      const [decoded, time] = decode(msg) as [Buffer, Buffer]
      log('- functor | Message', decoded.toString())
      log('- functor | Latency', Date.now() - parseInt(time.toString('hex'), 16) + 'ms')
      this.events.emit('message', decoded)
    } catch (err) {
      error('- functor | Error: Could not decode message', err)
      error('- functor | Error: Message', msg.toString())
    }
  }

  constructor(
    options: HoprOptions = {
      provider: process.env.HOPR_CHATBOT_PROVIDER || 'wss://ws-mainnet.matic.network',
      network: process.env.HOPR_CHATBOT_NETWORK || 'ETHEREUM',
      debug: Boolean(process.env.HOPR_CHABOT_DEBUG) || false,
      password: process.env.HOPR_CHATBOT_PASSWORD || 'switzerland',
      hosts: parseHosts()
    },
  ) {
    this.options = { ...options, output: this._functor.bind(this) }
    this.events = new EventEmitter()
  }

  async start(): Promise<void> {
    try {
      log('- start | Creating HOPR Node')
      this.node = await Hopr.create({
        ...this.options,
        bootstrapServers: [...(await getBootstrapAddresses()).values()],
      })
      log('- start | Created HOPR Node')
      this.started = true
      log('- start | Started HOPR Node')
    } catch (err) {
      error('- start | Error: Unable to start node', err)
    }
  }

  @Core.mustBeStarted()
  async getHoprBalance(): Promise<string> {
      return (await this.node.paymentChannels.account.balance).toString()
  }

  @Core.mustBeStarted()
  async getBalance(): Promise<string> {
      return (await this.node.paymentChannels.account.nativeBalance).toString()
  }

  @Core.mustBeStarted()
  getBootstrapServers(): string {
      return this.node.bootstrapServers.map(node => node.id.toB58String()).join(',')
  }

  @Core.mustBeStarted()
  async withdraw({
    currency,
    recipient,
    amount,
  }: {
    currency: Currencies
    recipient: string
    amount: string
  }): Promise<string> {
      return await this.node.paymentChannels.withdraw(currency, recipient, amount)
  }

  @Core.mustBeStarted()
  async openPaymentChannel(counterParty: PeerId, amountToFund: BN) {
    const { utils, types, account } = this.node.paymentChannels
    const self = this.node.peerInfo.id

    const channelId = await utils.getId(
      await utils.pubKeyToAccountId(self.pubKey.marshal()),
      await utils.pubKeyToAccountId(counterParty.pubKey.marshal())
    )

    const myAvailableTokens = await account.balance

    // validate 'amountToFund'
    if (amountToFund.lten(0)) {
      throw Error(`Invalid 'amountToFund' provided: ${amountToFund.toString(10)}`)
    } else if (amountToFund.gt(myAvailableTokens)) {
      throw Error(`You don't have enough tokens: ${amountToFund.toString(10)}<${myAvailableTokens.toString(10)}`)
    }

    const amPartyA = utils.isPartyA(
      await utils.pubKeyToAccountId(self.pubKey.marshal()),
      await utils.pubKeyToAccountId(counterParty.pubKey.marshal())
    )

    const channelBalance = types.ChannelBalance.create(
      undefined,
      amPartyA
        ? {
            balance: amountToFund,
            balance_a: amountToFund
          }
        : {
            balance: amountToFund,
            balance_a: new BN(0)
          }
    )

    await this.node.paymentChannels.channel.create(
      counterParty.pubKey.marshal(),
      async () => this.node.interactions.payments.onChainKey.interact(counterParty),
      channelBalance,
      (balance: Types.ChannelBalance): Promise<Types.SignedChannel> =>
        this.node.interactions.payments.open.interact(counterParty, balance)
    )

    return {
      channelId
    }

  }

  @Core.mustBeStarted()
  listConnectedPeers(): number {
      return Array.from(this.node.peerStore.peers.values()).length
  }

  @Core.mustBeStarted()
  async send({
    peerId,
    payload,
    intermediatePeerIds = [],
    includeRecipient = false
  }: {
    peerId: string
    payload: Uint8Array
    intermediatePeerIds?: string[]
    includeRecipient?: boolean
  }): Promise<{
    intermediatePeerIds: string[]
  }> {
    const message = encode([includeRecipient ? `${await this.address('hopr')}:${payload}` : payload, Date.now()])
    log(`- send | Sending message: ${payload}`)
    await this.node.sendMessage(message, PeerId.createFromB58String(peerId), async () =>
      intermediatePeerIds.map((str) => PeerId.createFromB58String(str)),
    )
    return {
      intermediatePeerIds,
    }
  }

  @Core.mustBeStarted()
  async address(type: 'native' | 'hopr'): Promise<string> {
    if (type === 'native') {
      return this.node.paymentChannels.utils.pubKeyToAccountId(this.node.peerInfo.id.pubKey.marshal()).then(u8aToHex)
    } else {
      return this.node.peerInfo.id.toB58String()
    }
  }
}
