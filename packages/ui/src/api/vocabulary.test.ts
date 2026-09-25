import {
  TRAFFIC_ACTIONS as CORE_ACTIONS,
  TRAFFIC_CLASSES as CORE_CLASSES,
  DEVICES as CORE_DEVICES,
  REPORT_DIMENSIONS as CORE_DIMENSIONS,
  MAX_ABUSER_THRESHOLD as CORE_MAX_ABUSER_THRESHOLD,
  MAX_RETENTION_DAYS as CORE_MAX_RETENTION_DAYS,
  MIN_ADMIN_PASSWORD_LENGTH as CORE_MIN_ADMIN_PASSWORD_LENGTH,
  MIN_LINK_PASSWORD_LENGTH as CORE_MIN_LINK_PASSWORD_LENGTH,
  NON_HUMAN_CLASSES as CORE_NON_HUMAN,
  OUTCOMES as CORE_OUTCOMES,
} from '@clickmonk/core'
import { SOURCE_IDS } from '@clickmonk/ipdata'
import { describe, expect, it } from 'vitest'
import {
  DEVICES,
  IP_SOURCES,
  MAX_ABUSER_THRESHOLD,
  MAX_RETENTION_DAYS,
  MIN_ADMIN_PASSWORD_LENGTH,
  MIN_LINK_PASSWORD_LENGTH,
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

// Each bound below is checked locally, before the service is asked, and is
// owned by `core`. A test that only compared the lists above would stay
// green the day one of these drifts and a form starts refusing a value the
// service would accept.
describe('the numeric bounds the interface checks locally', () => {
  it.each([
    [
      'an admin password’s minimum length',
      MIN_ADMIN_PASSWORD_LENGTH,
      CORE_MIN_ADMIN_PASSWORD_LENGTH,
    ],
    ['a link password’s minimum length', MIN_LINK_PASSWORD_LENGTH, CORE_MIN_LINK_PASSWORD_LENGTH],
    ['the abuser threshold’s ceiling', MAX_ABUSER_THRESHOLD, CORE_MAX_ABUSER_THRESHOLD],
    ['a retention period’s ceiling', MAX_RETENTION_DAYS, CORE_MAX_RETENTION_DAYS],
  ])('restates the service’s %s exactly', (_label, ours, theirs) => {
    expect(ours).toBe(theirs)
  })
})
