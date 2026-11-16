// Catalog of every input on the 2026 Steam Controller ("Triton").
// Everything else in the app (parser, engine, UI) is keyed by these ids.

export type InputKind = 'button' | 'axis'

/** unipolar axes rest at 0 and go to 1; bipolar axes rest at 0 and span -1..1 */
export type AxisPolarity = 'unipolar' | 'bipolar'

export type InputGroup =
  | 'face'
  | 'dpad'
  | 'shoulder'
  | 'sticks'
  | 'trackpads'
  | 'grips'
  | 'system'
  | 'motion'

interface InputDefBase {
  id: string
  label: string
  short: string
  group: InputGroup
  /** true when only the raw HID connection reports it (not the Gamepad API fallback) */
  hidOnly?: boolean
}

export interface ButtonDef extends InputDefBase {
  kind: 'button'
  /** bit mask in the Triton report's 32-bit button field */
  mask: number
  /** capacitive touch rather than a physical press */
  touch?: boolean
}

export interface AxisDef extends InputDefBase {
  kind: 'axis'
  polarity: AxisPolarity
  /** axis is only meaningful while this button is down (trackpad position / pressure) */
  activeWhile?: string
}

export type InputDef = ButtonDef | AxisDef

const b = (
  id: string,
  label: string,
  short: string,
  group: InputGroup,
  mask: number,
  extra: Partial<ButtonDef> = {},
): ButtonDef => ({ kind: 'button', id, label, short, group, mask, ...extra })

const a = (
  id: string,
  label: string,
  short: string,
  group: InputGroup,
  polarity: AxisPolarity,
  extra: Partial<AxisDef> = {},
): AxisDef => ({ kind: 'axis', id, label, short, group, polarity, ...extra })

// Button masks come from SDL's SDL_hidapi_steam_triton.c (TritonButtons enum).
export const BUTTONS: ButtonDef[] = [
  b('a', 'A', 'A', 'face', 0x00000001),
  b('b', 'B', 'B', 'face', 0x00000002),
  b('x', 'X', 'X', 'face', 0x00000004),
  b('y', 'Y', 'Y', 'face', 0x00000008),

  b('dpad_up', 'D-pad Up', '↑', 'dpad', 0x00002000),
  b('dpad_down', 'D-pad Down', '↓', 'dpad', 0x00000400),
  b('dpad_left', 'D-pad Left', '←', 'dpad', 0x00001000),
  b('dpad_right', 'D-pad Right', '→', 'dpad', 0x00000800),

  b('lb', 'Left Bumper', 'L1', 'shoulder', 0x00080000),
  b('rb', 'Right Bumper', 'R1', 'shoulder', 0x00000200),
  b('lt_click', 'Left Trigger Full Pull', 'L2 click', 'shoulder', 0x08000000, { hidOnly: true }),
  b('rt_click', 'Right Trigger Full Pull', 'R2 click', 'shoulder', 0x00800000, { hidOnly: true }),

  b('l3', 'Left Stick Click', 'L3', 'sticks', 0x00008000),
  b('r3', 'Right Stick Click', 'R3', 'sticks', 0x00000020),
  b('lstick_touch', 'Left Stick Touch', 'LS touch', 'sticks', 0x01000000, { hidOnly: true, touch: true }),
  b('rstick_touch', 'Right Stick Touch', 'RS touch', 'sticks', 0x00100000, { hidOnly: true, touch: true }),

  b('lpad_touch', 'Left Trackpad Touch', 'LP touch', 'trackpads', 0x02000000, { hidOnly: true, touch: true }),
  b('lpad_click', 'Left Trackpad Click', 'LP click', 'trackpads', 0x04000000, { hidOnly: true }),
  b('rpad_touch', 'Right Trackpad Touch', 'RP touch', 'trackpads', 0x00200000, { hidOnly: true, touch: true }),
  b('rpad_click', 'Right Trackpad Click', 'RP click', 'trackpads', 0x00400000, { hidOnly: true }),

  b('l4', 'Left Grip Upper (L4)', 'L4', 'grips', 0x00020000, { hidOnly: true }),
  b('l5', 'Left Grip Lower (L5)', 'L5', 'grips', 0x00040000, { hidOnly: true }),
  b('r4', 'Right Grip Upper (R4)', 'R4', 'grips', 0x00000080, { hidOnly: true }),
  b('r5', 'Right Grip Lower (R5)', 'R5', 'grips', 0x00000100, { hidOnly: true }),
  b('lgrip_touch', 'Left Grip Sense', 'LG touch', 'grips', 0x20000000, { hidOnly: true, touch: true }),
  b('rgrip_touch', 'Right Grip Sense', 'RG touch', 'grips', 0x10000000, { hidOnly: true, touch: true }),

  b('view', 'View', 'View', 'system', 0x00000040),
  b('menu', 'Menu', 'Menu', 'system', 0x00004000),
  b('steam', 'Steam', 'Steam', 'system', 0x00010000),
  b('qam', 'Quick Access (…)', 'QAM', 'system', 0x00000010, { hidOnly: true }),
]

export const AXES: AxisDef[] = [
  a('lt', 'Left Trigger', 'L2', 'shoulder', 'unipolar'),
  a('rt', 'Right Trigger', 'R2', 'shoulder', 'unipolar'),

  a('lstick_x', 'Left Stick X', 'LS X', 'sticks', 'bipolar'),
  a('lstick_y', 'Left Stick Y', 'LS Y', 'sticks', 'bipolar'),
  a('rstick_x', 'Right Stick X', 'RS X', 'sticks', 'bipolar'),
  a('rstick_y', 'Right Stick Y', 'RS Y', 'sticks', 'bipolar'),

  a('lpad_x', 'Left Trackpad X', 'LP X', 'trackpads', 'bipolar', { hidOnly: true, activeWhile: 'lpad_touch' }),
  a('lpad_y', 'Left Trackpad Y', 'LP Y', 'trackpads', 'bipolar', { hidOnly: true, activeWhile: 'lpad_touch' }),
  a('lpad_pressure', 'Left Trackpad Pressure', 'LP press', 'trackpads', 'unipolar', { hidOnly: true }),
  a('rpad_x', 'Right Trackpad X', 'RP X', 'trackpads', 'bipolar', { hidOnly: true, activeWhile: 'rpad_touch' }),
  a('rpad_y', 'Right Trackpad Y', 'RP Y', 'trackpads', 'bipolar', { hidOnly: true, activeWhile: 'rpad_touch' }),
  a('rpad_pressure', 'Right Trackpad Pressure', 'RP press', 'trackpads', 'unipolar', { hidOnly: true }),

  a('tilt_pitch', 'Tilt Forward / Back', 'Pitch', 'motion', 'bipolar', { hidOnly: true }),
  a('tilt_roll', 'Tilt Left / Right', 'Roll', 'motion', 'bipolar', { hidOnly: true }),
  a('turn', 'Turn Left / Right (yaw)', 'Yaw', 'motion', 'bipolar', { hidOnly: true }),
  a('gyro_x', 'Gyro Pitch Speed', 'Gyro X', 'motion', 'bipolar', { hidOnly: true }),
  a('gyro_y', 'Gyro Roll Speed', 'Gyro Y', 'motion', 'bipolar', { hidOnly: true }),
  a('gyro_z', 'Gyro Yaw Speed', 'Gyro Z', 'motion', 'bipolar', { hidOnly: true }),
]

export const INPUTS: InputDef[] = [...BUTTONS, ...AXES]

export const INPUT_BY_ID: Record<string, InputDef> = Object.fromEntries(INPUTS.map((i) => [i.id, i]))

export const GROUPS: { id: InputGroup; label: string }[] = [
  { id: 'face', label: 'Face buttons' },
  { id: 'dpad', label: 'D-pad' },
  { id: 'shoulder', label: 'Bumpers & triggers' },
  { id: 'sticks', label: 'Thumbsticks' },
  { id: 'trackpads', label: 'Trackpads' },
  { id: 'grips', label: 'Grips' },
  { id: 'system', label: 'System' },
  { id: 'motion', label: 'Motion' },
]

/** Live snapshot of the controller. Buttons are booleans, axes are normalised floats. */
export interface ControllerState {
  buttons: Record<string, boolean>
  axes: Record<string, number>
}

export function emptyState(): ControllerState {
  return {
    buttons: Object.fromEntries(BUTTONS.map((d) => [d.id, false])),
    axes: Object.fromEntries(AXES.map((d) => [d.id, 0])),
  }
}
