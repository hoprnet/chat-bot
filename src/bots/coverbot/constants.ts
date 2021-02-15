import { COVERBOT_VERIFICATION_CYCLE_IN_MS } from "../../utils/env"

export const AMOUNT_OF_IDENTIFIABLE_LETTERS = 8
export const RELAY_VERIFICATION_CYCLE_IN_MS = COVERBOT_VERIFICATION_CYCLE_IN_MS * 5
export const RELAY_HOPR_REWARD = 1000000000000000 // 0.001 HOPR
export const HOPR_ENVIRONMENTS = [
  "basodino",
  "basodino-develop",
  "basodino-v2",
  "basodino-v2-develop"
]
