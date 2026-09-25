import {
  TRAFFIC_ACTIONS as CORE_ACTIONS,
  TRAFFIC_CLASSES as CORE_CLASSES,
  DEVICES as CORE_DEVICES,
  REPORT_DIMENSIONS as CORE_DIMENSIONS,
  NON_HUMAN_CLASSES as CORE_NON_HUMAN,
  OUTCOMES as CORE_OUTCOMES,
} from '@clickmonk/core'
import { SOURCE_IDS } from '@clickmonk/ipdata'
import { describe, expect, it } from 'vitest'
import {
  DEVICES,
  IP_SOURCES,
  NON_HUMAN_CLASSES,
  OUTCOMES,
  REPORT_DIMENSIONS,
  TRAFFIC_ACTIONS,
  TRAFFIC_CLASSES,
} from './vocabulary'

// Each list against the service's, in order: an order that differs is a select
// box whose options move, and a value missing is one the interface cannot ask for.
describe('the lists the interface offers', () => {
  it.each([
    ['traffic classes', TRAFFIC_CLASSES, CORE_CLASSES],
    ['non-human classes', NON_HUMAN_CLASSES, CORE_NON_HUMAN],
    ['actions', TRAFFIC_ACTIONS, CORE_ACTIONS],
    ['outcomes', OUTCOMES, CORE_OUTCOMES],
    ['dimensions', REPORT_DIMENSIONS, CORE_DIMENSIONS],
    ['devices', DEVICES, CORE_DEVICES],
    ['ip data sources', IP_SOURCES, SOURCE_IDS],
  ])('restates the service’s %s exactly', (_label, ours, theirs) => {
    expect([...ours]).toEqual([...theirs])
  })
})
