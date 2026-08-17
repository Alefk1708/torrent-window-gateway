import assert from 'node:assert/strict'
import test from 'node:test'
import { HttpError } from '../errors.js'
import { parseByteRange } from './range.js'

test('returns the whole file when Range is absent', () => {
  assert.deepEqual(parseByteRange(undefined, 100), { start: 0, end: 99, partial: false })
})

test('parses bounded, open and suffix ranges', () => {
  assert.deepEqual(parseByteRange('bytes=10-19', 100), { start: 10, end: 19, partial: true })
  assert.deepEqual(parseByteRange('bytes=90-', 100), { start: 90, end: 99, partial: true })
  assert.deepEqual(parseByteRange('bytes=-10', 100), { start: 90, end: 99, partial: true })
})

test('clamps a range end and rejects multiple ranges', () => {
  assert.deepEqual(parseByteRange('bytes=95-200', 100), { start: 95, end: 99, partial: true })
  assert.throws(() => parseByteRange('bytes=0-1,4-5', 100), (error) => {
    return error instanceof HttpError && error.statusCode === 416
  })
})
