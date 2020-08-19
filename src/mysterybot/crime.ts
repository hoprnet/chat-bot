export enum Killer {
  Plum = 'plum',
  Mustard = 'mustard',
  Green = 'green',
  White = 'white',
  Scarlett = 'scarlett',
  Peacock = 'peacock'
}

export enum Weapon {
  Candlestick = 'candlestick',
  Dagger = 'dagger',
  Lead_Pipe = 'lead pipe',
  Revolver = 'revolver',
  Rope = 'rope',
  Spanner = 'spanner'
}

export enum Room {
  Kitchen = 'kitchen',
  Conservatory = 'conservatory',
  Library = 'library',
  Dinning = 'dinning',
  Ballroom = 'ballroom',
  Hall = 'hall',
  Study = 'study',
  Lounge = 'lounge',
  Billiard = 'billiard'
}

export class Crime {
  killer: Killer
  weapon: Weapon
  room: Room

  constructor(killer: Killer, weapon: Weapon, room: Room) {
    this.killer = killer
    this.weapon = weapon
    this.room = room
  }

  statement(): string {
    return `${this.killer} killed at the ${this.room} using the ${this.weapon}!`
  }
}