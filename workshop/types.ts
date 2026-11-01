import type { Group } from 'three';
import type { EngineConfig, EngineTelemetry } from '../dsp.ts';
import type { PhysicalConfig, PowertrainState } from '../powertrain.ts';

export type PartId = 'engine' | 'turbo' | 'exhaust' | 'injection' | 'instruments';
export type LabMode = 'normal' | 'enthusiast' | 'scholar';

/** One-way presentation inputs. A model never writes into the solver or audio. */
export interface WorkshopState {
  config: EngineConfig;
  telemetry: EngineTelemetry;
  physical: PhysicalConfig;
  powertrain: PowertrainState;
  physicalActive: boolean;
  running: boolean;
  /** Intentionally slowed, illustrative animation, not a sampled crank measurement. */
  crankAngleRad: number;
  time: number;
  exploded: number;
  cutaway: boolean;
}

export interface PartModel {
  root: Group;
  update(state: WorkshopState, dt: number): void;
  dispose(): void;
}
