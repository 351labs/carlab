//! Faithful f64 port of the original sample-free engine synthesizer.
//! Pipe/resonator memory uses f64 as in TypeScript Float64Array; PCM is f32.
//! process() allocates no buffers and preserves state across host blocks.
use crate::config::{EngineConfig, EngineState, PhysicalAudioState};
use serde::{Deserialize, Serialize};
use std::f64::consts::{PI, TAU};
const MAX_CYLINDERS: usize = 12;
const PARAMS: usize = 37;
const PRESSURE: usize = 0;
const ATTACK: usize = 1;
const DECAY: usize = 2;
const IRREGULARITY: usize = 3;
const CAM: usize = 4;
const MUFFLER: usize = 5;
const DAMPING: usize = 6;
const CROSSOVER: usize = 7;
const BOOST: usize = 8;
const TURBO_SIZE: usize = 9;
const BOV: usize = 10;
const EXHAUST_GAIN: usize = 11;
const INTAKE_GAIN: usize = 12;
const MECHANICAL_GAIN: usize = 13;
const TURBO_GAIN: usize = 14;
const WIDTH: usize = 15;
const OVERRUN: usize = 16;
const REDLINE: usize = 17;
const INERTIA: usize = 18;
const IDLE: usize = 19;
const BALANCE: usize = 20;
const BANK_PRESENCE: usize = 21;
const ROUGHNESS: usize = 22;
const TIMING_JITTER: usize = 23;
const LOW_BODY: usize = 24;
const WEAR: usize = 25;
const DETAIL: usize = 26;
const ENGINE_VIEW: usize = 27;
const CABIN_VIEW: usize = 28;
const ROADSIDE_VIEW: usize = 29;
const PHYSICAL_MIX: usize = 30;
const PHYSICAL_BOOST: usize = 31;
const INTAKE_PRESSURE: usize = 32;
const EXHAUST_PRESSURE: usize = 33;
const EXHAUST_FLOW: usize = 34;
const EXHAUST_TEMPERATURE: usize = 35;
const RESIDUAL: usize = 36;

fn clamp(value: f64, lo: f64, hi: f64) -> f64 {
    value.max(lo).min(hi)
}
fn physical_value(value: f64, fallback: f64, lo: f64, hi: f64) -> f64 {
    if value.is_finite() {
        clamp(value, lo, hi)
    } else {
        fallback
    }
}

#[derive(Clone)]
struct Pipe {
    sample_rate: f64,
    buffer: Vec<f64>,
    position: usize,
    low: f64,
    delay: f64,
    target_delay: f64,
    cutoff: f64,
    target_cutoff: f64,
    reflection: f64,
    target_reflection: f64,
    nominal_delay: f64,
    nominal_cutoff_hz: f64,
    nominal_reflection: f64,
    smoothing: f64,
}
impl Pipe {
    fn new(sr: f64) -> Self {
        Self {
            sample_rate: sr,
            buffer: vec![0.0; (sr * 0.09).ceil() as usize + 4],
            position: 0,
            low: 0.0,
            delay: 1.0,
            target_delay: 1.0,
            cutoff: 0.3,
            target_cutoff: 0.3,
            reflection: 0.5,
            target_reflection: 0.5,
            nominal_delay: 1.0,
            nominal_cutoff_hz: 1000.0,
            nominal_reflection: 0.5,
            smoothing: 1.0 - (-1.0 / (sr * 0.035)).exp(),
        }
    }
    fn configure(
        &mut self,
        length: f64,
        speed: f64,
        cutoff_hz: f64,
        reflection: f64,
        immediate: bool,
    ) {
        self.nominal_delay = clamp(
            2.0 * length / speed * self.sample_rate,
            1.0,
            (self.buffer.len() - 2) as f64,
        );
        self.nominal_cutoff_hz = cutoff_hz;
        self.nominal_reflection = reflection;
        self.target_delay = self.nominal_delay;
        self.target_cutoff =
            1.0 - (-TAU * clamp(cutoff_hz, 80.0, self.sample_rate * 0.42) / self.sample_rate).exp();
        self.target_reflection = clamp(reflection, 0.0, 0.86);
        if immediate {
            self.delay = self.target_delay;
            self.cutoff = self.target_cutoff;
            self.reflection = self.target_reflection;
        }
    }
    fn set_environment(&mut self, speed_ratio: f64, flow_loss: f64) {
        self.target_delay = clamp(
            self.nominal_delay / speed_ratio,
            1.0,
            (self.buffer.len() - 2) as f64,
        );
        let cutoff = clamp(
            self.nominal_cutoff_hz * (1.0 - flow_loss * 0.24),
            80.0,
            self.sample_rate * 0.42,
        );
        self.target_cutoff = 1.0 - (-TAU * cutoff / self.sample_rate).exp();
        self.target_reflection = clamp(
            self.nominal_reflection * (1.0 - flow_loss * 0.32),
            0.0,
            0.86,
        );
    }
    fn tick(&mut self, input: f64) -> f64 {
        self.delay += (self.target_delay - self.delay) * self.smoothing;
        self.cutoff += (self.target_cutoff - self.cutoff) * self.smoothing;
        self.reflection += (self.target_reflection - self.reflection) * self.smoothing;
        let mut read = self.position as f64 - self.delay;
        if read < 0.0 {
            read += self.buffer.len() as f64;
        }
        let index = read.floor() as usize;
        let fraction = read - index as f64;
        let next = if index + 1 == self.buffer.len() {
            0
        } else {
            index + 1
        };
        let wave = self.buffer[index] + (self.buffer[next] - self.buffer[index]) * fraction;
        self.low += (wave - self.low) * self.cutoff;
        let write = input - self.low * self.reflection;
        self.buffer[self.position] = write / (1.0 + write.abs() * 0.13);
        self.position += 1;
        if self.position == self.buffer.len() {
            self.position = 0;
        }
        self.low
    }
}
#[derive(Clone)]
struct BodyMode {
    b: f64,
    a1: f64,
    a2: f64,
    target_b: f64,
    target_a1: f64,
    target_a2: f64,
    x1: f64,
    x2: f64,
    y1: f64,
    y2: f64,
    smoothing: f64,
    sample_rate: f64,
}
impl BodyMode {
    fn new(sr: f64) -> Self {
        Self {
            b: 0.0,
            a1: 0.0,
            a2: 0.0,
            target_b: 0.0,
            target_a1: 0.0,
            target_a2: 0.0,
            x1: 0.0,
            x2: 0.0,
            y1: 0.0,
            y2: 0.0,
            smoothing: 1.0 - (-1.0 / (sr * 0.05)).exp(),
            sample_rate: sr,
        }
    }
    fn configure(&mut self, frequency: f64, q: f64, immediate: bool) {
        let omega = TAU * frequency / self.sample_rate;
        let alpha = omega.sin() / (2.0 * q);
        self.target_b = alpha / (1.0 + alpha);
        self.target_a1 = -2.0 * omega.cos() / (1.0 + alpha);
        self.target_a2 = (1.0 - alpha) / (1.0 + alpha);
        if immediate {
            self.b = self.target_b;
            self.a1 = self.target_a1;
            self.a2 = self.target_a2;
        }
    }
    fn tick(&mut self, input: f64) -> f64 {
        self.b += (self.target_b - self.b) * self.smoothing;
        self.a1 += (self.target_a1 - self.a1) * self.smoothing;
        self.a2 += (self.target_a2 - self.a2) * self.smoothing;
        let value = self.b * (input - self.x2) - self.a1 * self.y1 - self.a2 * self.y2;
        self.x2 = self.x1;
        self.x1 = input;
        self.y2 = self.y1;
        self.y1 = clamp(value, -8.0, 8.0);
        self.y1
    }
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineTelemetry {
    pub rpm: f64,
    pub load: f64,
    pub throttle: f64,
    pub boost: f64,
    pub turbo_rpm: f64,
    pub firing_hz: f64,
    pub peak: f64,
    pub limiter: bool,
    pub cycle: f64,
    pub firing_events: u64,
    pub combustion_events: u64,
    pub bov: f64,
    pub physical: Option<PhysicalAudioState>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CharacterTelemetry {
    pub timing_mean_deg: f64,
    pub timing_rms_deg: f64,
    pub timing_max_deg: f64,
    pub weak_combustions: u64,
    pub idle_hunt_rpm: f64,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PulseDiagnostics {
    pub blowdown_ms: f64,
    pub flow_ms: f64,
    pub intake_ms: f64,
}
#[derive(Clone)]
pub struct EngineDsp {
    pub sample_rate: f64,
    config: EngineConfig,
    parameters: [f64; PARAMS],
    targets: [f64; PARAMS],
    angles: [f64; MAX_CYLINDERS],
    arrivals: [f64; MAX_CYLINDERS],
    timing_offsets: [f64; MAX_CYLINDERS],
    cylinder_trim: [f64; MAX_CYLINDERS],
    cycle_energy: [f64; MAX_CYLINDERS],
    pulse_width: [f64; MAX_CYLINDERS],
    banks: [u8; MAX_CYLINDERS],
    bank_mix: [f64; MAX_CYLINDERS],
    slow_pulses: [f64; MAX_CYLINDERS],
    fast_pulses: [f64; MAX_CYLINDERS],
    intake_slow_pulses: [f64; MAX_CYLINDERS],
    intake_fast_pulses: [f64; MAX_CYLINDERS],
    blowdown: [f64; MAX_CYLINDERS],
    blowdown_rise: [f64; MAX_CYLINDERS],
    exhaust_flow: [f64; MAX_CYLINDERS],
    exhaust_return: [f64; MAX_CYLINDERS],
    blowdown_decay: [f64; MAX_CYLINDERS],
    blowdown_attack: [f64; MAX_CYLINDERS],
    flow_decay: [f64; MAX_CYLINDERS],
    return_coefficient: [f64; MAX_CYLINDERS],
    intake_detail_slow: [f64; MAX_CYLINDERS],
    intake_detail_fast: [f64; MAX_CYLINDERS],
    intake_detail_decay: [f64; MAX_CYLINDERS],
    intake_detail_attack: [f64; MAX_CYLINDERS],
    header_a: Pipe,
    header_b: Pipe,
    exhaust_a: Pipe,
    exhaust_b: Pipe,
    intake: Pipe,
    body_a: BodyMode,
    body_b: BodyMode,
    body_tail_a: BodyMode,
    body_tail_b: BodyMode,
    cabin_structure: BodyMode,
    parameter_smoothing: f64,
    control_smoothing: f64,
    actual_rpm_smoothing: f64,
    dc_coefficient: f64,
    noise_coefficient: f64,
    intake_low_coefficient: f64,
    muffler_smoothing: f64,
    cabin_coefficient: f64,
    air_coefficient: f64,
    cabin_low_l: f64,
    cabin_low_r: f64,
    cabin_low2_l: f64,
    cabin_low2_r: f64,
    air_low_l: f64,
    air_low_r: f64,
    pulse_blowdown_seconds: f64,
    pulse_flow_seconds: f64,
    pulse_intake_seconds: f64,
    physical_active: bool,
    physical_fuel_cut: bool,
    pending_energy_scale: f64,
    pending_burn_scale: f64,
    pending_phase_deg: f64,
    pending_cycle_index: f64,
    shared_energy_scale: f64,
    shared_burn_scale: f64,
    shared_phase_deg: f64,
    shared_cycle_index: f64,
    physical_flow_amplitude: f64,
    transfer_countdown: i32,
    transfer_was_physical: bool,
    reference_sound_speed: f64,
    random_state: u32,
    character_state: u32,
    jitter_boundary: f64,
    maximum_timing: f64,
    timing_mean: f64,
    timing_rms: f64,
    timing_maximum: f64,
    weak_combustions: u64,
    idle_hunt_rpm: f64,
    hunt_phase: f64,
    hunt_phase2: f64,
    target_rpm: f64,
    track_actual_rpm: bool,
    target_load: f64,
    target_throttle: f64,
    rpm: f64,
    load: f64,
    throttle: f64,
    crank: f64,
    cycles: u64,
    firing_events: u64,
    combustion_events: u64,
    active_cylinders: usize,
    pulse_scale: f64,
    exhaust_low_a: f64,
    exhaust_low_b: f64,
    noise_low: f64,
    intake_low: f64,
    spool: f64,
    turbo_phase: f64,
    turbo_harmonic_phase: f64,
    bov_envelope: f64,
    bov_armed: bool,
    blip_envelope: f64,
    shift_remaining: f64,
    running_target: f64,
    running_gain: f64,
    dc_in_l: f64,
    dc_in_r: f64,
    dc_out_l: f64,
    dc_out_r: f64,
    peak: f64,
    limiter: bool,
}
impl EngineDsp {
    pub fn new(sample_rate: f64, config: EngineConfig) -> Self {
        assert!(
            sample_rate.is_finite() && (8000.0..=384000.0).contains(&sample_rate),
            "EngineDSP sample rate must be between 8000 and 384000 Hz."
        );
        let config = config.normalize();
        let mut value = Self {
            sample_rate: sample_rate,
            config: config.clone(),
            parameters: [0.0; PARAMS],
            targets: [0.0; PARAMS],
            angles: [0.0; MAX_CYLINDERS],
            arrivals: [0.0; MAX_CYLINDERS],
            timing_offsets: [0.0; MAX_CYLINDERS],
            cylinder_trim: [0.0; MAX_CYLINDERS],
            cycle_energy: [0.0; MAX_CYLINDERS],
            pulse_width: [0.0; MAX_CYLINDERS],
            banks: [0; MAX_CYLINDERS],
            bank_mix: [0.0; MAX_CYLINDERS],
            slow_pulses: [0.0; MAX_CYLINDERS],
            fast_pulses: [0.0; MAX_CYLINDERS],
            intake_slow_pulses: [0.0; MAX_CYLINDERS],
            intake_fast_pulses: [0.0; MAX_CYLINDERS],
            blowdown: [0.0; MAX_CYLINDERS],
            blowdown_rise: [0.0; MAX_CYLINDERS],
            exhaust_flow: [0.0; MAX_CYLINDERS],
            exhaust_return: [0.0; MAX_CYLINDERS],
            blowdown_decay: [0.0; MAX_CYLINDERS],
            blowdown_attack: [0.0; MAX_CYLINDERS],
            flow_decay: [0.0; MAX_CYLINDERS],
            return_coefficient: [0.0; MAX_CYLINDERS],
            intake_detail_slow: [0.0; MAX_CYLINDERS],
            intake_detail_fast: [0.0; MAX_CYLINDERS],
            intake_detail_decay: [0.0; MAX_CYLINDERS],
            intake_detail_attack: [0.0; MAX_CYLINDERS],
            header_a: Pipe::new(sample_rate),
            header_b: Pipe::new(sample_rate),
            exhaust_a: Pipe::new(sample_rate),
            exhaust_b: Pipe::new(sample_rate),
            intake: Pipe::new(sample_rate),
            body_a: BodyMode::new(sample_rate),
            body_b: BodyMode::new(sample_rate),
            body_tail_a: BodyMode::new(sample_rate),
            body_tail_b: BodyMode::new(sample_rate),
            cabin_structure: BodyMode::new(sample_rate),
            parameter_smoothing: 0.0,
            control_smoothing: 0.0,
            actual_rpm_smoothing: 0.0,
            dc_coefficient: 0.0,
            noise_coefficient: 0.0,
            intake_low_coefficient: 0.0,
            muffler_smoothing: 0.0,
            cabin_coefficient: 0.0,
            air_coefficient: 0.0,
            cabin_low_l: 0.0,
            cabin_low_r: 0.0,
            cabin_low2_l: 0.0,
            cabin_low2_r: 0.0,
            air_low_l: 0.0,
            air_low_r: 0.0,
            pulse_blowdown_seconds: 0.0,
            pulse_flow_seconds: 0.0,
            pulse_intake_seconds: 0.0,
            physical_active: false,
            physical_fuel_cut: false,
            pending_energy_scale: 1.0,
            pending_burn_scale: 1.0,
            pending_phase_deg: 0.0,
            pending_cycle_index: 0.0,
            shared_energy_scale: 1.0,
            shared_burn_scale: 1.0,
            shared_phase_deg: 0.0,
            shared_cycle_index: 0.0,
            physical_flow_amplitude: 0.0,
            transfer_countdown: 0,
            transfer_was_physical: false,
            reference_sound_speed: 500.0,
            random_state: 0,
            character_state: 0,
            jitter_boundary: 0.9,
            maximum_timing: 0.01,
            timing_mean: 0.0,
            timing_rms: 0.0,
            timing_maximum: 0.0,
            weak_combustions: 0,
            idle_hunt_rpm: 0.0,
            hunt_phase: 0.0,
            hunt_phase2: 0.0,
            target_rpm: 0.0,
            track_actual_rpm: false,
            target_load: 0.25,
            target_throttle: 0.25,
            rpm: 0.0,
            load: 0.25,
            throttle: 0.25,
            crank: 0.0,
            cycles: 0,
            firing_events: 0,
            combustion_events: 0,
            active_cylinders: 4,
            pulse_scale: 0.5,
            exhaust_low_a: 0.0,
            exhaust_low_b: 0.0,
            noise_low: 0.0,
            intake_low: 0.0,
            spool: 0.0,
            turbo_phase: 0.0,
            turbo_harmonic_phase: 0.0,
            bov_envelope: 0.0,
            bov_armed: false,
            blip_envelope: 0.0,
            shift_remaining: 0.0,
            running_target: 1.0,
            running_gain: 0.0,
            dc_in_l: 0.0,
            dc_in_r: 0.0,
            dc_out_l: 0.0,
            dc_out_r: 0.0,
            peak: 0.0,
            limiter: false,
        };
        value.random_state = config.seed;
        value.character_state = (config.seed ^ 0x6d2b79f5).max(1);
        value.rpm = config.idle_rpm;
        value.target_rpm = value.rpm;
        value.cabin_structure.configure(118.0, 1.9, true);
        value.parameter_smoothing = 1.0 - (-1.0 / (sample_rate * 0.035)).exp();
        value.control_smoothing = 1.0 - (-1.0 / (sample_rate * 0.024)).exp();
        value.actual_rpm_smoothing = 1.0 - (-1.0 / (sample_rate * 0.005)).exp();
        value.dc_coefficient = (-TAU * 18.0 / sample_rate).exp();
        value.noise_coefficient = 1.0 - (-TAU * 1200.0 / sample_rate).exp();
        value.intake_low_coefficient = 1.0 - (-TAU * 190.0 / sample_rate).exp();
        value.muffler_smoothing = 1.0 - (-TAU * 950.0 / sample_rate).exp();
        value.cabin_coefficient = 1.0 - (-TAU * 1350.0 / sample_rate).exp();
        value.air_coefficient = 1.0 - (-TAU * 3700.0 / sample_rate).exp();
        value.targets[INTAKE_PRESSURE] = 1.01325;
        value.targets[EXHAUST_PRESSURE] = 1.01325;
        value.targets[EXHAUST_TEMPERATURE] = config.temperature + 273.15;
        value.configure(true);
        value
    }
    pub fn set_config(&mut self, config: &EngineConfig) {
        let next = config.clone().normalize();
        if next.seed != self.config.seed {
            self.random_state = next.seed;
            self.character_state = (next.seed ^ 0x6d2b79f5).max(1);
        }
        self.config = next;
        self.configure(false);
    }
    /// Controls are complete snapshots. None explicitly clears shared physical input.
    pub fn set_state(&mut self, state: &EngineState, actual_rpm: bool) {
        self.track_actual_rpm = actual_rpm;
        if !actual_rpm || state.physical.is_none() {
            self.physical_active = false;
            self.physical_fuel_cut = false;
            self.targets[PHYSICAL_MIX] = 0.0;
        } else if let Some(input) = &state.physical {
            let first = !self.physical_active;
            let t = &mut self.targets;
            t[PHYSICAL_BOOST] = physical_value(
                input.boost_bar,
                if first { 0.0 } else { t[PHYSICAL_BOOST] },
                0.0,
                6.0,
            );
            t[INTAKE_PRESSURE] = physical_value(
                input.intake_pressure_bar,
                if first { 1.01325 } else { t[INTAKE_PRESSURE] },
                0.05,
                10.0,
            );
            t[EXHAUST_PRESSURE] = physical_value(
                input.exhaust_pressure_bar,
                if first { 1.01325 } else { t[EXHAUST_PRESSURE] },
                0.1,
                15.0,
            );
            t[EXHAUST_FLOW] = physical_value(
                input.exhaust_mass_flow_kgs,
                if first { 0.0 } else { t[EXHAUST_FLOW] },
                0.0,
                10.0,
            );
            t[EXHAUST_TEMPERATURE] = physical_value(
                input.exhaust_temperature_k,
                if first {
                    self.config.temperature + 273.15
                } else {
                    t[EXHAUST_TEMPERATURE]
                },
                200.0,
                1800.0,
            );
            t[RESIDUAL] = physical_value(
                input.residual_fraction,
                if first { 0.0 } else { t[RESIDUAL] },
                0.0,
                0.8,
            );
            self.pending_energy_scale = physical_value(
                input.cycle_energy_scale,
                if first {
                    1.0
                } else {
                    self.pending_energy_scale
                },
                0.0,
                3.0,
            );
            self.pending_burn_scale = physical_value(
                input.burn_duration_scale,
                if first { 1.0 } else { self.pending_burn_scale },
                0.4,
                2.5,
            );
            self.pending_phase_deg = physical_value(
                input.combustion_phase_deg,
                if first { 0.0 } else { self.pending_phase_deg },
                -12.0,
                12.0,
            );
            self.pending_cycle_index = physical_value(
                input.cycle_index,
                if first { 0.0 } else { self.pending_cycle_index },
                0.0,
                9007199254740991.0,
            )
            .floor();
            self.physical_fuel_cut = input.fuel_cut;
            if first {
                for i in PHYSICAL_BOOST..=RESIDUAL {
                    self.parameters[i] = t[i];
                }
                self.shared_energy_scale = self.pending_energy_scale;
                self.shared_burn_scale = self.pending_burn_scale;
                self.shared_cycle_index = self.pending_cycle_index;
            }
            self.physical_active = true;
            t[PHYSICAL_MIX] = 1.0;
            if first && self.cycles == 0 && self.crank == 0.0 && self.firing_events == 0 {
                self.refresh_character();
            }
        }
        if state.rpm.is_finite() {
            self.target_rpm = clamp(state.rpm, 0.0, 22000.0);
        }
        if state.load.is_finite() {
            self.target_load = clamp(state.load, 0.0, 1.0);
        }
        if state.throttle.is_finite() {
            self.target_throttle = clamp(state.throttle, 0.0, 1.0);
        }
    }
    pub fn trigger(&mut self, kind: &str) {
        match kind {
            "shift" => {
                self.shift_remaining = 0.14;
                if !self.physical_active {
                    self.bov_envelope = self.bov_envelope.max(self.spool * 0.75);
                }
            }
            "blip" => self.blip_envelope = 1.0,
            "stop" => self.running_target = 0.0,
            "start" => {
                self.running_target = 1.0;
                if self.target_rpm < self.config.idle_rpm {
                    self.target_rpm = self.config.idle_rpm;
                }
            }
            _ => {}
        }
    }
    /// Unsmoothed numeric control targets, independent of output telemetry.
    /// Physical targets retain their separate pending/latching semantics.
    pub fn get_control_targets(&self) -> (f64, f64, f64) {
        (self.target_rpm, self.target_load, self.target_throttle)
    }
    pub fn get_telemetry(&self) -> EngineTelemetry {
        let p = &self.parameters;
        EngineTelemetry {
            rpm: self.rpm,
            load: self.load,
            throttle: self.throttle,
            boost: if self.physical_active {
                p[PHYSICAL_BOOST]
            } else {
                self.spool * self.spool * p[BOOST]
            },
            turbo_rpm: if (self.physical_active && p[PHYSICAL_BOOST] > 0.0)
                || (!self.physical_active && self.config.boost_bar > 0.0)
            {
                self.spool * (150000.0 + 75000.0 * (1.0 - p[TURBO_SIZE]))
            } else {
                0.0
            },
            firing_hz: self.rpm * self.active_cylinders as f64 / 120.0,
            peak: self.peak,
            limiter: self.limiter,
            cycle: self.cycles as f64 + self.crank,
            firing_events: self.firing_events,
            combustion_events: self.combustion_events,
            bov: self.bov_envelope,
            physical: self.get_physical_audio_telemetry(),
        }
    }
    pub fn get_character_telemetry(&self) -> CharacterTelemetry {
        CharacterTelemetry {
            timing_mean_deg: self.timing_mean * 720.0,
            timing_rms_deg: self.timing_rms * 720.0,
            timing_max_deg: self.timing_maximum * 720.0,
            weak_combustions: self.weak_combustions,
            idle_hunt_rpm: self.idle_hunt_rpm,
        }
    }
    pub fn get_pulse_diagnostics(&self) -> PulseDiagnostics {
        PulseDiagnostics {
            blowdown_ms: self.pulse_blowdown_seconds * 1000.0,
            flow_ms: self.pulse_flow_seconds * 1000.0,
            intake_ms: self.pulse_intake_seconds * 1000.0,
        }
    }
    pub fn get_pulse_telemetry(&self) -> PulseDiagnostics {
        self.get_pulse_diagnostics()
    }
    pub fn get_physical_audio_telemetry(&self) -> Option<PhysicalAudioState> {
        if !self.physical_active {
            return None;
        }
        let p = &self.parameters;
        Some(PhysicalAudioState {
            boost_bar: p[PHYSICAL_BOOST],
            fuel_cut: self.physical_fuel_cut,
            intake_pressure_bar: p[INTAKE_PRESSURE],
            exhaust_pressure_bar: p[EXHAUST_PRESSURE],
            exhaust_mass_flow_kgs: p[EXHAUST_FLOW],
            exhaust_temperature_k: p[EXHAUST_TEMPERATURE],
            cycle_energy_scale: self.shared_energy_scale,
            burn_duration_scale: self.shared_burn_scale,
            combustion_phase_deg: self.shared_phase_deg,
            residual_fraction: p[RESIDUAL],
            cycle_index: self.shared_cycle_index,
        })
    }
    fn configure(&mut self, immediate: bool) {
        let c = &self.config;
        let mut topology_changed = self.active_cylinders != c.cylinders;
        for i in 0..c.cylinders {
            if self.angles[i] != c.firing_angles[i] / 720.0
                || self.banks[i] != c.cylinder_banks[c.firing_order[i] - 1]
            {
                topology_changed = true;
            }
        }
        let t = &mut self.targets;
        let per_cylinder = c.displacement / c.cylinders as f64;
        t[PRESSURE] = (per_cylinder / 0.5).powf(0.45) * (c.compression / 10.5).sqrt();
        t[ATTACK] = (-1.0 / (self.sample_rate * (0.000075 + (1.0 - c.cam) * 0.00013))).exp();
        t[DECAY] = (-1.0 / (self.sample_rate * (0.0014 + per_cylinder.sqrt() * 0.0022))).exp();
        t[IRREGULARITY] = c.irregularity;
        t[ROUGHNESS] = c.roughness;
        t[TIMING_JITTER] = c.timing_jitter;
        t[LOW_BODY] = c.low_body;
        t[WEAR] = c.wear;
        t[DETAIL] = c.combustion_detail;
        t[ENGINE_VIEW] = if c.perspective == "engine" { 1.0 } else { 0.0 };
        t[CABIN_VIEW] = if c.perspective == "cabin" { 1.0 } else { 0.0 };
        t[ROADSIDE_VIEW] = if c.perspective == "roadside" {
            1.0
        } else {
            0.0
        };
        t[PHYSICAL_MIX] = if self.physical_active { 1.0 } else { 0.0 };
        if !self.physical_active {
            t[EXHAUST_TEMPERATURE] = c.temperature + 273.15;
        }
        t[CAM] = c.cam;
        t[MUFFLER] = c.muffler;
        t[DAMPING] = c.damping;
        t[CROSSOVER] = if c.layout == "inline" {
            0.0
        } else {
            c.crossover
        };
        t[BOOST] = c.boost_bar;
        t[TURBO_SIZE] = c.turbo_size;
        t[BOV] = c.bov;
        t[EXHAUST_GAIN] = c.exhaust_gain;
        t[INTAKE_GAIN] = c.intake_gain;
        t[MECHANICAL_GAIN] = c.mechanical_gain;
        t[TURBO_GAIN] = c.turbo_gain;
        t[WIDTH] = c.stereo_width;
        t[OVERRUN] = c.overrun;
        t[REDLINE] = c.redline;
        t[INERTIA] = c.inertia;
        t[IDLE] = c.idle_rpm;
        t[BALANCE] = if c.layout == "inline" {
            if c.cylinders % 2 != 0 { 0.55 } else { 0.28 }
        } else if c.layout == "boxer" {
            0.12
        } else {
            0.2 + (c.bank_angle * PI / 180.0).cos().abs() * 0.3
        };
        t[BANK_PRESENCE] = if c.layout != "inline" && c.cylinder_banks.contains(&1) {
            1.0
        } else {
            0.0
        };
        if immediate {
            self.parameters = *t;
        }
        self.active_cylinders = c.cylinders;
        self.pulse_scale = 1.0 / (c.cylinders as f64).sqrt();
        let mut largest_gap = 0.0;
        let mut smallest_gap: f64 = 1.0;
        let mut trim_mean = 0.0;
        for i in 0..c.cylinders {
            self.angles[i] = c.firing_angles[i] / 720.0;
            self.banks[i] = c.cylinder_banks[c.firing_order[i] - 1];
            if immediate {
                self.bank_mix[i] = self.banks[i] as f64;
            }
            let raw =
                ((c.firing_angles[(i + 1) % c.cylinders] - c.firing_angles[i]) / 720.0 + 1.0) % 1.0;
            let gap = if raw == 0.0 { 1.0 } else { raw };
            if gap > largest_gap {
                largest_gap = gap;
                self.jitter_boundary = (self.angles[i] + gap * 0.5) % 1.0;
            }
            smallest_gap = smallest_gap.min(gap);
            let mut trim = c
                .seed
                .wrapping_add((c.firing_order[i] as u32).wrapping_mul(0x9e3779b9));
            trim ^= trim >> 16;
            trim = trim.wrapping_mul(0x45d9f3b);
            trim ^= trim >> 16;
            self.cylinder_trim[i] = trim as f64 / 2147483648.0 - 1.0;
            trim_mean += self.cylinder_trim[i];
        }
        for i in 0..c.cylinders {
            self.cylinder_trim[i] -= trim_mean / c.cylinders as f64;
        }
        self.maximum_timing = (7.2_f64 / 720.0).min(smallest_gap * 0.16);
        let speed = 343.0 * ((c.temperature + 273.15) / 293.15).sqrt();
        let diameter = c.pipe_diameter / 57.0;
        let junction = clamp(0.68 - diameter.ln().abs() * 0.12, 0.38, 0.74);
        let header_cutoff = (9500.0 - c.damping * 6100.0) * diameter.sqrt();
        let tail_cutoff = (8500.0 - c.muffler * 6100.0 - c.damping * 1300.0) * diameter.sqrt();
        let header_reflection = junction * (1.0 - c.damping * 0.44);
        let tail_reflection = (0.76 - c.muffler * 0.32) * (1.0 - c.damping * 0.36);
        let bank_travel = if c.layout == "boxer" { 1.16 } else { 1.025 };
        self.header_a.configure(
            c.header_length,
            speed,
            header_cutoff,
            header_reflection,
            immediate,
        );
        self.header_b.configure(
            c.header_length * bank_travel,
            speed,
            header_cutoff,
            header_reflection,
            immediate,
        );
        self.exhaust_a.configure(
            c.exhaust_length,
            speed,
            tail_cutoff,
            tail_reflection,
            immediate,
        );
        self.exhaust_b.configure(
            c.exhaust_length * 1.018,
            speed,
            tail_cutoff,
            tail_reflection,
            immediate,
        );
        self.intake.configure(
            c.intake_length,
            343.0,
            4200.0 - c.damping * 1400.0,
            0.72,
            immediate,
        );
        self.reference_sound_speed = speed;
        if immediate || topology_changed {
            self.refresh_character();
        }
        self.configure_body_modes(speed, immediate);
    }
    fn configure_body_modes(&mut self, speed: f64, immediate: bool) {
        let c = &self.config;
        let body_hz = clamp(
            speed * 0.72 / (4.0 * (c.exhaust_length + c.header_length + 0.45)),
            48.0,
            145.0,
        );
        let body_q = 2.6 + c.low_body * (4.4 + (1.0 - c.damping) * 3.2);
        let chest_hz = clamp(body_hz * 3.0, 85.0, 210.0);
        self.body_a
            .configure(chest_hz, 2.1 + c.low_body * 3.1, immediate);
        self.body_b
            .configure(chest_hz * 1.08, 2.0 + c.low_body * 2.8, immediate);
        self.body_tail_a.configure(body_hz, body_q, immediate);
        self.body_tail_b
            .configure(body_hz * 1.12, body_q * 0.91, immediate);
    }
    fn character_random(&mut self) -> f64 {
        let mut x = self.character_state;
        x ^= x << 13;
        x ^= x >> 17;
        x ^= x << 5;
        self.character_state = x;
        x as f64 / 2147483648.0 - 1.0
    }
    fn random(&mut self) -> f64 {
        let mut x = self.random_state;
        x ^= x << 13;
        x ^= x >> 17;
        x ^= x << 5;
        self.random_state = x;
        x as f64 / 2147483648.0 - 1.0
    }
    fn refresh_character(&mut self) {
        let n = self.active_cylinders;
        if self.physical_active {
            self.shared_energy_scale = self.pending_energy_scale;
            self.shared_burn_scale = self.pending_burn_scale;
            self.shared_cycle_index = self.pending_cycle_index;
            let offset = clamp(
                self.pending_phase_deg / 720.0,
                -self.maximum_timing,
                self.maximum_timing,
            );
            self.shared_phase_deg = offset * 720.0;
            for i in 0..n {
                self.timing_offsets[i] = offset;
                self.cycle_energy[i] = 0.0;
                self.arrivals[i] = if offset == 0.0 {
                    self.angles[i]
                } else {
                    (self.angles[i] + offset + 1.0) % 1.0
                };
            }
            self.timing_mean = offset;
            self.timing_rms = offset.abs();
            self.timing_maximum = offset.abs();
            return;
        }
        let mut mean = 0.0;
        let mut energy_mean = 0.0;
        let mut maximum: f64 = 0.0;
        for i in 0..n {
            self.timing_offsets[i] = self.character_random();
            mean += self.timing_offsets[i];
            self.cycle_energy[i] = self.character_random();
            energy_mean += self.cycle_energy[i];
        }
        mean /= n as f64;
        energy_mean /= n as f64;
        for i in 0..n {
            self.timing_offsets[i] -= mean;
            maximum = maximum.max(self.timing_offsets[i].abs());
            self.cycle_energy[i] -= energy_mean;
        }
        let idle = clamp(
            (self.parameters[IDLE] * 1.8 - self.rpm) / (self.parameters[IDLE] * 0.8),
            0.0,
            1.0,
        );
        let extent = self.maximum_timing * self.parameters[TIMING_JITTER] * (0.22 + idle * 0.78);
        let mut square = 0.0;
        let mut offset_mean = 0.0;
        for i in 0..n {
            let offset = if maximum > 0.0 {
                self.timing_offsets[i] / maximum * extent
            } else {
                0.0
            };
            self.timing_offsets[i] = offset;
            self.arrivals[i] = if offset == 0.0 {
                self.angles[i]
            } else {
                (self.angles[i] + offset + 1.0) % 1.0
            };
            square += offset * offset;
            offset_mean += offset;
        }
        self.timing_mean = offset_mean / n as f64;
        self.timing_rms = (square / n as f64).sqrt();
        self.timing_maximum = extent;
    }
    fn excite_exhaust_detail(
        &mut self,
        cylinder: usize,
        amplitude: f64,
        rpm: f64,
        load: f64,
        age: f64,
    ) {
        let sr = self.sample_rate;
        let cam = self.parameters[CAM];
        let degrees_per_second = rpm.max(300.0) * 6.0;
        let volume = clamp(
            (self.config.displacement / self.active_cylinders as f64 / 0.5).sqrt(),
            0.6,
            1.7,
        );
        let variation = if self.physical_active {
            self.shared_burn_scale
        } else {
            1.0 + self.pulse_width[cylinder]
        };
        let blowdown = clamp(
            (16.0 + (1.0 - load) * 12.0 + cam * 7.0) * volume / degrees_per_second,
            0.0007,
            0.006,
        ) * variation;
        let rise = clamp(
            (0.8 + (1.0 - load) * 1.2) / degrees_per_second,
            0.000035,
            0.00035,
        ) * if self.physical_active {
            self.shared_burn_scale * (1.0 + self.parameters[RESIDUAL] * 0.75)
        } else {
            1.0
        };
        let flow = (blowdown * 1.45).max(clamp(
            (52.0 + cam * 10.0) * volume.powf(0.25) / degrees_per_second,
            0.0014,
            0.014,
        ));
        self.blowdown_decay[cylinder] = (-1.0 / (sr * blowdown)).exp();
        self.blowdown_attack[cylinder] = (-1.0 / (sr * rise)).exp();
        self.flow_decay[cylinder] = (-1.0 / (sr * flow)).exp();
        self.return_coefficient[cylinder] = 1.0 - (-1.0 / (sr * flow * 1.15)).exp();
        let pressure = amplitude * (0.92 + load * 0.08);
        self.blowdown[cylinder] += pressure * self.blowdown_decay[cylinder].powf(age);
        self.blowdown_rise[cylinder] += pressure * self.blowdown_attack[cylinder].powf(age);
        self.exhaust_flow[cylinder] += pressure * self.flow_decay[cylinder].powf(age);
        self.pulse_blowdown_seconds = blowdown;
        self.pulse_flow_seconds = flow;
    }
    fn excite_intake_detail(
        &mut self,
        cylinder: usize,
        amplitude: f64,
        rpm: f64,
        load: f64,
        age: f64,
    ) {
        let degrees_per_second = rpm.max(300.0) * 6.0;
        let duration = clamp(
            (38.0 + self.parameters[CAM] * 30.0) / degrees_per_second,
            0.0014,
            0.018,
        );
        let rise = clamp(3.2 / degrees_per_second, 0.00012, 0.0025);
        self.intake_detail_decay[cylinder] = (-1.0 / (self.sample_rate * duration)).exp();
        self.intake_detail_attack[cylinder] = (-1.0 / (self.sample_rate * rise)).exp();
        let suction = amplitude * (0.65 + load * 0.35) * 0.82;
        self.intake_detail_slow[cylinder] += suction * self.intake_detail_decay[cylinder].powf(age);
        self.intake_detail_fast[cylinder] +=
            suction * self.intake_detail_attack[cylinder].powf(age);
        self.pulse_intake_seconds = duration;
    }
    fn update_physical_transfer(&mut self) {
        let p = self.parameters;
        let mix = p[PHYSICAL_MIX];
        if !self.physical_active && mix < 0.0001 && !self.transfer_was_physical {
            return;
        }
        if !self.physical_active && mix < 0.0001 {
            self.header_a.set_environment(1.0, 0.0);
            self.header_b.set_environment(1.0, 0.0);
            self.exhaust_a.set_environment(1.0, 0.0);
            self.exhaust_b.set_environment(1.0, 0.0);
            self.configure_body_modes(self.reference_sound_speed, false);
            self.physical_flow_amplitude = 0.0;
            self.transfer_was_physical = false;
            return;
        }
        self.transfer_was_physical = true;
        let temperature = p[EXHAUST_TEMPERATURE];
        let speed = 343.0 * (temperature / 293.15).sqrt();
        let diameter_m = self.config.pipe_diameter / 1000.0;
        let area = PI * diameter_m * diameter_m / 4.0
            * if self.config.layout == "inline" {
                1.0
            } else {
                2.0
            };
        let density = p[EXHAUST_PRESSURE] * 1e5 / (287.05 * temperature);
        let velocity = clamp(p[EXHAUST_FLOW] / (density * area).max(0.00001), 0.0, 350.0);
        let mach_loss = clamp(velocity / speed, 0.0, 0.8);
        let speed_ratio = 1.0 + (speed / self.reference_sound_speed - 1.0) * mix;
        self.header_a.set_environment(speed_ratio, mach_loss * mix);
        self.header_b.set_environment(speed_ratio, mach_loss * mix);
        self.exhaust_a.set_environment(speed_ratio, mach_loss * mix);
        self.exhaust_b.set_environment(speed_ratio, mach_loss * mix);
        self.configure_body_modes(self.reference_sound_speed * speed_ratio, false);
        self.physical_flow_amplitude = (velocity / 140.0).powf(1.2) * 0.024 * mix;
    }
    pub fn process(&mut self, left: &mut [f32], right: &mut [f32]) {
        let frames = left.len().min(right.len());
        let sr = self.sample_rate;
        let dt = 1.0 / sr;
        for frame in 0..frames {
            for parameter in 0..PARAMS {
                self.parameters[parameter] += (self.targets[parameter]
                    - self.parameters[parameter])
                    * self.parameter_smoothing;
            }
            self.transfer_countdown -= 1;
            if self.transfer_countdown <= 0 {
                self.transfer_countdown = 128;
                self.update_physical_transfer();
            }
            // Stack copy releases the parameter borrow before event/pipe state updates.
            let p = self.parameters;
            let physical = self.physical_active;
            let detail = p[DETAIL].max(p[PHYSICAL_MIX]);
            let blip = self.blip_envelope;
            self.blip_envelope *= 1.0 - dt * 5.8;
            let shift = self.shift_remaining > 0.0;
            if shift {
                self.shift_remaining -= dt;
            }
            self.hunt_phase = (self.hunt_phase + dt * 0.61) % 1.0;
            self.hunt_phase2 = (self.hunt_phase2 + dt * 1.07) % 1.0;
            let idle_demand = clamp(
                (p[IDLE] * 1.8 - self.target_rpm) / (p[IDLE] * 0.8),
                0.0,
                1.0,
            ) * (1.0 - self.load)
                * (1.0 - self.throttle)
                * (1.0 - blip);
            self.idle_hunt_rpm = if self.track_actual_rpm {
                0.0
            } else {
                p[ROUGHNESS]
                    * idle_demand
                    * (10.0 + p[ROUGHNESS] * 48.0 + p[WEAR] * 20.0)
                    * ((TAU * self.hunt_phase).sin() + (TAU * self.hunt_phase2).sin() * 0.38)
            };
            let tracking = self.track_actual_rpm && self.running_target == 1.0;
            let rpm_wanted = if tracking {
                self.target_rpm
            } else {
                self.running_target
                    * ((self.target_rpm + self.idle_hunt_rpm) * if shift { 0.88 } else { 1.0 })
                        .max(blip * (p[REDLINE] * 0.65).min(p[IDLE] + 3800.0))
            };
            let rpm_coefficient = if tracking {
                self.actual_rpm_smoothing
            } else {
                dt / (0.028 + p[INERTIA] * 0.23)
            };
            self.rpm += (rpm_wanted - self.rpm) * rpm_coefficient;
            self.load += ((if physical {
                self.target_load
            } else {
                self.target_load.max(blip * 0.75)
            }) - self.load)
                * self.control_smoothing;
            self.throttle += ((if physical {
                self.target_throttle
            } else {
                self.target_throttle.max(blip)
            }) - self.throttle)
                * self.control_smoothing;
            self.running_gain += (self.running_target - self.running_gain) * dt
                / if self.running_target != 0.0 {
                    0.045
                } else {
                    0.14
                };
            let rpm = self.rpm;
            let load = self.load;
            let throttle = self.throttle;
            let rpm_fraction = clamp(rpm / p[REDLINE], 0.0, 1.3);
            let noise = self.random();
            self.noise_low += (noise - self.noise_low) * self.noise_coefficient;
            let high_noise = noise - self.noise_low;
            if physical {
                self.spool = clamp(p[PHYSICAL_BOOST] / 2.5, 0.0, 1.0).sqrt();
            } else {
                let spool_wanted = if p[BOOST] > 0.0 {
                    clamp(
                        (rpm_fraction - 0.12) / (0.62 + p[TURBO_SIZE] * 0.2),
                        0.0,
                        1.0,
                    ) * (throttle * load).sqrt()
                        * self.running_target
                } else {
                    0.0
                };
                let spool_time = if spool_wanted > self.spool {
                    0.22 + p[TURBO_SIZE] * 1.65
                } else {
                    0.52 + p[TURBO_SIZE] * 0.65
                };
                self.spool += (spool_wanted - self.spool) * dt / spool_time;
            }
            if throttle > 0.55 {
                self.bov_armed = true;
            }
            if self.bov_armed && throttle < 0.3 && self.spool > 0.12 {
                self.bov_envelope = self.bov_envelope.max(self.spool);
                self.bov_armed = false;
            }
            self.bov_envelope *= 1.0 - dt / (0.09 + p[TURBO_SIZE] * 0.22);
            let boost = if physical {
                p[PHYSICAL_BOOST]
            } else {
                self.spool * self.spool * p[BOOST]
            };
            let before = self.crank;
            let step = rpm / (120.0 * sr);
            let mut after = before + step;
            let wrapped = after >= 1.0;
            if wrapped {
                after -= 1.0;
                self.cycles += 1;
            }
            self.crank = after;
            let refresh = if wrapped {
                self.jitter_boundary > before || self.jitter_boundary <= after
            } else {
                self.jitter_boundary > before && self.jitter_boundary <= after
            };
            if refresh {
                self.refresh_character();
            }
            self.limiter = rpm >= p[REDLINE];
            let coast = throttle < 0.12 && load < 0.2 && rpm > p[IDLE] + 650.0;
            let idle_activity = clamp((p[IDLE] * 1.8 - rpm) / (p[IDLE] * 0.8), 0.0, 1.0)
                * (1.0 - load)
                * (1.0 - throttle);
            let mut bank_a = 0.0;
            let mut bank_b = 0.0;
            let mut intake_pulse_sum = 0.0;
            for cylinder in 0..MAX_CYLINDERS {
                if cylinder < self.active_cylinders && step > 0.0 {
                    let angle = self.angles[cylinder];
                    let inlet_angle = if angle < 0.5 {
                        angle + 0.5
                    } else {
                        angle - 0.5
                    };
                    let inlet_event = if wrapped {
                        inlet_angle > before || inlet_angle <= after
                    } else {
                        inlet_angle > before && inlet_angle <= after
                    };
                    if inlet_event {
                        let distance = if after >= inlet_angle {
                            after - inlet_angle
                        } else {
                            after + 1.0 - inlet_angle
                        };
                        let age = clamp(distance / step, 0.0, 1.0);
                        let amplitude = self.pulse_scale
                            * p[PRESSURE].sqrt()
                            * if physical {
                                clamp(p[INTAKE_PRESSURE] / 1.01325, 0.05, 4.0)
                            } else {
                                0.25 + throttle * 0.75
                            };
                        self.intake_slow_pulses[cylinder] += amplitude * p[DECAY].powf(age);
                        self.intake_fast_pulses[cylinder] += amplitude * p[ATTACK].powf(age);
                        self.excite_intake_detail(cylinder, amplitude, rpm, load, age);
                    }
                    let arrival = self.arrivals[cylinder];
                    let fired = if wrapped {
                        arrival > before || arrival <= after
                    } else {
                        arrival > before && arrival <= after
                    };
                    if fired {
                        self.firing_events += 1;
                        let variation = if physical { 0.0 } else { self.random() };
                        let cut = if physical {
                            self.physical_fuel_cut || self.shared_energy_scale <= 0.0
                        } else {
                            shift || (self.limiter && self.firing_events % 3 != 0)
                        };
                        let backfire = !physical && coast && variation > 1.0 - p[OVERRUN] * 0.27;
                        let fuel = if !physical && coast {
                            if backfire {
                                1.1 + p[OVERRUN] * 1.5
                            } else {
                                0.035
                            }
                        } else {
                            0.23 + load * 0.95
                        };
                        if !cut || backfire {
                            self.combustion_events += 1;
                            let idle_roughness = (1.0 - rpm / (p[IDLE] * 2.0)).max(0.0);
                            let mut combustion_quality = if physical {
                                self.shared_energy_scale
                            } else {
                                1.0 + p[ROUGHNESS]
                                    * (self.cylinder_trim[cylinder] * 0.12
                                        + self.cycle_energy[cylinder]
                                            * (0.055 + idle_activity * 0.11))
                            };
                            if !physical
                                && p[WEAR] > 0.0
                                && self.character_random() > 1.0 - p[WEAR] * idle_activity * 0.09
                            {
                                combustion_quality *= 0.72 + (self.character_random() + 1.0) * 0.07;
                                self.weak_combustions += 1;
                            }
                            self.pulse_width[cylinder] = if physical {
                                0.0
                            } else {
                                self.cycle_energy[cylinder] * p[ROUGHNESS] * 0.12
                            };
                            let amplitude = self.pulse_scale
                                * p[PRESSURE]
                                * fuel
                                * (1.0 + boost * 0.2)
                                * combustion_quality
                                * (1.0
                                    + variation * p[IRREGULARITY] * (0.12 + idle_roughness * 0.5))
                                * if physical {
                                    1.0
                                } else {
                                    1.0 + p[CAM]
                                        * idle_roughness
                                        * (TAU * before * 3.0).sin()
                                        * 0.35
                                };
                            let distance = if after >= arrival {
                                after - arrival
                            } else {
                                after + 1.0 - arrival
                            };
                            let age = if step > 0.0 {
                                clamp(distance / step, 0.0, 1.0)
                            } else {
                                0.0
                            };
                            self.slow_pulses[cylinder] += amplitude * p[DECAY].powf(age);
                            self.fast_pulses[cylinder] += amplitude * p[ATTACK].powf(age);
                            self.excite_exhaust_detail(cylinder, amplitude, rpm, load, age);
                        }
                    }
                }
                let legacy_pulse = self.slow_pulses[cylinder] - self.fast_pulses[cylinder];
                let flow = self.exhaust_flow[cylinder] - self.blowdown[cylinder];
                self.exhaust_return[cylinder] +=
                    (flow - self.exhaust_return[cylinder]) * self.return_coefficient[cylinder];
                let detailed_pulse = self.blowdown[cylinder] - self.blowdown_rise[cylinder]
                    + flow * 0.28
                    - self.exhaust_return[cylinder] * 0.12;
                let pulse = legacy_pulse + (detailed_pulse - legacy_pulse) * detail;
                self.blowdown[cylinder] *= self.blowdown_decay[cylinder];
                self.blowdown_rise[cylinder] *= self.blowdown_attack[cylinder];
                self.exhaust_flow[cylinder] *= self.flow_decay[cylinder];
                self.slow_pulses[cylinder] *=
                    p[DECAY] + (1.0 - p[DECAY]) * self.pulse_width[cylinder];
                self.fast_pulses[cylinder] *= p[ATTACK];
                let legacy_intake =
                    self.intake_slow_pulses[cylinder] - self.intake_fast_pulses[cylinder];
                let detailed_intake =
                    self.intake_detail_slow[cylinder] - self.intake_detail_fast[cylinder];
                intake_pulse_sum += legacy_intake + (detailed_intake - legacy_intake) * detail;
                self.intake_detail_slow[cylinder] *= self.intake_detail_decay[cylinder];
                self.intake_detail_fast[cylinder] *= self.intake_detail_attack[cylinder];
                self.intake_slow_pulses[cylinder] *= p[DECAY];
                self.intake_fast_pulses[cylinder] *= p[ATTACK];
                let textured = if physical {
                    pulse
                } else {
                    pulse * (1.0 + high_noise * (0.06 + load * 0.1))
                };
                self.bank_mix[cylinder] += (self.banks[cylinder] as f64 - self.bank_mix[cylinder])
                    * self.parameter_smoothing;
                bank_b += textured * self.bank_mix[cylinder];
                bank_a += textured * (1.0 - self.bank_mix[cylinder]);
            }
            if physical || p[PHYSICAL_MIX] > 0.0001 {
                let airflow =
                    (self.noise_low * 0.45 + high_noise * 0.55) * self.physical_flow_amplitude;
                if self.config.layout == "inline" {
                    bank_a += airflow;
                } else {
                    bank_a += airflow * 0.5;
                    bank_b += airflow * 0.5;
                }
            }
            let coupling = p[CROSSOVER] * 0.42;
            let head_a = self
                .header_a
                .tick(bank_a * (1.0 - coupling) + bank_b * coupling);
            let head_b = self
                .header_b
                .tick(bank_b * (1.0 - coupling) + bank_a * coupling);
            let tail_a = self.exhaust_a.tick(head_a * 0.72 + bank_a * 0.28);
            let tail_b = self.exhaust_b.tick(head_b * 0.72 + bank_b * 0.28);
            let mut exhaust_a = bank_a * 0.24 + head_a * 0.54 + tail_a * 0.9;
            let mut exhaust_b = bank_b * 0.24 + head_b * 0.54 + tail_b * 0.9;
            let crank_phase = after * 2.0 * TAU;
            let crank_order1 = crank_phase.sin();
            let crank_order2 = (crank_phase * 2.0).sin();
            let flow_charge = if physical {
                clamp(
                    p[EXHAUST_FLOW]
                        / (self.config.displacement * 0.001 * rpm / 120.0 * 1.2).max(0.001),
                    0.0,
                    2.0,
                )
            } else {
                1.0
            };
            let body_motion =
                self.config.displacement.sqrt() * 0.035 * (0.28 + load * 0.72) * flow_charge;
            let body_input_a = bank_a + body_motion * (crank_order1 * 0.42 + crank_order2 * 0.72);
            let body_input_b = bank_b + body_motion * (-crank_order1 * 0.32 + crank_order2 * 0.72);
            let body_a =
                self.body_a.tick(body_input_a) + self.body_tail_a.tick(body_input_a) * 0.18;
            let body_b =
                self.body_b.tick(body_input_b) + self.body_tail_b.tick(body_input_b) * 0.18;
            let body_gain = p[LOW_BODY] * (1.7 + load * 1.8);
            exhaust_a += body_a * body_gain;
            exhaust_b += body_b * body_gain;
            self.exhaust_low_a += (exhaust_a - self.exhaust_low_a) * self.muffler_smoothing;
            self.exhaust_low_b += (exhaust_b - self.exhaust_low_b) * self.muffler_smoothing;
            exhaust_a += (self.exhaust_low_a - exhaust_a) * p[MUFFLER] * 0.78;
            exhaust_b += (self.exhaust_low_b - exhaust_b) * p[MUFFLER] * 0.78;
            let exhaust_mid = (exhaust_a + exhaust_b) * (1.0 - p[BANK_PRESENCE] * 0.22);
            let exhaust_side = (exhaust_a - exhaust_b) * p[WIDTH] * 0.54 * p[BANK_PRESENCE];
            let pulse_sum = bank_a + bank_b;
            let intake_input = -intake_pulse_sum * (0.15 + throttle * 0.65)
                + if physical {
                    self.noise_low * self.physical_flow_amplitude * 0.55
                } else {
                    self.noise_low * throttle * load * 0.15
                }
                + high_noise * intake_pulse_sum.abs() * throttle * detail * 0.045;
            let intake = self.intake.tick(intake_input);
            self.intake_low += (intake - self.intake_low) * self.intake_low_coefficient;
            let intake_sound = (intake - self.intake_low * 0.6) * (0.3 + throttle * 0.7);
            let mechanical = (crank_order1 * p[BALANCE]
                + crank_order2 * 0.24
                + (crank_phase * self.active_cylinders as f64 * 0.5).sin() * 0.13)
                * (0.025 + rpm_fraction * 0.07)
                + high_noise * (0.007 + rpm_fraction * 0.025) * (0.3 + pulse_sum)
                + (if physical { 0.0 } else { p[ROUGHNESS] })
                    * (high_noise * crank_order2.abs() * (0.006 + load * 0.026)
                        + (noise - self.noise_low) * pulse_sum * load * 0.12);
            let whistle_hz =
                (sr * 0.3).min(1100.0 + self.spool * (5200.0 - p[TURBO_SIZE] * 1700.0));
            self.turbo_phase += whistle_hz / sr;
            if self.turbo_phase >= 1.0 {
                self.turbo_phase -= 1.0;
            }
            self.turbo_harmonic_phase += (sr * 0.42).min(whistle_hz * 1.91) / sr;
            if self.turbo_harmonic_phase >= 1.0 {
                self.turbo_harmonic_phase -= 1.0;
            }
            let physical_turbo_sound = if physical {
                boost
                    * (((TAU * self.turbo_phase).sin()
                        + (TAU * self.turbo_harmonic_phase).sin() * 0.18)
                        * 0.024
                        + high_noise * 0.075 * throttle)
                    + high_noise * self.bov_envelope * p[BOV] * boost.min(1.5) * 0.29
            } else {
                0.0
            };
            let turbo_sound = if physical {
                physical_turbo_sound
            } else {
                p[BOOST]
                    * self.spool
                    * self.spool
                    * (((TAU * self.turbo_phase).sin()
                        + (TAU * self.turbo_harmonic_phase).sin() * 0.18)
                        * 0.024
                        + high_noise * 0.075 * throttle)
                    + high_noise * self.bov_envelope * p[BOV] * p[BOOST].min(1.5) * 0.29
            };
            let common = intake_sound * p[INTAKE_GAIN] * 0.65
                + mechanical * p[MECHANICAL_GAIN]
                + turbo_sound * p[TURBO_GAIN];
            let base_l = (exhaust_mid + exhaust_side) * p[EXHAUST_GAIN] + common;
            let base_r = (exhaust_mid - exhaust_side) * p[EXHAUST_GAIN] + common;
            let intake_layer = intake_sound * p[INTAKE_GAIN] * 0.65;
            let mechanical_layer = mechanical * p[MECHANICAL_GAIN];
            let turbo_layer = turbo_sound * p[TURBO_GAIN];
            let engine_common = intake_layer * 1.65 + mechanical_layer * 2.25 + turbo_layer * 1.4;
            let engine_l =
                (exhaust_mid + exhaust_side * 0.55) * p[EXHAUST_GAIN] * 0.48 + engine_common;
            let engine_r =
                (exhaust_mid - exhaust_side * 0.55) * p[EXHAUST_GAIN] * 0.48 + engine_common;
            let cabin_common = intake_layer * 0.6 + mechanical_layer * 0.9 + turbo_layer * 0.45;
            let cabin_l =
                (exhaust_mid + exhaust_side * 0.18) * p[EXHAUST_GAIN] * 0.64 + cabin_common;
            let cabin_r =
                (exhaust_mid - exhaust_side * 0.18) * p[EXHAUST_GAIN] * 0.64 + cabin_common;
            self.cabin_low_l += (cabin_l - self.cabin_low_l) * self.cabin_coefficient;
            self.cabin_low_r += (cabin_r - self.cabin_low_r) * self.cabin_coefficient;
            self.cabin_low2_l += (self.cabin_low_l - self.cabin_low2_l) * self.cabin_coefficient;
            self.cabin_low2_r += (self.cabin_low_r - self.cabin_low2_r) * self.cabin_coefficient;
            let structure = self
                .cabin_structure
                .tick(mechanical_layer * 2.5 + (body_a + body_b) * p[EXHAUST_GAIN] * 0.1)
                * 0.48;
            let road_common = intake_layer * 0.35 + mechanical_layer * 0.22 + turbo_layer * 0.4;
            let road_l = (exhaust_mid + exhaust_side * 0.2) * p[EXHAUST_GAIN] * 0.55 + road_common;
            let road_r = (exhaust_mid - exhaust_side * 0.2) * p[EXHAUST_GAIN] * 0.55 + road_common;
            self.air_low_l += (road_l - self.air_low_l) * self.air_coefficient;
            self.air_low_r += (road_r - self.air_low_r) * self.air_coefficient;
            let gain = self.running_gain * 1.12;
            let input_l = (base_l
                + (engine_l - base_l) * p[ENGINE_VIEW]
                + (self.cabin_low2_l + structure - base_l) * p[CABIN_VIEW]
                + (self.air_low_l * 0.65 - base_l) * p[ROADSIDE_VIEW])
                * gain;
            let input_r = (base_r
                + (engine_r - base_r) * p[ENGINE_VIEW]
                + (self.cabin_low2_r + structure - base_r) * p[CABIN_VIEW]
                + (self.air_low_r * 0.65 - base_r) * p[ROADSIDE_VIEW])
                * gain;
            let dc_l = input_l - self.dc_in_l + self.dc_coefficient * self.dc_out_l;
            let dc_r = input_r - self.dc_in_r + self.dc_coefficient * self.dc_out_r;
            self.dc_in_l = input_l;
            self.dc_in_r = input_r;
            self.dc_out_l = dc_l;
            self.dc_out_r = dc_r;
            let output_l = dc_l / (1.0 + dc_l * dc_l).sqrt();
            let output_r = dc_r / (1.0 + dc_r * dc_r).sqrt();
            left[frame] = output_l as f32;
            right[frame] = output_r as f32;
            self.peak = output_l
                .abs()
                .max(output_r.abs())
                .max(self.peak * (1.0 - dt * 3.0));
        }
        left[frames..].fill(0.0);
        right[frames..].fill(0.0);
    }
}
