import { describe, expect, it } from 'vitest'
import {
  MAX_TXT_RECORDS,
  MAX_TXT_VALUE_LENGTH,
  isVerificationToken,
  newVerificationToken,
  txtRecordsCarryToken,
  verificationRecordName,
  verificationRecordValue,
} from './domain-verification.js'

describe('the verification record', () => {
  it('names a label under the host, and says what to publish', () => {
    expect(verificationRecordName('go.example.test')).toBe('_clickmonk.go.example.test')
    expect(verificationRecordValue('0'.repeat(32))).toBe(`clickmonk-verify=${'0'.repeat(32)}`)
  })

  it('mints 32 lower-case hex characters, and a different one each time', () => {
    const a = newVerificationToken()
    expect(a).toMatch(/^[0-9a-f]{32}$/)
    expect(isVerificationToken(a)).toBe(true)
    expect(a).not.toBe(newVerificationToken())
  })

  it('refuses anything but 32 lower-case hex characters', () => {
    expect(isVerificationToken('A'.repeat(32))).toBe(false)
    expect(isVerificationToken('0'.repeat(31))).toBe(false)
    expect(isVerificationToken('0'.repeat(33))).toBe(false)
    expect(isVerificationToken('')).toBe(false)
  })
})

describe('reading the TXT records at that name', () => {
  const token = 'a'.repeat(32)
  const want = verificationRecordValue(token)

  it('accepts the record among others, joined from its chunks, whitespace ignored', () => {
    expect(txtRecordsCarryToken([['v=spf1 -all'], [want]], token)).toBe(true)
    expect(txtRecordsCarryToken([[want.slice(0, 10), want.slice(10)]], token)).toBe(true)
    expect(txtRecordsCarryToken([[` ${want} `]], token)).toBe(true)
  })

  it('refuses a record that merely contains the token, or carries another one', () => {
    expect(txtRecordsCarryToken([[`x ${want}`]], token)).toBe(false)
    expect(txtRecordsCarryToken([[`${want}x`]], token)).toBe(false)
    expect(txtRecordsCarryToken([[verificationRecordValue('b'.repeat(32))]], token)).toBe(false)
    expect(txtRecordsCarryToken([], token)).toBe(false)
  })

  it('refuses a token that is not one, whatever DNS says', () => {
    expect(txtRecordsCarryToken([['clickmonk-verify=nope']], 'nope')).toBe(false)
  })

  it('stops after the record bound, so a huge answer cannot be walked forever', () => {
    const padding = Array.from({ length: MAX_TXT_RECORDS }, () => ['x'])
    expect(txtRecordsCarryToken([...padding, [want]], token)).toBe(false)
    expect(txtRecordsCarryToken([...padding.slice(1), [want]], token)).toBe(true)
  })

  it('skips a record longer than the value bound without joining it', () => {
    const huge = ['y'.repeat(MAX_TXT_VALUE_LENGTH + 1)]
    expect(txtRecordsCarryToken([huge, [want]], token)).toBe(true)
    expect(txtRecordsCarryToken([huge], token)).toBe(false)

    // A record whose raw chunk length exceeds the bound, but whose trimmed,
    // joined value would equal `want` anyway: padded with enough leading
    // whitespace that the total is over the bound before any chunk is
    // joined or trimmed. If the bound were measured after joining and
    // trimming instead of before, this record would pass. Only measuring it
    // first — on the raw chunks — refuses it.
    const padded = [' '.repeat(MAX_TXT_VALUE_LENGTH + 1 - want.length), want]
    expect(txtRecordsCarryToken([padded], token)).toBe(false)
  })
})
