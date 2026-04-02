import { describe, it, expect, beforeEach } from 'vitest'

import logicalClock from '../utils/crdt/Clock.js'
import { LWWMap } from '../utils/crdt/LWWMap.js'
import { CRDTManager } from '../utils/crdt/CRDTManager.js'

describe('CRDT / LWW 基础正确性', () => {
  beforeEach(() => {
    logicalClock.reset(0)
  })

  it('LWWMap.set：较新的时间戳才允许覆盖', () => {
    const lww = new LWWMap('obj-1', { x: 1 })

    expect(lww.set('x', 2, 1)).toBe(true)
    expect(lww.data.x).toBe(2)
    expect(lww.timestamps.x).toBe(1)

    expect(lww.set('x', 3, 1)).toBe(false)
    expect(lww.data.x).toBe(2)
    expect(lww.timestamps.x).toBe(1)

    expect(lww.set('x', 4, 0)).toBe(false)
    expect(lww.data.x).toBe(2)
    expect(lww.timestamps.x).toBe(1)
  })

  it('LWWMap.merge：乱序到达的旧更新不会回滚新值', () => {
    const lww = new LWWMap('obj-1', { x: 1 })
    lww.set('x', 2, 5)

    const changes = lww.merge({
      id: 'obj-1',
      data: { x: 9 },
      timestamps: { x: 3 }
    })

    expect(changes).toEqual({})
    expect(lww.data.x).toBe(2)
    expect(lww.timestamps.x).toBe(5)
  })

  it('CRDTManager.mergeRemoteUpdate：新对象应信任远端时间戳并推进本地时钟', () => {
    const mgr = new CRDTManager()

    const result = mgr.mergeRemoteUpdate({
      id: 'obj-1',
      data: { left: 10, top: 20 },
      timestamps: { left: 7, top: 6 }
    })

    expect(result.isNew).toBe(true)
    expect(result.changes).toEqual({ left: 10, top: 20 })

    expect(mgr.getData('obj-1')).toMatchObject({ left: 10, top: 20 })
    expect(mgr.getObjectState('obj-1').timestamps).toMatchObject({ left: 7, top: 6 })

    expect(logicalClock.get()).toBe(8)
  })

  it('CRDTManager：Tombstone 删除后 getData 返回 null，旧更新不会“复活”对象', () => {
    const mgr = new CRDTManager()

    mgr.localUpdateWithTimestamp('obj-1', { left: 10 }, 10)
    mgr.deleteWithTimestamp('obj-1', 20)

    expect(mgr.getData('obj-1')).toBe(null)

    const merged = mgr.mergeRemoteUpdate({
      id: 'obj-1',
      data: { left: 999 },
      timestamps: { left: 19 }
    })

    expect(merged.isNew).toBe(false)
    expect(merged.changes).toEqual({})
    expect(mgr.getData('obj-1')).toBe(null)
  })

  it('CRDTManager.localUpdateWithTimestamp：新对象应把传入时间戳写入每个字段', () => {
    const mgr = new CRDTManager()

    const state = mgr.localUpdateWithTimestamp('obj-1', { left: 10, top: 20 }, 50)

    expect(state.timestamps).toMatchObject({ left: 50, top: 50 })
    expect(mgr.getObjectState('obj-1').timestamps).toMatchObject({ left: 50, top: 50 })
    expect(mgr.getData('obj-1')).toMatchObject({ left: 10, top: 20 })

    expect(logicalClock.get()).toBe(51)
  })
})

