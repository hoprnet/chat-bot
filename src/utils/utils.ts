import * as words from '../bots/randobot/words'
import { getB58String } from '@hoprnet/hopr-utils'
import debug from 'debug'


const log = debug('hopr-chatbot:utils')

export const getRandomItemFromList = <T>(items: T[]): T => {
  return items[Math.floor(Math.random() * items.length)]
}

export const getHOPRNodeAddressFromContent = (content: string): string => {
  log('- getHOPRNodeAddressFromContent | Starting to retrieve HOPR Node from Content')
  const maybeNode = getB58String(content)
  log(`- getHOPRNodeAddressFromContent | Retrieved maybeNode with content ${maybeNode}`)
  return maybeNode
}

export const generateRandomSentence = (): string => {
  const adjective = getRandomItemFromList(words.adjectives)
  const color = getRandomItemFromList(words.colors)
  const animal = getRandomItemFromList(words.animals)

  return `${adjective} ${color} ${animal}`
}
