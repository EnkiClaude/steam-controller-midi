// Protocol for the 2026 Steam Controller ("Triton"), transcribed from SDL's
// src/joystick/hidapi/SDL_hidapi_steam_triton.c and steam/controller_structs.h.
//
// All offsets are relative to the report payload, i.e. *without* the leading
// report-id byte. That is how WebHID hands reports to us (SDL's buffers
// include the id, so its offsets are these plus one).

import { BUTTONS, type ControllerState } from './inputs'

export const VALVE_VID = 0x28de
export const PID_WIRED = 0x1302
export const PID_BLE = 0x1303
export const PID_PUCK = 0x1304
export const PID_PUCK_2 = 0x1305
export const TRITON_PIDS = [PID_WIRED, PID_BLE, PID_PUCK, PID_PUCK_2]

export const REPORT_STATE = 0x42
export const REPORT_BATTERY = 0x43
export const REPORT_STATE_BLE = 0x45
export const REPORT_WIRELESS_X = 0x46
export const REPORT_STATE_TS = 0x47
export const REPORT_WIRELESS = 0x79

/** Minimum payload length of a state report (packed struct, 45 bytes). */
export const STATE_REPORT_BYTES = 45

interface Layout {
  buttons: number
  triggerL: number
  triggerR: number
  lsx: number
  lsy: number
  rsx: number
  rsy: number
  lpx: number
  lpy: number
  lpp: number
  rpx: number
  rpy: number
  rpp: number
  imuTs: number
  /** IMU timestamp width in bytes and its unit in microseconds */
  imuTsBytes: 2 | 4
  imuTsUs: number
  accel: number
  gyro: number
}

// TritonMTUNoQuat_t (reports 0x42 and 0x45)
const LAYOUT_STD: Layout = {
  buttons: 1,
  triggerL: 5,
  triggerR: 7,
  lsx: 9,
  lsy: 11,
  rsx: 13,
  rsy: 15,
  lpx: 17,
  lpy: 19,
  lpp: 21,
  rpx: 23,
  rpy: 25,
  rpp: 27,
  imuTs: 29,
  imuTsBytes: 4,
  imuTsUs: 1,
  accel: 33,
  gyro: 39,
}

// TritonMTUNoQuat32TS_t (report 0x47): a uint16 trackpad timestamp is inserted
// before the pads and the IMU timestamp shrinks to uint16 in 32 µs units.
const LAYOUT_TS: Layout = {
  ...LAYOUT_STD,
  lpx: 19,
  lpy: 21,
  lpp: 23,
  rpx: 25,
  rpy: 27,
  rpp: 29,
  imuTs: 31,
  imuTsBytes: 2,
  imuTsUs: 32,
}

/** Per-connection state the parser keeps between reports (motion integration). */
export interface TritonContext {
  lastImuTs: number | null
  /** integrated yaw in degrees */
  yaw: number
  /** low-passed accelerometer, in g */
  ax: number
  ay: number
  az: number
  accelPrimed: boolean
  /** tilt offsets (normalised units) captured by recenter() */
  pitchZero: number
  rollZero: number
  rawPitch: number
  rawRoll: number
}

export function createContext(): TritonContext {
  return {
    lastImuTs: null,
    yaw: 0,
    ax: 0,
    ay: 0,
    az: 1,
    accelPrimed: false,
    pitchZero: 0,
    rollZero: 0,
    rawPitch: 0,
    rawRoll: 0,
  }
}

/** Make the current orientation the centre for tilt and yaw. */
export function recenter(ctx: TritonContext): void {
  ctx.pitchZero = ctx.rawPitch
  ctx.rollZero = ctx.rawRoll
  ctx.yaw = 0
}

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v)

const GYRO_FULL_SCALE_DPS = 2000
/** gyro speed that maps to full deflection of the gyro_* axes */
const GYRO_RATE_RANGE_DPS = 360
/** rotation that maps to full deflection of the yaw axis */
const YAW_RANGE_DEG = 90
const GYRO_DEADBAND_DPS = 1.5
const ACCEL_FULL_SCALE_G = 2
const ACCEL_SMOOTH = 0.15

export type ParsedReport =
  | { type: 'state' }
  | { type: 'battery'; level: number; charging: boolean }
  | { type: 'wireless'; connected: boolean }
  | { type: 'unknown' }

/**
 * Parse one input report into `state` (mutated in place). Never throws:
 * short or unrecognised reports come back as `unknown`.
 */
export function parseReport(
  reportId: number,
  data: DataView,
  state: ControllerState,
  ctx: TritonContext,
): ParsedReport {
  switch (reportId) {
    case REPORT_STATE:
    case REPORT_STATE_BLE:
      if (data.byteLength < STATE_REPORT_BYTES) return { type: 'unknown' }
      parseState(data, LAYOUT_STD, state, ctx)
      return { type: 'state' }
    case REPORT_STATE_TS:
      if (data.byteLength < STATE_REPORT_BYTES) return { type: 'unknown' }
      parseState(data, LAYOUT_TS, state, ctx)
      return { type: 'state' }
    case REPORT_BATTERY: {
      if (data.byteLength < 2) return { type: 'unknown' }
      const charge = data.getUint8(0)
      // EChargeState: 2 = charging, 4 = charging done
      return { type: 'battery', level: data.getUint8(1), charging: charge === 2 || charge === 4 }
    }
    case REPORT_WIRELESS:
    case REPORT_WIRELESS_X: {
      if (data.byteLength < 1) return { type: 'unknown' }
      const s = data.getUint8(0)
      if (s === 2) return { type: 'wireless', connected: true }
      if (s === 1) return { type: 'wireless', connected: false }
      return { type: 'unknown' }
    }
    default:
      return { type: 'unknown' }
  }
}

function parseState(d: DataView, l: Layout, state: ControllerState, ctx: TritonContext): void {
  const buttons = d.getUint32(l.buttons, true)
  for (const def of BUTTONS) {
    state.buttons[def.id] = (buttons & def.mask) !== 0
  }

  const ax = state.axes
  ax.lt = clamp(d.getInt16(l.triggerL, true) / 32767, 0, 1)
  ax.rt = clamp(d.getInt16(l.triggerR, true) / 32767, 0, 1)

  const stick = (off: number) => clamp(d.getInt16(off, true) / 32767, -1, 1)
  ax.lstick_x = stick(l.lsx)
  ax.lstick_y = stick(l.lsy)
  ax.rstick_x = stick(l.rsx)
  ax.rstick_y = stick(l.rsy)

  // Pad coordinates only update while a finger is down; they hold otherwise.
  if (state.buttons.lpad_touch) {
    ax.lpad_x = stick(l.lpx)
    ax.lpad_y = stick(l.lpy)
  }
  if (state.buttons.rpad_touch) {
    ax.rpad_x = stick(l.rpx)
    ax.rpad_y = stick(l.rpy)
  }
  ax.lpad_pressure = clamp(d.getUint16(l.lpp, true) / 32768, 0, 1)
  ax.rpad_pressure = clamp(d.getUint16(l.rpp, true) / 32768, 0, 1)

  // --- motion ---
  const ts = l.imuTsBytes === 4 ? d.getUint32(l.imuTs, true) : d.getUint16(l.imuTs, true)
  const wrap = l.imuTsBytes === 4 ? 0x100000000 : 0x10000
  let dt = 0
  if (ctx.lastImuTs !== null) {
    const delta = (ts - ctx.lastImuTs + wrap) % wrap
    dt = (delta * l.imuTsUs) / 1e6
    // A stalled IMU (sensors off) repeats its timestamp; a long gap means we
    // missed reports. Either way don't integrate over it.
    if (dt > 0.25) dt = 0
  }
  ctx.lastImuTs = ts

  const gScale = GYRO_FULL_SCALE_DPS / 32768
  const gx = d.getInt16(l.gyro, true) * gScale
  const gy = d.getInt16(l.gyro + 2, true) * gScale
  const gz = d.getInt16(l.gyro + 4, true) * gScale
  ax.gyro_x = clamp(gx / GYRO_RATE_RANGE_DPS, -1, 1)
  ax.gyro_y = clamp(gy / GYRO_RATE_RANGE_DPS, -1, 1)
  ax.gyro_z = clamp(gz / GYRO_RATE_RANGE_DPS, -1, 1)

  // Ignore sensor noise while the controller is still, so yaw doesn't creep.
  if (dt > 0 && Math.abs(gz) > GYRO_DEADBAND_DPS) {
    ctx.yaw = clamp(ctx.yaw + gz * dt, -YAW_RANGE_DEG, YAW_RANGE_DEG)
  }
  // Raw yaw is positive anticlockwise; flip so turning right is positive like the sticks.
  ax.turn = -ctx.yaw / YAW_RANGE_DEG

  const aScale = ACCEL_FULL_SCALE_G / 32768
  const rax = d.getInt16(l.accel, true) * aScale
  const ray = d.getInt16(l.accel + 2, true) * aScale
  const raz = d.getInt16(l.accel + 4, true) * aScale
  // All-zero accel means the IMU isn't reporting (yet); keep the last tilt.
  if (rax !== 0 || ray !== 0 || raz !== 0) {
    if (!ctx.accelPrimed) {
      ctx.ax = rax
      ctx.ay = ray
      ctx.az = raz
      ctx.accelPrimed = true
    } else {
      ctx.ax += (rax - ctx.ax) * ACCEL_SMOOTH
      ctx.ay += (ray - ctx.ay) * ACCEL_SMOOTH
      ctx.az += (raz - ctx.az) * ACCEL_SMOOTH
    }
    // Device axes: X right, Y away from the player, Z up out of the face.
    // Signed so tilting forward / right is positive, matching stick up / right.
    ctx.rawPitch = -Math.atan2(ctx.ay, ctx.az) / (Math.PI / 2)
    ctx.rawRoll = -Math.atan2(ctx.ax, ctx.az) / (Math.PI / 2)
  }
  ax.tilt_pitch = clamp(ctx.rawPitch - ctx.pitchZero, -1, 1)
  ax.tilt_roll = clamp(ctx.rawRoll - ctx.rollZero, -1, 1)
}

// --- feature report: keep the controller out of "lizard mode" ---

export const FEATURE_REPORT_ID = 1
const ID_SET_SETTINGS_VALUES = 0x87
const SETTING_LIZARD_MODE = 9
const SETTING_IMU_MODE = 48
const LIZARD_MODE_OFF = 0
const IMU_SEND_RAW_ACCEL = 0x0008
const IMU_SEND_RAW_GYRO = 0x0010

/** How often the settings must be re-sent before the controller's watchdog reverts them. */
export const MAINTENANCE_INTERVAL_MS = 2000

/**
 * Payload (without the report id) of the feature report that turns off the
 * built-in mouse/keyboard emulation and turns the IMU on. The controller
 * reverts on its own after a few seconds, so this is sent periodically.
 */
export function buildSettingsReport(enableImu = true): Uint8Array<ArrayBuffer> {
  const buf = new Uint8Array(63)
  const settings: [number, number][] = [[SETTING_LIZARD_MODE, LIZARD_MODE_OFF]]
  if (enableImu) settings.push([SETTING_IMU_MODE, IMU_SEND_RAW_ACCEL | IMU_SEND_RAW_GYRO])
  buf[0] = ID_SET_SETTINGS_VALUES
  buf[1] = settings.length * 3
  settings.forEach(([num, value], i) => {
    buf[2 + i * 3] = num
    buf[3 + i * 3] = value & 0xff
    buf[4 + i * 3] = (value >> 8) & 0xff
  })
  return buf
}
