import assert from 'node:assert/strict'
import test from 'node:test'
import { WindowCoordinator } from './window-coordinator.js'

test('merges overlapping viewer windows but preserves distant viewers', () => {
  const windows = new WindowCoordinator(0)
  windows.set('viewer-a', 300, 0, 999, 200, 100)
  windows.set('viewer-b', 450, 0, 999, 200, 100)
  windows.set('viewer-c', 900, 0, 999, 50, 50)

  assert.deepEqual(windows.ranges(100, 10), [
    { from: 2, to: 6 },
    { from: 8, to: 9 },
  ])
  assert.deepEqual(windows.criticalPieces(100, 10), [3, 4, 9])
})

test('removes a viewer window independently', () => {
  const windows = new WindowCoordinator(0)
  windows.set('one', 100, 0, 999, 100, 0)
  windows.set('two', 700, 0, 999, 100, 0)
  windows.delete('one')
  assert.deepEqual(windows.ranges(100, 10), [{ from: 7, to: 8 }])
})
