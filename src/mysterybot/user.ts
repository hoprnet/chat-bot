import { Crime, Killer, Weapon } from './crime'

export class UserState {
    hasAccused: boolean
    isWinner: boolean
    guessCnt: number
    investigationCnt: number
    excludeInvestigationKiller: Killer[]
    excludeInvestigationWeapon: Weapon[] 

    constructor(crime: Crime) {
        this.hasAccused = false
        this.isWinner = false
        this.guessCnt = 0
        this.investigationCnt = 0
        this.excludeInvestigationKiller = [crime.killer]
        this.excludeInvestigationWeapon = [crime.weapon]
    }
}