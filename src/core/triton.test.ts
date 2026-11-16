// Independent check of the Triton parser against SDL's driver
// (SDL_hidapi_steam_triton.c + steam/controller_structs.h + controller_constants.h).
//
// Reports are built by walking the packed C struct definitions below, which
// are transcribed from controller_structs.h, NOT from the offset tables in
// triton.ts. All structs are #pragma pack(1), little-endian. WebHID strips the
// report id, so the payload starts at the first struct member.

import { describe, expect, it } from 'vitest'
import { AXES, BUTTONS, emptyState, type ControllerState } from './inputs'
import {
  buildSettingsReport,
  createContext,
  FEATURE_REPORT_ID,
  parseReport,
  recenter,
  type TritonContext,
} from './triton'

// ---------------------------------------------------------------------------
// struct packing helper
// ---------------------------------------------------------------------------

type CType = 'u8' | 'u16' | 'i16' | 'u32'
type Field = readonly [name: string, type: CType]
const SIZE: Record<CType, number> = { u8: 1, u16: 2, i16: 2, u32: 4 }

// typedef struct { uint32_t timestamp; short sAccelX/Y/Z; short sGyroX/Y/Z; } TritonMTUIMUNoQuat_t;
const IMU_NOQUAT: Field[] = [
  ['imu.timestamp', 'u32'],
  ['sAccelX', 'i16'],
  ['sAccelY', 'i16'],
  ['sAccelZ', 'i16'],
  ['sGyroX', 'i16'],
  ['sGyroY', 'i16'],
  ['sGyroZ', 'i16'],
]

// typedef struct { uint16_t timestamp; ...same... } TritonMTUIMUNoQuat32usTS_t;
const IMU_NOQUAT_32US: Field[] = [['imu.timestamp', 'u16'], ...IMU_NOQUAT.slice(1)]

const HEAD: Field[] = [
  ['seq_num', 'u8'],
  ['buttons', 'u32'],
  ['sTriggerLeft', 'i16'],
  ['sTriggerRight', 'i16'],
  ['sLeftStickX', 'i16'],
  ['sLeftStickY', 'i16'],
  ['sRightStickX', 'i16'],
  ['sRightStickY', 'i16'],
]
const PADS: Field[] = [
  ['sLeftPadX', 'i16'],
  ['sLeftPadY', 'i16'],
  ['unPressureLeft', 'u16'],
  ['sRightPadX', 'i16'],
  ['sRightPadY', 'i16'],
  ['unPressureRight', 'u16'],
]

// TritonMTUNoQuat_t (0x42, 0x45)
const MTU_NOQUAT: Field[] = [...HEAD, ...PADS, ...IMU_NOQUAT]
// TritonMTUNoQuat32TS_t (0x47)
const MTU_NOQUAT_32TS: Field[] = [...HEAD, ['unTrackpadTimestamp', 'u16'], ...PADS, ...IMU_NOQUAT_32US]

// TritonBatteryStatus_t (0x43)
const BATTERY: Field[] = [
  ['ucChargeState', 'u8'],
  ['ucBatteryLevel', 'u8'],
  ['sBatteryVoltage', 'u16'],
  ['sSystemVoltage', 'u16'],
  ['sInputVoltage', 'u16'],
  ['sCurrent', 'u16'],
  ['sInputCurrent', 'u16'],
  ['sTemperature', 'u16'],
]

type Values = Record<string, number>

function pack(struct: Field[], values: Values, totalBytes?: number): DataView {
  const size = struct.reduce((n, [, t]) => n + SIZE[t], 0)
  for (const k of Object.keys(values)) {
    if (!struct.some(([name]) => name === k)) throw new Error(`no field ${k} in struct`)
  }
  const dv = new DataView(new ArrayBuffer(totalBytes ?? size))
  let off = 0
  for (const [name, type] of struct) {
    const v = values[name] ?? 0
    if (off + SIZE[type] <= dv.byteLength) {
      if (type === 'u8') dv.setUint8(off, v)
      else if (type === 'u16') dv.setUint16(off, v, true)
      else if (type === 'i16') dv.setInt16(off, v, true)
      else dv.setUint32(off, v, true)
    }
    off += SIZE[type]
  }
  return dv
}

const std = (v: Values = {}, bytes?: number) => pack(MTU_NOQUAT, v, bytes)
const ts = (v: Values = {}, bytes?: number) => pack(MTU_NOQUAT_32TS, v, bytes)

function fresh(): { state: ControllerState; ctx: TritonContext } {
  return { state: emptyState(), ctx: createContext() }
}

// TritonButtons enum, SDL_hidapi_steam_triton.c
const TRITON = {
  TRITON_LBUTTON_A: 0x00000001,
  TRITON_LBUTTON_B: 0x00000002,
  TRITON_LBUTTON_X: 0x00000004,
  TRITON_LBUTTON_Y: 0x00000008,
  TRITON_HBUTTON_QAM: 0x00000010,
  TRITON_LBUTTON_R3: 0x00000020,
  TRITON_LBUTTON_VIEW: 0x00000040,
  TRITON_HBUTTON_R4: 0x00000080,
  TRITON_LBUTTON_R5: 0x00000100,
  TRITON_LBUTTON_R: 0x00000200,
  TRITON_LBUTTON_DPAD_DOWN: 0x00000400,
  TRITON_LBUTTON_DPAD_RIGHT: 0x00000800,
  TRITON_LBUTTON_DPAD_LEFT: 0x00001000,
  TRITON_LBUTTON_DPAD_UP: 0x00002000,
  TRITON_LBUTTON_MENU: 0x00004000,
  TRITON_LBUTTON_L3: 0x00008000,
  TRITON_LBUTTON_STEAM: 0x00010000,
  TRITON_HBUTTON_L4: 0x00020000,
  TRITON_LBUTTON_L5: 0x00040000,
  TRITON_LBUTTON_L: 0x00080000,
  TRITON_RIGHT_JOYSTICK_TOUCH: 0x00100000,
  TRITON_RIGHT_TOUCHPAD_TOUCH: 0x00200000,
  TRITON_RIGHT_TOUCHPAD_CLICK: 0x00400000,
  TRITON_RIGHT_TRIGGER_CLICK: 0x00800000,
  TRITON_LEFT_JOYSTICK_TOUCH: 0x01000000,
  TRITON_LEFT_TOUCHPAD_TOUCH: 0x02000000,
  TRITON_LEFT_TOUCHPAD_CLICK: 0x04000000,
  TRITON_LEFT_TRIGGER_CLICK: 0x08000000,
  TRITON_RIGHT_GRIP_TOUCH: 0x10000000,
  TRITON_LEFT_GRIP_TOUCH: 0x20000000,
} as const

// which catalog id each SDL enum member must drive
const EXPECTED_BUTTON: Record<keyof typeof TRITON, string> = {
  TRITON_LBUTTON_A: 'a',
  TRITON_LBUTTON_B: 'b',
  TRITON_LBUTTON_X: 'x',
  TRITON_LBUTTON_Y: 'y',
  TRITON_HBUTTON_QAM: 'qam',
  TRITON_LBUTTON_R3: 'r3',
  TRITON_LBUTTON_VIEW: 'view',
  TRITON_HBUTTON_R4: 'r4',
  TRITON_LBUTTON_R5: 'r5',
  TRITON_LBUTTON_R: 'rb',
  TRITON_LBUTTON_DPAD_DOWN: 'dpad_down',
  TRITON_LBUTTON_DPAD_RIGHT: 'dpad_right',
  TRITON_LBUTTON_DPAD_LEFT: 'dpad_left',
  TRITON_LBUTTON_DPAD_UP: 'dpad_up',
  TRITON_LBUTTON_MENU: 'menu',
  TRITON_LBUTTON_L3: 'l3',
  TRITON_LBUTTON_STEAM: 'steam',
  TRITON_HBUTTON_L4: 'l4',
  TRITON_LBUTTON_L5: 'l5',
  TRITON_LBUTTON_L: 'lb',
  TRITON_RIGHT_JOYSTICK_TOUCH: 'rstick_touch',
  TRITON_RIGHT_TOUCHPAD_TOUCH: 'rpad_touch',
  TRITON_RIGHT_TOUCHPAD_CLICK: 'rpad_click',
  TRITON_RIGHT_TRIGGER_CLICK: 'rt_click',
  TRITON_LEFT_JOYSTICK_TOUCH: 'lstick_touch',
  TRITON_LEFT_TOUCHPAD_TOUCH: 'lpad_touch',
  TRITON_LEFT_TOUCHPAD_CLICK: 'lpad_click',
  TRITON_LEFT_TRIGGER_CLICK: 'lt_click',
  TRITON_RIGHT_GRIP_TOUCH: 'rgrip_touch',
  TRITON_LEFT_GRIP_TOUCH: 'lgrip_touch',
}

const LPAD_TOUCH = TRITON.TRITON_LEFT_TOUCHPAD_TOUCH
const RPAD_TOUCH = TRITON.TRITON_RIGHT_TOUCHPAD_TOUCH

// ---------------------------------------------------------------------------

describe('struct helper sanity (sizes from controller_structs.h)', () => {
  it('TritonMTUNoQuat_t is 45 bytes and TritonMTUNoQuat32TS_t is 45 bytes', () => {
    expect(std().byteLength).toBe(45)
    expect(ts().byteLength).toBe(45)
  })
  it('TritonBatteryStatus_t is 14 bytes', () => {
    expect(pack(BATTERY, {}).byteLength).toBe(14)
  })
})

describe('buttons', () => {
  it('catalog has exactly the 30 buttons of the TritonButtons enum', () => {
    expect(BUTTONS).toHaveLength(30)
    expect(Object.keys(TRITON)).toHaveLength(30)
    expect(new Set(BUTTONS.map((b) => b.id)).size).toBe(30)
    expect(new Set(BUTTONS.map((b) => b.id))).toEqual(new Set(Object.values(EXPECTED_BUTTON)))
  })

  it('no two catalog buttons share a mask, and every mask is a single bit', () => {
    expect(new Set(BUTTONS.map((b) => b.mask)).size).toBe(BUTTONS.length)
    for (const b of BUTTONS) {
      expect(b.mask > 0 && (b.mask & (b.mask - 1)) === 0, b.id).toBe(true)
    }
  })

  for (const [name, mask] of Object.entries(TRITON) as [keyof typeof TRITON, number][]) {
    const id = EXPECTED_BUTTON[name]
    for (const reportId of [0x42, 0x45, 0x47]) {
      it(`${name} (0x${mask.toString(16).padStart(8, '0')}) sets only "${id}" in report 0x${reportId.toString(16)}`, () => {
        const { state, ctx } = fresh()
        const dv = reportId === 0x47 ? ts({ buttons: mask }) : std({ buttons: mask })
        expect(parseReport(reportId, dv, state, ctx)).toEqual({ type: 'state' })
        const down = Object.entries(state.buttons)
          .filter(([, v]) => v)
          .map(([k]) => k)
        expect(down).toEqual([id])
      })
    }
  }

  it('releases buttons when the bit clears, and handles all bits at once', () => {
    const { state, ctx } = fresh()
    parseReport(0x42, std({ buttons: 0x3fffffff }), state, ctx)
    expect(Object.values(state.buttons).every((v) => v)).toBe(true)
    parseReport(0x42, std({ buttons: 0 }), state, ctx)
    expect(Object.values(state.buttons).some((v) => v)).toBe(false)
  })

  it('ignores the two unassigned top bits', () => {
    const { state, ctx } = fresh()
    parseReport(0x42, std({ buttons: 0xc0000000 }), state, ctx)
    expect(Object.values(state.buttons).some((v) => v)).toBe(false)
  })
})

describe('triggers and sticks', () => {
  it('triggers: 0 → 0, 32767 → 1, left/right not swapped', () => {
    const { state, ctx } = fresh()
    parseReport(0x42, std({ sTriggerLeft: 32767, sTriggerRight: 0 }), state, ctx)
    expect(state.axes.lt).toBe(1)
    expect(state.axes.rt).toBe(0)
    parseReport(0x42, std({ sTriggerLeft: 0, sTriggerRight: 16384 }), state, ctx)
    expect(state.axes.lt).toBe(0)
    expect(state.axes.rt).toBeCloseTo(0.5, 3)
  })

  it('triggers never go negative', () => {
    const { state, ctx } = fresh()
    parseReport(0x42, std({ sTriggerLeft: -200, sTriggerRight: -32768 }), state, ctx)
    expect(state.axes.lt).toBe(0)
    expect(state.axes.rt).toBe(0)
  })

  it('each stick field lands on its own axis', () => {
    const fields = [
      ['sLeftStickX', 'lstick_x'],
      ['sLeftStickY', 'lstick_y'],
      ['sRightStickX', 'rstick_x'],
      ['sRightStickY', 'rstick_y'],
    ] as const
    for (const [field, axis] of fields) {
      for (const id of [0x42, 0x47]) {
        const { state, ctx } = fresh()
        parseReport(id, (id === 0x47 ? ts : std)({ [field]: 32767 }), state, ctx)
        for (const [, other] of fields) {
          expect(state.axes[other], `${field} → ${other} (0x${id.toString(16)})`).toBe(other === axis ? 1 : 0)
        }
      }
    }
  })

  it('stick X: raw positive is right/positive', () => {
    const { state, ctx } = fresh()
    parseReport(0x42, std({ sLeftStickX: 16384, sRightStickX: -16384 }), state, ctx)
    expect(state.axes.lstick_x).toBeCloseTo(0.5, 3)
    expect(state.axes.rstick_x).toBeCloseTo(-0.5, 3)
  })

  it('stick Y: raw positive is up/positive (SDL negates it to get down-positive)', () => {
    const { state, ctx } = fresh()
    parseReport(0x42, std({ sLeftStickY: 32767, sRightStickY: -32767 }), state, ctx)
    expect(state.axes.lstick_y).toBe(1)
    expect(state.axes.rstick_y).toBe(-1)
  })

  it('clamps -32768 to exactly -1', () => {
    const { state, ctx } = fresh()
    parseReport(0x42, std({ sLeftStickX: -32768, sLeftStickY: -32768 }), state, ctx)
    expect(state.axes.lstick_x).toBe(-1)
    expect(state.axes.lstick_y).toBe(-1)
  })

  it('centre is exactly 0', () => {
    const { state, ctx } = fresh()
    parseReport(0x42, std({ sLeftStickX: 32767 }), state, ctx)
    parseReport(0x42, std({}), state, ctx)
    expect(state.axes.lstick_x).toBe(0)
  })
})

describe('trackpads', () => {
  for (const id of [0x42, 0x45, 0x47]) {
    const mk = id === 0x47 ? ts : std
    const hex = `0x${id.toString(16)}`

    it(`${hex}: pad X/Y read from the right fields while touched`, () => {
      const { state, ctx } = fresh()
      parseReport(
        id,
        mk({
          buttons: LPAD_TOUCH | RPAD_TOUCH,
          sLeftPadX: 8192,
          sLeftPadY: -16384,
          sRightPadX: -24576,
          sRightPadY: 32767,
          // decoys: if the layout is shifted these leak into pad axes
          ...(id === 0x47 ? { unTrackpadTimestamp: 0x7abc } : {}),
          sRightStickY: 1111,
          unPressureLeft: 2222,
          unPressureRight: 3333,
        }),
        state,
        ctx,
      )
      expect(state.axes.lpad_x).toBeCloseTo(0.25, 3)
      expect(state.axes.lpad_y).toBeCloseTo(-0.5, 3)
      expect(state.axes.rpad_x).toBeCloseTo(-0.75, 3)
      expect(state.axes.rpad_y).toBe(1)
      expect(state.axes.lpad_pressure).toBeCloseTo(2222 / 32768, 6)
      expect(state.axes.rpad_pressure).toBeCloseTo(3333 / 32768, 6)
    })

    it(`${hex}: pad X/Y do not update without touch`, () => {
      const { state, ctx } = fresh()
      parseReport(id, mk({ sLeftPadX: 20000, sLeftPadY: 20000, sRightPadX: 20000, sRightPadY: 20000 }), state, ctx)
      expect(state.axes.lpad_x).toBe(0)
      expect(state.axes.lpad_y).toBe(0)
      expect(state.axes.rpad_x).toBe(0)
      expect(state.axes.rpad_y).toBe(0)
    })

    it(`${hex}: pad X/Y hold their last value after release`, () => {
      const { state, ctx } = fresh()
      parseReport(id, mk({ buttons: LPAD_TOUCH | RPAD_TOUCH, sLeftPadX: 16384, sLeftPadY: 8192, sRightPadX: -16384, sRightPadY: -8192 }), state, ctx)
      // on release the firmware typically reports 0,0
      parseReport(id, mk({}), state, ctx)
      expect(state.buttons.lpad_touch).toBe(false)
      expect(state.axes.lpad_x).toBeCloseTo(0.5, 3)
      expect(state.axes.lpad_y).toBeCloseTo(0.25, 3)
      expect(state.axes.rpad_x).toBeCloseTo(-0.5, 3)
      expect(state.axes.rpad_y).toBeCloseTo(-0.25, 3)
    })

    it(`${hex}: the two pads are gated independently`, () => {
      const { state, ctx } = fresh()
      parseReport(id, mk({ buttons: RPAD_TOUCH, sLeftPadX: 16384, sRightPadX: 16384 }), state, ctx)
      expect(state.axes.lpad_x).toBe(0)
      expect(state.axes.rpad_x).toBeCloseTo(0.5, 3)
      parseReport(id, mk({ buttons: LPAD_TOUCH, sLeftPadX: -16384, sRightPadX: -16384 }), state, ctx)
      expect(state.axes.lpad_x).toBeCloseTo(-0.5, 3)
      expect(state.axes.rpad_x).toBeCloseTo(0.5, 3)
    })
  }

  it('pad Y: raw positive is up/positive (SDL negates it for its top-left origin)', () => {
    const { state, ctx } = fresh()
    parseReport(0x42, std({ buttons: LPAD_TOUCH, sLeftPadY: 32767 }), state, ctx)
    expect(state.axes.lpad_y).toBe(1)
  })

  it('pressure scales by 32768 like SDL and saturates at 1', () => {
    const { state, ctx } = fresh()
    parseReport(0x42, std({ unPressureLeft: 16384, unPressureRight: 32768 }), state, ctx)
    expect(state.axes.lpad_pressure).toBe(0.5)
    expect(state.axes.rpad_pressure).toBe(1)
    parseReport(0x42, std({ unPressureLeft: 0, unPressureRight: 65535 }), state, ctx)
    expect(state.axes.lpad_pressure).toBe(0)
    expect(state.axes.rpad_pressure).toBe(1)
  })
})

// SDL: (raw / 32768) * 2000 deg/s
const GYRO_DPS_PER_LSB = 2000 / 32768
// SDL: (raw / 32768) * 2 g
const ONE_G = 16384

describe('gyro', () => {
  for (const id of [0x42, 0x45, 0x47]) {
    const mk = id === 0x47 ? ts : std
    it(`0x${id.toString(16)}: gyro X/Y/Z read from the right fields, ±2000 dps full scale`, () => {
      const { state, ctx } = fresh()
      // 360 dps is the documented full deflection of the gyro_* axes
      parseReport(id, mk({ sGyroX: 1000, sGyroY: -2000, sGyroZ: 3000, 'imu.timestamp': 0xffff, unPressureRight: 0xffff }), state, ctx)
      expect(state.axes.gyro_x).toBeCloseTo((1000 * GYRO_DPS_PER_LSB) / 360, 9)
      expect(state.axes.gyro_y).toBeCloseTo((-2000 * GYRO_DPS_PER_LSB) / 360, 9)
      expect(state.axes.gyro_z).toBeCloseTo((3000 * GYRO_DPS_PER_LSB) / 360, 9)
    })
  }

  it('gyro axes clamp to ±1', () => {
    const { state, ctx } = fresh()
    parseReport(0x42, std({ sGyroX: 32767, sGyroY: -32768 }), state, ctx)
    expect(state.axes.gyro_x).toBe(1)
    expect(state.axes.gyro_y).toBe(-1)
  })
})

describe('yaw integration', () => {
  // 1638 LSB ≈ 99.98 deg/s
  const GZ = 1638
  const dps = GZ * GYRO_DPS_PER_LSB

  it('0x42: first report does not integrate (no previous timestamp)', () => {
    const { state, ctx } = fresh()
    parseReport(0x42, std({ sGyroZ: GZ, 'imu.timestamp': 123456 }), state, ctx)
    expect(state.axes.turn).toBe(0)
  })

  it('0x42: timestamp is uint32 microseconds', () => {
    const { state, ctx } = fresh()
    parseReport(0x42, std({ sGyroZ: GZ, 'imu.timestamp': 1_000_000 }), state, ctx)
    parseReport(0x42, std({ sGyroZ: GZ, 'imu.timestamp': 1_004_000 }), state, ctx)
    expect(ctx.yaw).toBeCloseTo(dps * 0.004, 9)
    expect(state.axes.turn).toBeCloseTo((dps * 0.004) / 90, 9)
    parseReport(0x42, std({ sGyroZ: -GZ, 'imu.timestamp': 1_012_000 }), state, ctx)
    expect(ctx.yaw).toBeCloseTo(dps * 0.004 - dps * 0.008, 9)
  })

  it('0x45 uses the same layout and units as 0x42', () => {
    const { state, ctx } = fresh()
    parseReport(0x45, std({ sGyroZ: GZ, 'imu.timestamp': 70_000 }), state, ctx)
    parseReport(0x45, std({ sGyroZ: GZ, 'imu.timestamp': 80_000 }), state, ctx)
    expect(ctx.yaw).toBeCloseTo(dps * 0.01, 9)
  })

  it('0x42: uint32 wraparound', () => {
    const { state, ctx } = fresh()
    parseReport(0x42, std({ sGyroZ: GZ, 'imu.timestamp': 0xfffff830 }), state, ctx) // 2000 µs before wrap
    parseReport(0x42, std({ sGyroZ: GZ, 'imu.timestamp': 2000 }), state, ctx)
    expect(ctx.yaw).toBeCloseTo(dps * 0.004, 9)
  })

  it('0x42: timestamps above 2^31 are read unsigned', () => {
    const { state, ctx } = fresh()
    parseReport(0x42, std({ sGyroZ: GZ, 'imu.timestamp': 0x7ffffc00 }), state, ctx)
    parseReport(0x42, std({ sGyroZ: GZ, 'imu.timestamp': 0x80000400 }), state, ctx)
    expect(ctx.yaw).toBeCloseTo(dps * 0.002048, 9)
  })

  it('0x47: timestamp is uint16 in units of 32 microseconds', () => {
    const { state, ctx } = fresh()
    parseReport(0x47, ts({ sGyroZ: GZ, 'imu.timestamp': 1000 }), state, ctx)
    parseReport(0x47, ts({ sGyroZ: GZ, 'imu.timestamp': 1126 }), state, ctx) // 126 ticks = 4032 µs
    expect(ctx.yaw).toBeCloseTo(dps * 0.004032, 9)
  })

  it('0x47: does not read the timestamp from the 0x42 offset', () => {
    const { state, ctx } = fresh()
    // In the 0x47 layout the bytes where 0x42 keeps its timestamp hold the
    // right pad pressure; vary it wildly and keep the real timestamp steady.
    parseReport(0x47, ts({ sGyroZ: GZ, 'imu.timestamp': 500, unPressureRight: 0 }), state, ctx)
    parseReport(0x47, ts({ sGyroZ: GZ, 'imu.timestamp': 625, unPressureRight: 30000 }), state, ctx)
    expect(ctx.yaw).toBeCloseTo(dps * 0.004, 9)
  })

  it('0x47: uint16 wraparound', () => {
    const { state, ctx } = fresh()
    parseReport(0x47, ts({ sGyroZ: GZ, 'imu.timestamp': 65500 }), state, ctx)
    parseReport(0x47, ts({ sGyroZ: GZ, 'imu.timestamp': 64 }), state, ctx) // 100 ticks = 3200 µs
    expect(ctx.yaw).toBeCloseTo(dps * 0.0032, 9)
  })

  it('a repeated timestamp (IMU stalled) is not integrated', () => {
    const { state, ctx } = fresh()
    parseReport(0x42, std({ sGyroZ: GZ, 'imu.timestamp': 5000 }), state, ctx)
    parseReport(0x42, std({ sGyroZ: GZ, 'imu.timestamp': 5000 }), state, ctx)
    parseReport(0x42, std({ sGyroZ: GZ, 'imu.timestamp': 5000 }), state, ctx)
    expect(ctx.yaw).toBe(0)
  })

  it('0x42: a long gap is not integrated, and integration resumes afterwards', () => {
    const { state, ctx } = fresh()
    parseReport(0x42, std({ sGyroZ: GZ, 'imu.timestamp': 1000 }), state, ctx)
    parseReport(0x42, std({ sGyroZ: GZ, 'imu.timestamp': 1_001_000 }), state, ctx) // 1 s gap
    expect(ctx.yaw).toBe(0)
    parseReport(0x42, std({ sGyroZ: GZ, 'imu.timestamp': 1_005_000 }), state, ctx)
    expect(ctx.yaw).toBeCloseTo(dps * 0.004, 9)
  })

  it('0x47: a long gap is not integrated', () => {
    const { state, ctx } = fresh()
    parseReport(0x47, ts({ sGyroZ: GZ, 'imu.timestamp': 0 }), state, ctx)
    parseReport(0x47, ts({ sGyroZ: GZ, 'imu.timestamp': 31250 }), state, ctx) // 1 s
    expect(ctx.yaw).toBe(0)
  })

  it('a backwards timestamp (reordered report) does not produce a huge step', () => {
    const { state, ctx } = fresh()
    parseReport(0x42, std({ sGyroZ: GZ, 'imu.timestamp': 10_000 }), state, ctx)
    parseReport(0x42, std({ sGyroZ: GZ, 'imu.timestamp': 6_000 }), state, ctx)
    expect(ctx.yaw).toBe(0)
  })

  it('only gyro Z drives yaw', () => {
    const { state, ctx } = fresh()
    parseReport(0x42, std({ sGyroX: 9000, sGyroY: 9000, 'imu.timestamp': 0 }), state, ctx)
    parseReport(0x42, std({ sGyroX: 9000, sGyroY: 9000, 'imu.timestamp': 4000 }), state, ctx)
    expect(state.axes.turn).toBe(0)
  })

  it('turn saturates at ±1 (90°) and recenter() zeroes it', () => {
    const { state, ctx } = fresh()
    let t = 0
    parseReport(0x42, std({ sGyroZ: 32767, 'imu.timestamp': t }), state, ctx)
    for (let i = 0; i < 100; i++) {
      t += 4000
      parseReport(0x42, std({ sGyroZ: 32767, 'imu.timestamp': t }), state, ctx)
    }
    expect(state.axes.turn).toBe(1)
    recenter(ctx)
    t += 4000
    parseReport(0x42, std({ sGyroZ: 0, 'imu.timestamp': t }), state, ctx)
    expect(state.axes.turn).toBe(0)
  })
})

describe('tilt from the accelerometer', () => {
  // SDL maps raw accel (X, Y, Z) to its (X, Z, -Y): a controller lying flat
  // reads +1 g on raw Z.
  const flat = { sAccelZ: ONE_G }

  for (const id of [0x42, 0x47]) {
    const mk = id === 0x47 ? ts : std
    it(`0x${id.toString(16)}: flat on a table is pitch 0, roll 0`, () => {
      const { state, ctx } = fresh()
      parseReport(id, mk({ ...flat, sGyroX: 500, 'imu.timestamp': 0x1234 }), state, ctx)
      expect(state.axes.tilt_pitch).toBe(0)
      expect(state.axes.tilt_roll).toBe(0)
    })

    it(`0x${id.toString(16)}: accel X drives roll only, accel Y drives pitch only`, () => {
      let { state, ctx } = fresh()
      const c45 = Math.round(ONE_G * Math.SQRT1_2)
      parseReport(id, mk({ sAccelX: c45, sAccelZ: c45 }), state, ctx)
      expect(Math.abs(state.axes.tilt_roll)).toBeCloseTo(0.5, 3) // 45° of ±90°
      expect(state.axes.tilt_pitch).toBe(0)
      ;({ state, ctx } = fresh())
      parseReport(id, mk({ sAccelY: c45, sAccelZ: c45 }), state, ctx)
      expect(Math.abs(state.axes.tilt_pitch)).toBeCloseTo(0.5, 3)
      expect(state.axes.tilt_roll).toBe(0)
    })
  }

  it('opposite tilts give opposite signs', () => {
    const c45 = Math.round(ONE_G * Math.SQRT1_2)
    const a = fresh()
    parseReport(0x42, std({ sAccelX: c45, sAccelY: c45, sAccelZ: c45 }), a.state, a.ctx)
    const b = fresh()
    parseReport(0x42, std({ sAccelX: -c45, sAccelY: -c45, sAccelZ: c45 }), b.state, b.ctx)
    expect(a.state.axes.tilt_roll).toBeCloseTo(-b.state.axes.tilt_roll, 9)
    expect(a.state.axes.tilt_pitch).toBeCloseTo(-b.state.axes.tilt_pitch, 9)
    expect(a.state.axes.tilt_roll).not.toBe(0)
  })

  it('on edge (90°) is full deflection', () => {
    const { state, ctx } = fresh()
    parseReport(0x42, std({ sAccelX: ONE_G, sAccelZ: 0 }), state, ctx)
    expect(Math.abs(state.axes.tilt_roll)).toBe(1)
  })

  it('converges on a new pose (low-pass filter) and stays in range', () => {
    const { state, ctx } = fresh()
    const c45 = Math.round(ONE_G * Math.SQRT1_2)
    parseReport(0x42, std(flat), state, ctx)
    let prev = 0
    for (let i = 0; i < 100; i++) {
      parseReport(0x42, std({ sAccelX: c45, sAccelZ: c45 }), state, ctx)
      const mag = Math.abs(state.axes.tilt_roll)
      expect(mag).toBeGreaterThanOrEqual(prev)
      expect(mag).toBeLessThanOrEqual(0.5001)
      prev = mag
    }
    expect(prev).toBeCloseTo(0.5, 3)
  })

  it('recenter() makes the current pose zero, and tilt is then relative to it', () => {
    const { state, ctx } = fresh()
    const c30 = Math.round(ONE_G * Math.cos(Math.PI / 6))
    const s30 = Math.round(ONE_G * Math.sin(Math.PI / 6))
    const pose = { sAccelX: s30, sAccelY: s30, sAccelZ: c30 }
    parseReport(0x42, std(pose), state, ctx)
    expect(state.axes.tilt_roll).not.toBe(0)
    expect(state.axes.tilt_pitch).not.toBe(0)
    const before = { roll: state.axes.tilt_roll, pitch: state.axes.tilt_pitch }

    recenter(ctx)
    parseReport(0x42, std(pose), state, ctx)
    expect(state.axes.tilt_roll).toBeCloseTo(0, 9)
    expect(state.axes.tilt_pitch).toBeCloseTo(0, 9)

    // going back to flat now reads as the opposite tilt
    for (let i = 0; i < 200; i++) parseReport(0x42, std(flat), state, ctx)
    expect(state.axes.tilt_roll).toBeCloseTo(-before.roll, 6)
    expect(state.axes.tilt_pitch).toBeCloseTo(-before.pitch, 6)
  })

  it('all-zero accel (IMU not reporting) keeps the last tilt', () => {
    const { state, ctx } = fresh()
    const c45 = Math.round(ONE_G * Math.SQRT1_2)
    parseReport(0x42, std({ sAccelX: c45, sAccelZ: c45 }), state, ctx)
    const roll = state.axes.tilt_roll
    parseReport(0x42, std({}), state, ctx)
    expect(state.axes.tilt_roll).toBe(roll)
    expect(Number.isFinite(state.axes.tilt_pitch)).toBe(true)
  })

  it('a report with the IMU off leaves every motion axis at 0 and finite', () => {
    const { state, ctx } = fresh()
    parseReport(0x42, std({ buttons: 1 }), state, ctx)
    parseReport(0x42, std({ buttons: 0 }), state, ctx)
    for (const a of ['tilt_pitch', 'tilt_roll', 'turn', 'gyro_x', 'gyro_y', 'gyro_z']) {
      expect(state.axes[a], a).toBe(0)
    }
  })

  // SDL's axis mapping (gyro/accel X→X, Z→Y(up), -Y→Z(toward player)) means
  // raw X points right, raw Y away from the player, raw Z up out of the face.
  // An accelerometer at rest reads +1 g along "up", so with the right side
  // tilted DOWN raw accel X is NEGATIVE, and a clockwise (rightward) turn is
  // NEGATIVE gyro Z. The code therefore reports tilt-right, turn-right and
  // tilt-forward as negative, the opposite of stick-right/stick-up = positive.
  // Whether that is intended is a design call; left alone and reported.
  it.todo('sign convention: tilting/turning right (and tilting forward) should probably be positive like the sticks')
})

describe('every axis stays normalised', () => {
  it('extreme raw values keep all axes finite and inside their range', () => {
    for (const id of [0x42, 0x47]) {
      for (const fill of [0x00, 0xff, 0x7f, 0x80]) {
        const { state, ctx } = fresh()
        const dv = new DataView(new Uint8Array(64).fill(fill).buffer)
        parseReport(id, dv, state, ctx)
        parseReport(id, dv, state, ctx)
        for (const def of AXES) {
          const v = state.axes[def.id]
          expect(Number.isFinite(v), def.id).toBe(true)
          expect(v, def.id).toBeLessThanOrEqual(1)
          expect(v, def.id).toBeGreaterThanOrEqual(def.polarity === 'unipolar' ? 0 : -1)
        }
      }
    }
  })

  it('accepts 64-byte padded reports (trailing bytes ignored)', () => {
    const { state, ctx } = fresh()
    const dv = std({ buttons: 1, sLeftStickX: 32767 }, 64)
    expect(parseReport(0x42, dv, state, ctx)).toEqual({ type: 'state' })
    expect(state.buttons.a).toBe(true)
    expect(state.axes.lstick_x).toBe(1)
  })

  it('honours the DataView byteOffset (view into a larger buffer)', () => {
    const { state, ctx } = fresh()
    const src = new Uint8Array(std({ buttons: 2, sTriggerRight: 32767 }).buffer)
    const big = new Uint8Array(80)
    big.set(src, 7)
    expect(parseReport(0x42, new DataView(big.buffer, 7, 45), state, ctx)).toEqual({ type: 'state' })
    expect(state.buttons.b).toBe(true)
    expect(state.axes.rt).toBe(1)
  })
})

describe('battery report 0x43', () => {
  // enum EChargeState { Reset, Discharging, Charging, SrcValidate, ChargingDone }
  const battery = (state: number, level: number) => pack(BATTERY, { ucChargeState: state, ucBatteryLevel: level, sBatteryVoltage: 4012 })

  it('discharging', () => {
    const { state, ctx } = fresh()
    expect(parseReport(0x43, battery(1, 73), state, ctx)).toEqual({ type: 'battery', level: 73, charging: false })
  })
  it('charging', () => {
    const { state, ctx } = fresh()
    expect(parseReport(0x43, battery(2, 40), state, ctx)).toEqual({ type: 'battery', level: 40, charging: true })
  })
  it('charging done still counts as on the charger', () => {
    const { state, ctx } = fresh()
    expect(parseReport(0x43, battery(4, 100), state, ctx)).toEqual({ type: 'battery', level: 100, charging: true })
  })
  it('reset / source-validate are not charging', () => {
    const { state, ctx } = fresh()
    expect(parseReport(0x43, battery(0, 5), state, ctx)).toEqual({ type: 'battery', level: 5, charging: false })
    expect(parseReport(0x43, battery(3, 5), state, ctx)).toEqual({ type: 'battery', level: 5, charging: false })
  })
  it('does not touch controller state', () => {
    const { state, ctx } = fresh()
    const before = JSON.stringify([state, ctx])
    parseReport(0x43, pack(BATTERY, { ucChargeState: 0xff, ucBatteryLevel: 0xff, sBatteryVoltage: 0xffff }), state, ctx)
    expect(JSON.stringify([state, ctx])).toBe(before)
  })
})

describe('wireless status 0x46 / 0x79', () => {
  // enum ETritonWirelessState { Disconnect = 1, Connect = 2 }
  const w = (s: number) => new DataView(new Uint8Array([s]).buffer)
  for (const id of [0x46, 0x79]) {
    it(`0x${id.toString(16)}: 2 = connected, 1 = disconnected, anything else ignored`, () => {
      const { state, ctx } = fresh()
      expect(parseReport(id, w(2), state, ctx)).toEqual({ type: 'wireless', connected: true })
      expect(parseReport(id, w(1), state, ctx)).toEqual({ type: 'wireless', connected: false })
      expect(parseReport(id, w(0), state, ctx)).toEqual({ type: 'unknown' })
      expect(parseReport(id, w(3), state, ctx)).toEqual({ type: 'unknown' })
    })
  }
})

describe('short and unknown reports', () => {
  const full = new Uint8Array(64).fill(0xff)
  const cases: [string, number, number][] = [
    ['0x42 one byte short', 0x42, 44],
    ['0x45 one byte short', 0x45, 44],
    ['0x47 one byte short', 0x47, 44],
    ['0x42 empty', 0x42, 0],
    ['0x47 empty', 0x47, 0],
    ['0x42 header only', 0x42, 5],
    ['0x43 empty', 0x43, 0],
    ['0x43 one byte', 0x43, 1],
    ['0x46 empty', 0x46, 0],
    ['0x79 empty', 0x79, 0],
    ['unknown id 0x00', 0x00, 64],
    ['unknown id 0x01', 0x01, 64],
    ['unknown id 0x44', 0x44, 64],
    ['unknown id 0x09 (old Steam Controller state)', 0x09, 64],
    ['unknown id 0xff', 0xff, 64],
  ]
  for (const [name, id, len] of cases) {
    it(`${name} → unknown, no throw, no mutation`, () => {
      const { state, ctx } = fresh()
      // put the parser in a non-default state first
      parseReport(0x42, std({ buttons: 1, sLeftStickX: 1234, sGyroZ: 100, sAccelZ: ONE_G, 'imu.timestamp': 99 }), state, ctx)
      const before = JSON.stringify([state, ctx])
      let result: unknown
      expect(() => {
        result = parseReport(id, new DataView(full.buffer, 0, len), state, ctx)
      }).not.toThrow()
      expect(result).toEqual({ type: 'unknown' })
      expect(JSON.stringify([state, ctx])).toBe(before)
    })
  }
})

describe('buildSettingsReport (vs MaintainTritonState)', () => {
  // Counted by hand in controller_constants.h / controller_structs.h:
  const HID_FEATURE_REPORT_BYTES = 64
  const ID_SET_SETTINGS_VALUES = 0x87 // 0x80 + 7th entry of FeatureReportMessageIDs
  const SETTING_LIZARD_MODE = 9 // 10th entry of ControllerSettings (0-based 9)
  const SETTING_IMU_MODE = 48 // "// 40" block: RADIAL 40 … ENABLE_FAST_SCAN 47, IMU_MODE 48
  const LIZARD_MODE_OFF = 0
  const SETTING_GYRO_MODE_SEND_RAW_ACCEL = 0x0008
  const SETTING_GYRO_MODE_SEND_RAW_GYRO = 0x0010
  const SIZEOF_CONTROLLER_SETTING = 3 // packed { uint8 settingNum; uint16 settingValue }

  /** What SDL's buffer holds after buffer[0] (the report id). */
  function sdlBuffer(reportSensors: boolean): Uint8Array {
    const buffer = new Uint8Array(HID_FEATURE_REPORT_BYTES)
    buffer[0] = 1
    const msg = new DataView(buffer.buffer, 1)
    msg.setUint8(0, ID_SET_SETTINGS_VALUES) // header.type
    let length = 1 * SIZEOF_CONTROLLER_SETTING
    msg.setUint8(2, SETTING_LIZARD_MODE)
    msg.setUint16(3, LIZARD_MODE_OFF, true)
    if (reportSensors) {
      length += 1 * SIZEOF_CONTROLLER_SETTING
      msg.setUint8(5, SETTING_IMU_MODE)
      msg.setUint16(6, SETTING_GYRO_MODE_SEND_RAW_ACCEL | SETTING_GYRO_MODE_SEND_RAW_GYRO, true)
    }
    msg.setUint8(1, length) // header.length
    return buffer
  }

  it('report id is 1 (buffer[0] in SDL)', () => {
    expect(FEATURE_REPORT_ID).toBe(1)
    expect(sdlBuffer(true)[0]).toBe(FEATURE_REPORT_ID)
  })

  it('with IMU: byte-for-byte equal to SDL (63 bytes after the id)', () => {
    const got = buildSettingsReport(true)
    expect(got).toBeInstanceOf(Uint8Array)
    expect(Array.from(got)).toEqual(Array.from(sdlBuffer(true).subarray(1)))
    expect(got.length).toBe(63)
  })

  it('defaults to IMU on', () => {
    expect(Array.from(buildSettingsReport())).toEqual(Array.from(sdlBuffer(true).subarray(1)))
  })

  it('without IMU: byte-for-byte equal to SDL with report_sensors false', () => {
    expect(Array.from(buildSettingsReport(false))).toEqual(Array.from(sdlBuffer(false).subarray(1)))
  })

  it('spelled out', () => {
    const expected = new Array(63).fill(0)
    expected.splice(0, 8, 0x87, 6, 9, 0x00, 0x00, 48, 0x18, 0x00)
    expect(Array.from(buildSettingsReport(true))).toEqual(expected)
    const noImu = new Array(63).fill(0)
    noImu.splice(0, 5, 0x87, 3, 9, 0x00, 0x00)
    expect(Array.from(buildSettingsReport(false))).toEqual(noImu)
  })
})
