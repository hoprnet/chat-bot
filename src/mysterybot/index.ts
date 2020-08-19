import { 
  sendMessage, 
  getRandomItemFromList, 
  getRandomItemFromEnum, 
  filterEnumValuesInSting,
  getRandomItemFromEnumOtherThan
} from '../utils'
import { IMessage } from '../message'
import { ListenResponse } from '@hoprnet/hopr-protos/node/listen_pb'
import { Bot } from '../bot'
import { payDai } from '../linkdrop'
import { TweetMessage } from '../twitter'
import response from './response.json'
import { Crime, Killer, Weapon, Room } from './crime'
import { UserState } from './user'


export class Mysterybot implements Bot {
  botName: string
  address: string
  maxGuesses: number
  maxInvestigations: number
  truth: Crime
  users: Map<string, UserState>
  bountyMode: boolean
  totalBountyCount: number
  bountyAmount: number

  constructor(
    address: string, 
    bountyMode: boolean=false, 
    totalBountyCount: number=0,
    bountyAmount: number=0
  ) {
    this.address = address
    this.botName = '🕵️  Mysterybot'
    this.bountyMode = bountyMode
    this.totalBountyCount = totalBountyCount
    this.bountyAmount = bountyAmount
    this.truth = new Crime(
      getRandomItemFromEnum(Killer),
      getRandomItemFromEnum(Weapon),
      getRandomItemFromEnum(Room)
    )
    console.log(`${this.botName} has been added`)
    this.maxGuesses = 5
    this.maxInvestigations = 3
    this.users = new Map<string, UserState>()
    // Uncomment to log the result while debugging
    console.log('Crime:' + this.truth.statement())
  }

  async handleMessage(message: IMessage) {
    console.log(`${this.botName} <- ${message.from}: ${message.text}`)
    if (!this.users.has(message.from)) return this.handleNew(message)
    
    const user = this.users.get(message.from) 
    if (message.text.substring(0, 5) === 'Rules') this.handleRules(message)
    else if(message.text.substring(0, 7) == 'Winners') this.handleWinners(message)
    else if(message.text.substring(0, 5) == 'Guess') this.handleGuess(message)
    else if(message.text.substring(0, 6) == 'Accuse') {
      if (user.hasAccused) this.handleHasAccused(message)
      else this.handleAccuse(message)
    }
    else if(message.text.substring(0, 11) == 'Investigate') this.handleInvestigate(message)
    else if(message.text.substring(0, 4) == 'Help') this.handleHelp(message)
    else this.handleUnknown(message)
  }

  handleUnknown(message) {
    return sendMessage(message.from, {
        from: this.address,
        text: getRandomItemFromList(response['randomSentence']),
    })
  }

  async handleAccuse(message) {
    let text = ''
    if (this.bountyMode) {
      const tweet = new TweetMessage(message.text)
      await tweet.fetch()
      if (tweet.isValidHOPRTweet(message.from)) text = tweet.content
    } else {
      text = message.text.toLowerCase()
    }
    const guess = this.parseGuess(text)
    let user = this.users.get(message.from)
    if (guess.isGuess) {
      user.hasAccused = true
      if (guess.isKillerCorrect && guess.isWeaponCorrect && guess.isRoomCorrect) {
        user.isWinner = true
        this.handlePay(message)
      } else {
        sendMessage(message.from, {
            from: this.address,
            text: getRandomItemFromList(response['incorrectAccuse'])
        })
      }
    } else {
      sendMessage(message.from, {
        from: this.address,
        text: getRandomItemFromList(response['inclompleteAccuse'])
      })
    }
    this.users.set(message.from, user)
  }

  handleGuess(message) {
    const guess = this.parseGuess(message.text.toLowerCase())
    let reply: string
    let user = this.users.get(message.from)
    if (guess.isValid) {
      if (user.guessCnt >= this.maxGuesses)
        reply = getRandomItemFromList(response['outOfGuesses'])
      else {
        user.guessCnt += 1
        if(guess.isKillerCorrect && guess.isWeaponCorrect && guess.isRoomCorrect) {
          reply = getRandomItemFromList(response['correctComplete'])
        } 
        else if(!guess.isKillerCorrect && !guess.isWeaponCorrect && !guess.isRoomCorrect) 
          reply = getRandomItemFromList(response['wrongComplete'])
        else {
          if (guess.isKillerCorrect) reply = getRandomItemFromList(response['knowsKiller'])
          else reply = getRandomItemFromList(response['wrongKiller'])

          if (guess.isWeaponCorrect) reply = reply + '; ' + getRandomItemFromList(response['knowsWeapon'])
          else reply = reply + '; ' + getRandomItemFromList(response['wrongWeapon'])

          if (guess.isRoomCorrect) reply = reply + ' and' + getRandomItemFromList(response['knowsRoom'])
          else reply = reply + ' and' + getRandomItemFromList(response['wrongRoom'])
        }
      }
    } else {
      if (guess.missedKiller) reply = getRandomItemFromList(response['missedKiller'])
      else if (guess.missedWeapon) reply = getRandomItemFromList(response['missedWeapon'])
      else if (guess.missedRoom) reply = getRandomItemFromList(response['missedRoom'])
      else reply = getRandomItemFromList(response['falseGuess'])
    }
    sendMessage(message.from, {
        from: this.address,
        text: reply,
    })
    this.users.set(message.from, user)
  }

  handleInvestigate(message: IMessage) {
    let user = this.users.get(message.from)
    if (user.investigationCnt < this.maxInvestigations) {
      user.investigationCnt += 1
      const phrase = message.text.toLowerCase()
      const isRoomCorrect = phrase.includes(this.truth.room)
      let reply = isRoomCorrect ? response['successInvestigate'] : response['failInvestigate']
      const randomWeapon = getRandomItemFromEnumOtherThan(Weapon, user.excludeInvestigationWeapon)
      const randomKiller = getRandomItemFromEnumOtherThan(Killer, user.excludeInvestigationKiller)
      sendMessage(message.from, {
          from: this.address,
          text: reply + `. Eliminate ${randomKiller} and ${randomWeapon}`,
      })
    } else {
      sendMessage(message.from, {
          from: this.address,
          text: getRandomItemFromList(response['outOfInvestigataion']),
      })
    }
    this.users.set(message.from, user)
  }

  parseGuess(phrase: string) {
    const haskillers = filterEnumValuesInSting(phrase, Killer)
    const hasWeapons = filterEnumValuesInSting(phrase, Weapon)
    const hasRooms = filterEnumValuesInSting(phrase, Room)
    return {
      isGuess: haskillers.length > 0 || hasWeapons.length > 0 && hasRooms.length > 0,
      isValid: haskillers.length == 1 && hasWeapons.length == 1 && hasRooms.length == 1,
      missedKiller: haskillers.length == 0,
      missedRoom: hasRooms.length == 0,
      missedWeapon: hasWeapons.length == 0,
      isKillerCorrect: phrase.includes(this.truth.killer),
      isWeaponCorrect: phrase.includes(this.truth.weapon),
      isRoomCorrect: phrase.includes(this.truth.room),
    }
  }

  handleNew(message: IMessage) {
    const rules0 = response['rulesLines'].slice(0, 3).join('\n')
    const rules1 = response['rulesLines'].slice(3).join('\n')
    sendMessage(message.from, {
        from: this.address,
        text: ' Seems like you are the new detective! Let me introduce you to the crime scene\n' + rules0,
    })
    sendMessage(message.from, {
        from: this.address,
        text: rules1,
    })
    this.users.set(message.from, new UserState(this.truth))
  }

  handleHelp(message: IMessage) {
    const rules0 = response['rulesLines'].slice(0, 3).join('\n')
    const rules1 = response['rulesLines'].slice(3).join('\n')
    sendMessage(message.from, {
        from: this.address,
        text: rules0,
    })
    sendMessage(message.from, {
        from: this.address,
        text: rules1,
    })
  }

  handleHasAccused(message: IMessage) {
    let user = this.users.get(message.from)
    if (user.isWinner) {
      sendMessage(message.from, {
          from: this.address,
          text: getRandomItemFromList(response['hasWon']),
      })
    } else {
      sendMessage(message.from, {
          from: this.address,
          text: getRandomItemFromList(response['hasFailed']),
      })
    }
  }

  handleRules(message: IMessage) {
    let user = this.users.get(message.from)
    const guessLeft = this.maxGuesses - user.guessCnt
    const investigationLeft = this.maxInvestigations - user.investigationCnt
    const accusedCnt = user.hasAccused ? 0 : 1
    sendMessage(message.from, {
      from: this.address,
      text: `You have ${guessLeft} guesses, ${investigationLeft} investigations, ${accusedCnt} accussitions`,
    })  
  }

  handleWinners(message: IMessage) {
    let winnerList = []
    this.users.forEach((user, id) => {
      if(user.isWinner) winnerList.push(id)
    })
    sendMessage(message.from, {
      from: this.address,
      text: 'Winner list is as follows: ' + winnerList.join(', '),
    })
  }

  async handlePay(message) {
    let user = this.users.get(message.from)
    if (this.bountyMode && Object.keys(user.isWinner).length <= this.totalBountyCount) {
      const payUrl = await payDai(this.bountyAmount) 
      console.log(`Payment link generated: ${payUrl}`)
      sendMessage(message.from, {
        from: this.address,
        text: response['payment'] + payUrl
      })
    } else {
      sendMessage(message.from, {
        from: this.address,
        text: response['noPayment']
      })
    } 
  }
}
