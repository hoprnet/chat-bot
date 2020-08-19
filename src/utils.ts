import * as grpc from 'grpc'
import { GetHoprAddressRequest } from '@hoprnet/hopr-protos/node/address_pb'
import { ListenClient } from '@hoprnet/hopr-protos/node/listen_grpc_pb'
import { AddressClient } from '@hoprnet/hopr-protos/node/address_grpc_pb'
import { SendRequest } from '@hoprnet/hopr-protos/node/send_pb'
import { SendClient } from '@hoprnet/hopr-protos/node/send_grpc_pb'
import type { ClientReadableStream } from 'grpc'
import { ListenRequest, ListenResponse } from '@hoprnet/hopr-protos/node/listen_pb'
import { Message, IMessage } from './message'
import { API_URL, DRY_RUN } from './env'
import * as words from './words'


export const SetupClient = <T extends typeof grpc.Client>(Client: T): InstanceType<T> => {
  return (new Client(API_URL, grpc.credentials.createInsecure()) as unknown) as InstanceType<T>
}

export const getRandomItemFromList = <T>(items: T[]): T => {
  return items[Math.floor(Math.random() * items.length)]
}

export const filterEnumValuesInSting = <T>(phrase: string, anEnum: T) => {
  let res = []
  Object.keys(anEnum).forEach((item) => {
      if(phrase.includes(anEnum[item])) res.push(item)
  })
  return res
}

export const fileterListInSting = <T>(phrase: string, list: string[]) => {
  let res = []
  list.forEach((item) => {
      if(phrase.includes(item)) res.push(item)
  })
  return res
}

export const getRandomItemFromEnum = <T>(anEnum: T): T[keyof T] => {
  const key = getRandomItemFromList(Object.keys(anEnum)) 
  return anEnum[key]
}

export const getRandomItemFromEnumOtherThan = <T>(anEnum: T, exclude: any[]): T[keyof T] => {
  const guess = getRandomItemFromList(Object.keys(anEnum))
  if (exclude.includes(anEnum[guess])) return getRandomItemFromEnumOtherThan(anEnum, exclude)
  return anEnum[guess]
}

export const generateRandomSentence = (): string => {
  const adjective = getRandomItemFromList(words.adjectives)
  const color = getRandomItemFromList(words.colors)
  const animal = getRandomItemFromList(words.animals)

  return `${adjective} ${color} ${animal}`
}

export const getMessageStream = (): Promise<{
  client: ListenClient
  stream: ClientReadableStream<ListenResponse>
}> => {
  let client: ListenClient

  return new Promise((resolve, reject) => {
    try {
      client = SetupClient(ListenClient)
      const stream = client.listen(new ListenRequest())

      resolve({
        client,
        stream,
      })
    } catch (err) {
      reject(err)
    }
  })
}

export const sendMessage = (recepientAddress: string, message: IMessage): Promise<void> => {
  let client: SendClient

  return new Promise((resolve, reject) => {
    if (DRY_RUN) {
      console.log(`-> ${recepientAddress}: ${message.text}`)
      resolve()
    } else {
      try {
        client = SetupClient(SendClient)

        const req = new SendRequest()
        req.setPeerId(recepientAddress)
        req.setPayload(Message.fromJson(message).toU8a())

        client.send(req, (err) => {
          if (err) return reject(err)

          console.log(`-> ${recepientAddress}: ${message.text}`)
          client.close()
          resolve()
        })
      } catch (err) {
        client.close()
        reject(err)
      }
    }
  })
}

export const getHoprAddress = (): Promise<string> => {
  let client: AddressClient

  return new Promise((resolve, reject) => {
    try {
      client = SetupClient(AddressClient)

      client.getHoprAddress(new GetHoprAddressRequest(), (err, res) => {
        if (err) return reject(err)

        client.close()
        resolve(res.getAddress())
      })
    } catch (err) {
      client.close()
      reject(err)
    }
  })
}

