import { getDayNightState } from './daynight.js';

export interface LightState {
  on: boolean;
  mode: 'auto' | 'manual';
  updatedAt: string;
  source: 'inferred';
  state: 'day' | 'night' | 'unknown';
}

/**
 * Backward-compatibility wrapper for light queries.
 * Inferred from camera Day/Night mode: 'day' = Light ON (Color), 'night' = Light OFF (IR B&W).
 */
export function getLightState(): LightState {
  const dn = getDayNightState();
  return {
    on: dn.state === 'day',
    mode: 'auto',
    updatedAt: dn.updatedAt,
    source: 'inferred',
    state: dn.state,
  };
}

/**
 * Explicitly disabled: preset 64/65 does not toggle hardware GPIOs in EseeCloud firmware.
 */
export async function setCameraLight(_on: boolean): Promise<{ success: boolean; state: LightState; message: string }> {
  return {
    success: false,
    state: getLightState(),
    message: 'El control del modo día/noche (luz) es exclusivo de la app móvil EseeCloud (P2P/nube); la cámara no expone endpoint local de conmutación.',
  };
}
