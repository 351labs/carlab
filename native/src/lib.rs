//! Portable engine-lab computation: native Rust and browser WebAssembly share
//! the same solvers and DSP. The JSON boundary is versioned; audio blocks use
//! a separate planar-f32 ABI so the sample loop never crosses through JSON.
pub mod config;
pub mod cylinder_cycle;
pub mod dsp;
pub mod ecu;
pub mod ecu_calibration;
pub mod gas_path;
pub mod gas_properties;
pub mod maps;
pub mod materials;
pub mod powertrain;
pub mod thermal;

use config::{EngineConfig, EngineState};
use dsp::EngineDsp;
use powertrain::{PhysicalConfig, Powertrain};
use serde::Serialize;
use serde_json::{Value, json};
use std::collections::BTreeMap;

pub const API_VERSION: u32 = 1;
pub const MODEL_VERSION: &str = "carlab-engine-lab-rust-3";
pub const MAX_AUDIO_FRAMES: usize = 16384;
const MAX_HANDLES: usize = 128;

struct EcuSession {
    controller: ecu::Ecu,
    engine: EngineConfig,
}
struct SynthSession {
    dsp: EngineDsp,
    control: EngineState,
    /// Configuration fallback used only when physical control is first enabled.
    fallback_exhaust_temperature_k: f64,
}
impl SynthSession {
    fn sync_numeric_targets(&mut self) {
        let (rpm, load, throttle) = self.dsp.get_control_targets();
        self.control.rpm = rpm;
        self.control.load = load;
        self.control.throttle = throttle;
    }
}
/// Handles belong to one Runtime/wasm instance. Drop releases all owned models
/// and buffers; destroy explicitly releases an individual long-lived instance.
#[derive(Default)]
pub struct Runtime {
    next_handle: u32,
    powertrains: BTreeMap<u32, Powertrain>,
    synths: BTreeMap<u32, SynthSession>,
    ecus: BTreeMap<u32, EcuSession>,
    audio: Vec<f32>,
}
fn value<T: Serialize>(v: T) -> Result<Value, String> {
    serde_json::to_value(v).map_err(|e| e.to_string())
}
fn get<'a>(v: &'a Value, key: &str) -> &'a Value {
    v.get(key).unwrap_or(&Value::Null)
}
fn number(v: &Value, key: &str, default: f64) -> Result<f64, String> {
    match v.get(key) {
        None => Ok(default),
        Some(x) => x
            .as_f64()
            .filter(|x| x.is_finite())
            .ok_or_else(|| format!("{key} must be finite")),
    }
}
fn uint(v: &Value, key: &str, default: usize, max: usize) -> Result<usize, String> {
    let n = number(v, key, default as f64)?;
    if n < 0. || n.fract() != 0. || n > max as f64 {
        return Err(format!("{key} must be an integer in 0..{max}"));
    }
    Ok(n as usize)
}
fn engine(v: &Value) -> Result<EngineConfig, String> {
    EngineConfig::from_value(
        v.get("engine")
            .or_else(|| v.get("config"))
            .unwrap_or(&Value::Null),
    )
}
fn physical(v: &Value, e: &EngineConfig) -> Result<PhysicalConfig, String> {
    PhysicalConfig::from_value(e, get(v, "physical"))
}
fn boundary_override(
    request: &Value,
    e: &EngineConfig,
    p: &PhysicalConfig,
) -> Result<Option<powertrain::GasPathBoundary>, String> {
    let Some(input) = request.get("override").or_else(|| request.get("boundary")) else {
        return Ok(None);
    };
    if input.is_null() {
        return Ok(None);
    };
    let obj = input.as_object().ok_or("override must be an object")?;
    if obj.keys().any(|k| {
        !matches!(
            k.as_str(),
            "intakePressurePa" | "intakeTemperatureK" | "exhaustPressurePa" | "exhaustTemperatureK"
        )
    }) {
        return Err("Unsupported gas-path override field".into());
    }
    let base = powertrain::cycle_config_for(
        e,
        p,
        number(request, "rpm", 3000.)?,
        number(request, "throttle", 0.6)?,
        None,
        number(request, "boostFraction", 1.)?,
    )?;
    Ok(Some(powertrain::GasPathBoundary {
        intake_pressure_pa: number(input, "intakePressurePa", base.intake_pressure_pa)?,
        intake_temperature_k: number(input, "intakeTemperatureK", base.intake_temperature_k)?,
        exhaust_pressure_pa: number(input, "exhaustPressurePa", base.exhaust_pressure_pa)?,
        exhaust_temperature_k: number(input, "exhaustTemperatureK", base.exhaust_temperature_k)?,
    }))
}
fn merge_object(target: &mut Value, patch: &Value) {
    if let (Some(t), Some(p)) = (target.as_object_mut(), patch.as_object()) {
        for (k, v) in p {
            t.insert(k.clone(), v.clone());
        }
    }
}
fn ecu_engine(request: &Value) -> Result<EngineConfig, String> {
    EngineConfig::from_value(get(request, "engine"))
}
/// Standalone control inputs default to the selected engine geometry, then
/// explicitly supplied sensor/operating values override those assumptions.
fn ecu_input(request: &Value, engine: &EngineConfig) -> Result<ecu::EcuInput, String> {
    let patch = get(request, "input");
    if !patch.is_object() && !patch.is_null() {
        return Err("ECU input must be an object".into());
    }
    let mut input = value(ecu::EcuInput {
        cylinders: engine.cylinders,
        displacement_l: engine.displacement,
        ..ecu::EcuInput::default()
    })?;
    merge_object(&mut input, patch);
    serde_json::from_value(input).map_err(|e| format!("Invalid ECU input: {e}"))
}
/// Reject axes from another combustion mode before deserialization can erase
/// whether a caller explicitly supplied legacy defaults. Null inactive fields
/// are tolerated so mode-aware result manifests remain replayable.
pub fn validate_ecu_search_axes(physical: &PhysicalConfig, options: &Value) -> Result<(), String> {
    if options.is_null() {
        return Ok(());
    }
    let options = options
        .as_object()
        .ok_or("ECU search options must be an object")?;
    let config = value(&physical.ecu)?;
    let diesel =
        config.get("combustionMode").and_then(Value::as_str) == Some("directInjectionDiesel");
    let invalid: &[&str] = if diesel {
        &["lambdaBounds", "sparkBounds", "lambdaSteps", "sparkSteps"]
    } else {
        &[
            "dieselQuantityMinMg",
            "dieselQuantityMaxMg",
            "injectionAdvanceMinDeg",
            "injectionAdvanceMaxDeg",
            "dieselQuantitySteps",
            "injectionAdvanceSteps",
        ]
    };
    if let Some(key) = invalid
        .iter()
        .find(|key| options.get(**key).is_some_and(|value| !value.is_null()))
    {
        return Err(format!(
            "Search option {key} does not belong to the selected combustion mode"
        ));
    }
    Ok(())
}
impl Runtime {
    pub fn new() -> Self {
        Self::default()
    }
    fn allocate_handle(&mut self) -> Result<u32, String> {
        if self.powertrains.len() + self.synths.len() + self.ecus.len() >= MAX_HANDLES {
            return Err("Too many live instances; destroy unused handles".into());
        }
        self.next_handle = self
            .next_handle
            .checked_add(1)
            .ok_or("Handle space exhausted")?;
        Ok(self.next_handle)
    }
    /// Dispatches one complete control/analysis operation. High-rate audio callers
    /// should use process_audio rather than serializing sample arrays through JSON.
    pub fn dispatch(&mut self, request: &Value) -> Result<Value, String> {
        if !request.is_object() {
            return Err("Request must be a JSON object".into());
        }
        if let Some(v) = request.get("apiVersion") {
            if v.as_u64() != Some(API_VERSION as u64) {
                return Err("Unsupported engine-lab API version".into());
            }
        }
        let op = request
            .get("op")
            .and_then(Value::as_str)
            .ok_or("Request requires an op")?;
        let handle = || uint(request, "handle", 0, u32::MAX as usize).map(|n| n as u32);
        match op {
            "version" => Ok(
                json!({"apiVersion":API_VERSION,"modelVersion":MODEL_VERSION,"backend":"rust","audioLayout":"planar-f32","maxAudioFrames":MAX_AUDIO_FRAMES}),
            ),
            "normalizeConfig" | "normalizeEngineConfig" => value(engine(request)?),
            "normalizePhysical" | "normalizePhysicalConfig" => {
                let e = engine(request)?;
                value(physical(request, &e)?)
            }
            "geometry" | "engineGeometry" => {
                let e = engine(request)?;
                let p = physical(request, &e)?;
                value(powertrain::engine_geometry(&e, &p))
            }
            "cycle" => {
                let c = cylinder_cycle::CylinderCycleConfig::from_value(get(request, "config"))?;
                value(cylinder_cycle::solve_cylinder_cycle(&c)?)
            }
            "cycleConfig" | "cycleConfigFor" => {
                let e = engine(request)?;
                let p = physical(request, &e)?;
                value(powertrain::cycle_config_for(
                    &e,
                    &p,
                    number(request, "rpm", 3000.)?,
                    number(request, "throttle", 0.6)?,
                    boundary_override(request, &e, &p)?.as_ref(),
                    number(request, "boostFraction", 1.)?,
                )?)
            }
            "getCylinderCycle" => {
                let e = engine(request)?;
                let p = physical(request, &e)?;
                value(powertrain::get_cylinder_cycle(
                    &e,
                    &p,
                    number(request, "rpm", 3000.)?,
                    number(request, "throttle", 0.6)?,
                    boundary_override(request, &e, &p)?.as_ref(),
                    number(request, "boostFraction", 1.)?,
                )?)
            }
            "evaluate" | "evaluateEngine" => {
                let e = engine(request)?;
                let p = physical(request, &e)?;
                // Optional fixed boundary: static measured-condition evaluation.
                value(powertrain::evaluate_engine_at_boundary(
                    &e,
                    &p,
                    number(request, "rpm", 3000.)?,
                    number(request, "throttle", 1.)?,
                    number(request, "boostFraction", 1.)?,
                    boundary_override(request, &e, &p)?.as_ref(),
                )?)
            }
            "sparkToSocFromCa10Delay" => value(cylinder_cycle::spark_to_soc_from_ca10_delay(
                number(request, "sparkToCa10Deg", 0.)?,
                number(request, "burnDurationDeg", 50.)?,
                number(request, "wiebeEfficiency", 6.9)?,
                number(request, "wiebeShape", 2.)?,
            )),
            "potential" | "potentialEnvelope" => {
                let e = engine(request)?;
                let p = physical(request, &e)?;
                value(powertrain::potential_envelope(
                    &e,
                    &p,
                    uint(request, "samples", 64, 256)?,
                )?)
            }
            "normalizeThermal" | "normalizeThermalConfig" => {
                value(thermal::normalize_thermal_config(get(request, "config")))
            }
            "normalizeMaterialScreen" | "normalizeMaterialScreenConfig" => value(
                materials::normalize_material_screen_config(get(request, "config"))?,
            ),
            "parseMaterialCard" => value(materials::parse_material_card(get(request, "card"))?),
            "material" | "screenMaterial" => {
                let input: materials::MechanicalCycleInput =
                    serde_json::from_value(get(request, "input").clone())
                        .map_err(|e| e.to_string())?;
                let screen = materials::normalize_material_screen_config(get(request, "config"))?;
                value(materials::screen_material(&input, &screen)?)
            }
            "normalizeMap" => {
                let kind = map_kind(request.get("kind").and_then(Value::as_str).unwrap_or("ve"))?;
                value(maps::normalize_calibration_map(get(request, "map"), kind)?)
            }
            "sampleMap" => {
                let source = get(request, "map");
                let kind = map_kind(source.get("kind").and_then(Value::as_str).unwrap_or("ve"))?;
                let m = maps::normalize_calibration_map(source, kind)?;
                value(maps::sample_calibration_map(
                    &m,
                    number(request, "rpm", 3000.)?,
                    number(request, "pressureBar", 1.)?,
                )?)
            }
            "assumedVeMap" | "createAssumedVeMap" => value(maps::create_assumed_ve_map(
                number(request, "idleRpm", 850.)?,
                number(request, "redlineRpm", 7200.)?,
                number(request, "baseVe", 0.9)?,
                request.get("mode").and_then(Value::as_str) == Some("uniform"),
            )?),
            "parseCalibrationBundle" => {
                value(maps::parse_calibration_bundle(get(request, "bundle"))?)
            }
            "normalizeEcuMap" => {
                let kind: ecu::EcuMapKind = serde_json::from_value(get(request, "kind").clone())
                    .map_err(|e| format!("Invalid ECU map kind: {e}"))?;
                value(ecu::normalize_ecu_map(get(request, "map"), kind)?)
            }
            "sampleEcuMap" => {
                let raw = get(request, "map");
                let kind: ecu::EcuMapKind = serde_json::from_value(get(raw, "kind").clone())
                    .map_err(|e| format!("Invalid ECU map kind: {e}"))?;
                let map = ecu::normalize_ecu_map(raw, kind)?;
                let pressure = if request.get("mapPressureBar").is_some() {
                    number(request, "mapPressureBar", 1.)?
                } else {
                    number(request, "pressureBar", 1.)?
                };
                value(ecu::sample_ecu_map(
                    &map,
                    number(request, "rpm", 3000.)?,
                    pressure,
                )?)
            }
            "fuelBlendProperties" => {
                let config: ecu::FuelBlendConfig =
                    serde_json::from_value(get(request, "config").clone())
                        .map_err(|e| format!("Invalid fuel blend configuration: {e}"))?;
                value(ecu::fuel_blend_properties(&config)?)
            }
            "injectorDelivery" => {
                let config: ecu::InjectorConfig =
                    serde_json::from_value(get(request, "config").clone())
                        .map_err(|e| format!("Invalid injector configuration: {e}"))?;
                let input: ecu::InjectorInput =
                    serde_json::from_value(get(request, "input").clone())
                        .map_err(|e| format!("Invalid injector input: {e}"))?;
                value(ecu::injector_delivery(&config, &input)?)
            }
            "normalizeEcuConfig" => {
                let e = ecu_engine(request)?;
                value(ecu::EcuConfig::from_value(&e, get(request, "config"))?)
            }
            "evaluateEcuSteady" => {
                let e = ecu_engine(request)?;
                let config = ecu::EcuConfig::from_value(&e, get(request, "config"))?;
                let input = ecu_input(request, &e)?;
                value(ecu::evaluate_ecu_steady(&e, &config, &input)?)
            }
            "createEcu" | "createEcuSession" => {
                let e = ecu_engine(request)?;
                let config = ecu::EcuConfig::from_value(&e, get(request, "config"))?;
                let h = self.allocate_handle()?;
                self.ecus.insert(
                    h,
                    EcuSession {
                        controller: ecu::Ecu::new(config),
                        engine: e,
                    },
                );
                Ok(json!({"handle":h}))
            }
            "setEcuConfig" | "setEcuConfigAndReset" => {
                let h = handle()?;
                let session = self.ecus.get_mut(&h).ok_or("Unknown ECU handle")?;
                let e = if request.get("engine").is_some() {
                    ecu_engine(request)?
                } else {
                    session.engine.clone()
                };
                let config = ecu::EcuConfig::from_value(&e, get(request, "config"))?;
                if op == "setEcuConfigAndReset"
                    || request
                        .get("reset")
                        .and_then(Value::as_bool)
                        .unwrap_or(false)
                {
                    session.controller.set_config_and_reset(config)?;
                } else {
                    session.controller.set_config(config)?;
                }
                session.engine = e;
                value(session.controller.get_state())
            }
            "resetEcu" => {
                let session = self.ecus.get_mut(&handle()?).ok_or("Unknown ECU handle")?;
                session.controller.reset();
                value(session.controller.get_state())
            }
            "getEcuState" | "ecuState" => value(
                self.ecus
                    .get(&handle()?)
                    .ok_or("Unknown ECU handle")?
                    .controller
                    .get_state(),
            ),
            "stepEcu" | "stepEcuMany" => {
                let dt = number(request, "dt", 1. / 240.)?;
                if dt < 0. || dt > 0.25 || (op == "stepEcuMany" && dt == 0.) {
                    return Err(
                        "ECU dt must be in [0,0.25]; batched steps require positive dt".into(),
                    );
                }
                let steps = if op == "stepEcuMany" {
                    uint(request, "steps", 1, 100000)?
                } else {
                    1
                };
                let session = self.ecus.get_mut(&handle()?).ok_or("Unknown ECU handle")?;
                let input = ecu_input(request, &session.engine)?;
                let mut state = session.controller.get_state();
                if dt > 0. {
                    for _ in 0..steps {
                        state = session.controller.step(dt, &input)?;
                    }
                }
                value(state)
            }
            "fitEcuFuelMap" => {
                let e = ecu_engine(request)?;
                let config = ecu::EcuConfig::from_value(&e, get(request, "config"))?;
                let observations: Vec<ecu_calibration::EcuLambdaObservation> =
                    serde_json::from_value(get(request, "observations").clone())
                        .map_err(|e| format!("Invalid ECU observations: {e}"))?;
                let options: ecu_calibration::EcuFitOptions = if get(request, "options").is_null() {
                    Default::default()
                } else {
                    serde_json::from_value(get(request, "options").clone())
                        .map_err(|e| format!("Invalid ECU fit options: {e}"))?
                };
                value(ecu_calibration::fit_ecu_fuel_map(
                    &e,
                    &config,
                    &observations,
                    &options,
                )?)
            }
            "searchEcuOperatingPoint" => {
                let e = ecu_engine(request)?;
                let p = physical(request, &e)?;
                validate_ecu_search_axes(&p, get(request, "options"))?;
                let options: ecu_calibration::EcuSearchOptions =
                    if get(request, "options").is_null() {
                        Default::default()
                    } else {
                        serde_json::from_value(get(request, "options").clone())
                            .map_err(|e| format!("Invalid ECU search options: {e}"))?
                    };
                value(ecu_calibration::search_ecu_operating_point(
                    &e,
                    &p,
                    number(request, "rpm", 3000.)?,
                    number(request, "throttle", 0.65)?,
                    &options,
                )?)
            }
            "createPowertrain" => {
                let e = engine(request)?;
                let p = physical(request, &e)?;
                let model = Powertrain::new(e, p)?;
                let h = self.allocate_handle()?;
                self.powertrains.insert(h, model);
                Ok(json!({"handle":h}))
            }
            "setPowertrainConfigAndReset" => {
                let h = handle()?;
                if !self.powertrains.contains_key(&h) {
                    return Err("Unknown powertrain handle".into());
                }
                let e = engine(request)?;
                let p = physical(request, &e)?;
                // Validate/construct before replacing the live instance. An
                // invalid reset request leaves the existing plant untouched.
                let replacement = Powertrain::new(e, p)?;
                let state = replacement.get_state();
                self.powertrains.insert(h, replacement);
                value(state)
            }
            "setPowertrainConfig" => {
                let e = engine(request)?;
                let p = physical(request, &e)?;
                let model = self
                    .powertrains
                    .get_mut(&handle()?)
                    .ok_or("Unknown powertrain handle")?;
                model.set_config(e, p)?;
                value(model.get_state())
            }
            "resetPowertrain" => {
                let model = self
                    .powertrains
                    .get_mut(&handle()?)
                    .ok_or("Unknown powertrain handle")?;
                let state = get(request, "state");
                let rpm = state
                    .get("rpm")
                    .or_else(|| request.get("rpm"))
                    .and_then(Value::as_f64);
                let speed = state
                    .get("speedMs")
                    .or_else(|| request.get("speedMs"))
                    .and_then(Value::as_f64);
                value(model.reset(rpm, speed)?)
            }
            "powertrainEstimate" | "powertrainOperatingEstimate" => value(
                self.powertrains
                    .get(&handle()?)
                    .ok_or("Unknown powertrain handle")?
                    .get_operating_estimate(),
            ),
            "powertrainState" => value(
                self.powertrains
                    .get(&handle()?)
                    .ok_or("Unknown powertrain handle")?
                    .get_state(),
            ),
            "stepPowertrain" | "stepPowertrainMany" => {
                let dt = number(request, "dt", 1. / 240.)?;
                if dt < 0. || dt > 0.25 || (op == "stepPowertrainMany" && dt == 0.) {
                    return Err(
                        "dt must be in [0, 0.25] seconds; batched steps require a positive dt"
                            .into(),
                    );
                }
                let steps = if op == "stepPowertrainMany" {
                    uint(request, "steps", 1, 100000)?
                } else {
                    1
                };
                let throttle = number(request, "throttle", 0.65)?;
                let brake = number(request, "brake", 0.)?;
                let gear = uint(request, "gear", 1, 8)?;
                let model = self
                    .powertrains
                    .get_mut(&handle()?)
                    .ok_or("Unknown powertrain handle")?;
                let mut state = model.get_state();
                for _ in 0..steps {
                    state = model.step(dt, throttle, brake, gear)?;
                }
                value(state)
            }
            "createDsp" => {
                let e = engine(request)?;
                let sr = number(request, "sampleRate", 48000.)?;
                if !(8000. ..=192000.).contains(&sr) {
                    return Err("sampleRate must be in 8000..192000 Hz".into());
                }
                let fallback_exhaust_temperature_k = e.temperature + 273.15;
                let dsp = EngineDsp::new(sr, e);
                let (rpm, load, throttle) = dsp.get_control_targets();
                let control = EngineState {
                    rpm,
                    load,
                    throttle,
                    physical: None,
                };
                let h = self.allocate_handle()?;
                // Preallocate the maximum shared block before an audio callback begins.
                if self.audio.capacity() < MAX_AUDIO_FRAMES * 2 {
                    self.audio
                        .reserve_exact(MAX_AUDIO_FRAMES * 2 - self.audio.len());
                }
                self.synths.insert(
                    h,
                    SynthSession {
                        dsp,
                        control,
                        fallback_exhaust_temperature_k,
                    },
                );
                Ok(json!({"handle":h}))
            }
            "setDspConfig" => {
                let e = engine(request)?;
                let session = self
                    .synths
                    .get_mut(&handle()?)
                    .ok_or("Unknown DSP handle")?;
                session.dsp.set_config(&e);
                session.fallback_exhaust_temperature_k = e.temperature + 273.15;
                session.sync_numeric_targets();
                Ok(Value::Null)
            }
            "setDspState" => {
                let session = self
                    .synths
                    .get_mut(&handle()?)
                    .ok_or("Unknown DSP handle")?;
                let patch = get(request, "state");
                if !patch.is_object() {
                    return Err("state must be an object".into());
                }
                let mut merged = value(&session.control)?;
                let old_physical = merged.get("physical").cloned().unwrap_or(Value::Null);
                merge_object(&mut merged, patch);
                if let Some(p) = patch.get("physical") {
                    if p.is_object() {
                        let mut base = if old_physical.is_object() {
                            old_physical
                        } else {
                            value(config::PhysicalAudioState {
                                exhaust_temperature_k: session.fallback_exhaust_temperature_k,
                                ..config::PhysicalAudioState::default()
                            })?
                        };
                        merge_object(&mut base, p);
                        merged["physical"] = base;
                    }
                }
                let actual = request
                    .get("actualRpm")
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                if !actual {
                    merged["physical"] = Value::Null;
                }
                let state: EngineState =
                    serde_json::from_value(merged).map_err(|e| e.to_string())?;
                session.dsp.set_state(&state, actual);
                session.control = state;
                session.sync_numeric_targets();
                Ok(Value::Null)
            }
            "triggerDsp" => {
                let kind = request
                    .get("kind")
                    .and_then(Value::as_str)
                    .ok_or("kind is required")?;
                if !matches!(kind, "start" | "stop" | "shift" | "blip") {
                    return Err("Unsupported DSP trigger".into());
                }
                let session = self
                    .synths
                    .get_mut(&handle()?)
                    .ok_or("Unknown DSP handle")?;
                session.dsp.trigger(kind);
                // Triggers may change control targets internally. Capture the
                // actual targets without sampling smoothed output telemetry.
                session.sync_numeric_targets();
                Ok(Value::Null)
            }
            "dspCharacterTelemetry" => value(
                self.synths
                    .get(&handle()?)
                    .ok_or("Unknown DSP handle")?
                    .dsp
                    .get_character_telemetry(),
            ),
            "dspPulseTelemetry" => value(
                self.synths
                    .get(&handle()?)
                    .ok_or("Unknown DSP handle")?
                    .dsp
                    .get_pulse_diagnostics(),
            ),
            "dspTelemetry" => {
                let d = &self.synths.get(&handle()?).ok_or("Unknown DSP handle")?.dsp;
                let mut v = value(d.get_telemetry())?;
                v["character"] = value(d.get_character_telemetry())?;
                v["pulse"] = value(d.get_pulse_diagnostics())?;
                Ok(v)
            }
            "destroy" => {
                let h = handle()?;
                let removed = self.synths.remove(&h).is_some()
                    || self.powertrains.remove(&h).is_some()
                    || self.ecus.remove(&h).is_some();
                if !removed {
                    return Err("Unknown instance handle".into());
                }
                Ok(Value::Null)
            }
            _ => Err(format!("Unknown engine-lab operation: {op}")),
        }
    }
    /// Reuses one output allocation per runtime. The returned planar slice is
    /// invalidated by the next process_audio call or runtime destruction.
    pub fn process_audio(&mut self, handle: u32, frames: usize) -> Result<&[f32], String> {
        if frames == 0 || frames > MAX_AUDIO_FRAMES {
            return Err(format!("frames must be in 1..{MAX_AUDIO_FRAMES}"));
        }
        let session = self.synths.get_mut(&handle).ok_or("Unknown DSP handle")?;
        self.audio.resize(frames * 2, 0.);
        let (left, right) = self.audio.split_at_mut(frames);
        session.dsp.process(left, right);
        if self.audio.iter().any(|x| !x.is_finite()) {
            return Err("DSP produced nonfinite samples".into());
        }
        Ok(&self.audio)
    }
    pub fn envelope(&mut self, request: &Value) -> Value {
        match self.dispatch(request) {
            Ok(result) => json!({"apiVersion":API_VERSION,"ok":true,"result":result}),
            Err(error) => json!({"apiVersion":API_VERSION,"ok":false,"error":error}),
        }
    }
}
fn map_kind(kind: &str) -> Result<maps::CalibrationKind, String> {
    match kind {
        "ve" => Ok(maps::CalibrationKind::Ve),
        "indicatedEfficiency" => Ok(maps::CalibrationKind::IndicatedEfficiency),
        "fmep" => Ok(maps::CalibrationKind::Fmep),
        _ => Err("Unsupported calibration map kind".into()),
    }
}

#[cfg(target_arch = "wasm32")]
mod wasm_abi {
    use super::*;
    use std::cell::RefCell;
    thread_local! {static RUNTIME:RefCell<Runtime>=RefCell::new(Runtime::new());static RESULT:RefCell<Vec<u8>>=const{RefCell::new(Vec::new())};static AUDIO_LEN:RefCell<u32>=const{RefCell::new(0)};}
    fn save_result(v: Value) -> u32 {
        RESULT.with(|r| {
            let mut out = r.borrow_mut();
            *out = serde_json::to_vec(&v).unwrap_or_else(|_| {
                b"{\"apiVersion\":1,\"ok\":false,\"error\":\"Serialization failed\"}".to_vec()
            });
            out.as_ptr() as u32
        })
    }
    #[unsafe(no_mangle)]
    pub extern "C" fn engine_lab_alloc(len: u32) -> u32 {
        if len == 0 || len > 4_000_000 {
            return 0;
        }
        let buffer = vec![0u8; len as usize].into_boxed_slice();
        Box::into_raw(buffer) as *mut u8 as u32
    }
    /// Only free the exact pointer/length returned by engine_lab_alloc. Result and
    /// audio pointers are borrowed and MUST NOT be passed to this function.
    #[unsafe(no_mangle)]
    pub unsafe extern "C" fn engine_lab_free(ptr: u32, len: u32) {
        if ptr != 0 && len > 0 {
            unsafe {
                drop(Box::from_raw(std::ptr::slice_from_raw_parts_mut(
                    ptr as *mut u8,
                    len as usize,
                )));
            }
        }
    }
    #[unsafe(no_mangle)]
    pub extern "C" fn engine_lab_request(ptr: u32, len: u32) -> u32 {
        let memory_bytes = core::arch::wasm32::memory_size(0) * 65536;
        let request = if ptr == 0
            || len == 0
            || len > 4_000_000
            || (ptr as usize)
                .checked_add(len as usize)
                .is_none_or(|end| end > memory_bytes)
        {
            Err("Invalid request buffer".to_string())
        } else {
            serde_json::from_slice::<Value>(unsafe {
                std::slice::from_raw_parts(ptr as *const u8, len as usize)
            })
            .map_err(|e| format!("Invalid request JSON: {e}"))
        };
        let response = match request {
            Ok(v) => RUNTIME.with(|r| r.borrow_mut().envelope(&v)),
            Err(error) => json!({"apiVersion":API_VERSION,"ok":false,"error":error}),
        };
        save_result(response)
    }
    #[unsafe(no_mangle)]
    pub extern "C" fn engine_lab_result_ptr() -> u32 {
        RESULT.with(|r| r.borrow().as_ptr() as u32)
    }
    #[unsafe(no_mangle)]
    pub extern "C" fn engine_lab_result_len() -> u32 {
        RESULT.with(|r| r.borrow().len() as u32)
    }
    #[unsafe(no_mangle)]
    pub extern "C" fn engine_lab_dsp_process(handle: u32, frames: u32) -> u32 {
        RUNTIME.with(|r| {
            let mut rt = r.borrow_mut();
            match rt.process_audio(handle, frames as usize) {
                Ok(audio) => {
                    AUDIO_LEN.with(|l| *l.borrow_mut() = audio.len() as u32);
                    audio.as_ptr() as u32
                }
                Err(error) => {
                    AUDIO_LEN.with(|l| *l.borrow_mut() = 0);
                    save_result(json!({"apiVersion":API_VERSION,"ok":false,"error":error}));
                    0
                }
            }
        })
    }
    #[unsafe(no_mangle)]
    pub extern "C" fn engine_lab_audio_len() -> u32 {
        AUDIO_LEN.with(|l| *l.borrow())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn request_errors_are_explicit_and_versioned() {
        let mut r = Runtime::new();
        let e = r.envelope(&json!({"op":"unknown"}));
        assert_eq!(e["ok"], false);
        assert_eq!(e["apiVersion"], 1);
        assert!(
            r.dispatch(&json!({"op":"version","apiVersion":99}))
                .is_err()
        );
    }
    #[test]
    fn handles_are_owned_destroyable_and_never_reused() {
        let mut r = Runtime::new();
        let a = r.dispatch(&json!({"op":"createDsp"})).unwrap()["handle"]
            .as_u64()
            .unwrap();
        r.dispatch(&json!({"op":"destroy","handle":a})).unwrap();
        assert!(r.process_audio(a as u32, 128).is_err());
        let b = r.dispatch(&json!({"op":"createDsp"})).unwrap()["handle"]
            .as_u64()
            .unwrap();
        assert!(b > a);
        assert!(r.process_audio(b as u32, 0).is_err());
        assert_eq!(r.process_audio(b as u32, 128).unwrap().len(), 256);
    }
    #[test]
    fn partial_gas_overrides_preserve_unsupplied_boundaries() {
        let mut r = Runtime::new();
        let base = r
            .dispatch(&json!({"op":"cycleConfig","rpm":3000,"throttle":0.6}))
            .unwrap();
        let changed=r.dispatch(&json!({"op":"cycleConfig","rpm":3000,"throttle":0.6,"override":{"exhaustPressurePa":220000}})).unwrap();
        assert_eq!(changed["exhaustPressurePa"], 220000.);
        assert_eq!(changed["intakePressurePa"], base["intakePressurePa"]);
        assert_eq!(changed["intakeTemperatureK"], base["intakeTemperatureK"]);
        assert!(
            r.dispatch(&json!({"op":"cycleConfig","override":{"exhaustPressureBar":2.2}}))
                .is_err()
        );
    }
    #[test]
    fn a_zero_single_step_is_a_noop_but_batched_integration_requires_time() {
        let mut r = Runtime::new();
        let h = r.dispatch(&json!({"op":"createPowertrain"})).unwrap()["handle"].clone();
        let before = r
            .dispatch(&json!({"op":"powertrainState","handle":h}))
            .unwrap();
        let after = r
            .dispatch(&json!({"op":"stepPowertrain","handle":h,"dt":0}))
            .unwrap();
        assert_eq!(before, after);
        assert!(
            r.dispatch(&json!({"op":"stepPowertrainMany","handle":h,"dt":0,"steps":5}))
                .is_err()
        );
    }
    #[test]
    fn partial_dsp_state_keeps_physical_targets_until_explicitly_cleared() {
        let mut r = Runtime::new();
        let h = r.dispatch(&json!({"op":"createDsp"})).unwrap()["handle"].clone();
        r.dispatch(&json!({"op":"setDspState","handle":h,"actualRpm":true,"state":{"rpm":3000,"physical":{"boostBar":0.7,"exhaustMassFlowKgs":0.08}}})).unwrap();
        r.dispatch(&json!({"op":"setDspState","handle":h,"actualRpm":true,"state":{"load":0.8}}))
            .unwrap();
        let t = r
            .dispatch(&json!({"op":"dspTelemetry","handle":h}))
            .unwrap();
        assert_eq!(t["physical"]["boostBar"], 0.7);
        r.dispatch(
            &json!({"op":"setDspState","handle":h,"actualRpm":true,"state":{"physical":null}}),
        )
        .unwrap();
        assert!(
            r.dispatch(&json!({"op":"dspTelemetry","handle":h}))
                .unwrap()["physical"]
                .is_null()
        );
    }
    #[test]
    fn first_partial_physical_state_uses_current_engine_temperature_after_clearing() {
        let mut r = Runtime::new();
        let h = r
            .dispatch(&json!({"op":"createDsp","engine":{"temperature":900}}))
            .unwrap()["handle"]
            .clone();
        let apply_partial = |r: &mut Runtime| {
            r.dispatch(&json!({"op":"setDspState","handle":h,"actualRpm":true,"state":{"physical":{"boostBar":0.2}}})).unwrap();
        };
        let temperature = |r: &mut Runtime| {
            r.dispatch(&json!({"op":"dspTelemetry","handle":h}))
                .unwrap()["physical"]["exhaustTemperatureK"]
                .as_f64()
                .unwrap()
        };
        apply_partial(&mut r);
        assert!((temperature(&mut r) - 1173.15).abs() < 1e-9);
        r.dispatch(&json!({"op":"setDspConfig","handle":h,"engine":{"temperature":300}}))
            .unwrap();
        apply_partial(&mut r);
        // An active physical target remains sticky even if acoustic config changes.
        assert!((temperature(&mut r) - 1173.15).abs() < 1e-9);
        r.dispatch(
            &json!({"op":"setDspState","handle":h,"actualRpm":true,"state":{"physical":null}}),
        )
        .unwrap();
        apply_partial(&mut r);
        assert!((temperature(&mut r) - 573.15).abs() < 1e-9);
        r.dispatch(&json!({"op":"setDspConfig","handle":h,"engine":{"temperature":800}}))
            .unwrap();
        r.dispatch(&json!({"op":"setDspState","handle":h,"actualRpm":false,"state":{"rpm":2400}}))
            .unwrap();
        apply_partial(&mut r);
        assert!((temperature(&mut r) - 1073.15).abs() < 1e-9);
    }
    #[test]
    fn partial_state_after_start_keeps_the_current_idle_target_and_cadence() {
        let mut r = Runtime::new();
        let h = r
            .dispatch(&json!({"op":"createDsp","sampleRate":12000,"engine":{"idleRpm":1200}}))
            .unwrap()["handle"]
            .as_u64()
            .unwrap();
        let restart_with_partial = |r: &mut Runtime| {
            r.dispatch(&json!({"op":"setDspState","handle":h,"actualRpm":true,"state":{"rpm":0}}))
                .unwrap();
            r.dispatch(&json!({"op":"triggerDsp","handle":h,"kind":"start"}))
                .unwrap();
            r.dispatch(
                &json!({"op":"setDspState","handle":h,"actualRpm":true,"state":{"load":0.5}}),
            )
            .unwrap();
            for _ in 0..48 {
                r.process_audio(h as u32, 128).unwrap();
            }
            r.dispatch(&json!({"op":"dspTelemetry","handle":h}))
                .unwrap()
        };
        let t = restart_with_partial(&mut r);
        assert!((t["rpm"].as_f64().unwrap() - 1200.).abs() < 1e-6);
        assert!((t["firingHz"].as_f64().unwrap() - 40.).abs() < 1e-6);
        assert!((19..=22).contains(&t["firingEvents"].as_u64().unwrap()));
        r.dispatch(&json!({"op":"setDspConfig","handle":h,"engine":{"idleRpm":1800}}))
            .unwrap();
        let changed = restart_with_partial(&mut r);
        assert!((changed["rpm"].as_f64().unwrap() - 1800.).abs() < 1e-6);
        assert!((changed["firingHz"].as_f64().unwrap() - 60.).abs() < 1e-6);
    }
    #[test]
    fn partial_control_merges_keep_dsp_clamped_targets_across_reconfiguration() {
        let mut r = Runtime::new();
        let h = r
            .dispatch(&json!({"op":"createDsp","engine":{"redline":5000}}))
            .unwrap()["handle"]
            .as_u64()
            .unwrap();
        r.dispatch(&json!({"op":"setDspState","handle":h,"actualRpm":true,"state":{"rpm":99999,"load":3,"throttle":-2}})).unwrap();
        let s = &r.synths[&(h as u32)].control;
        assert_eq!((s.rpm, s.load, s.throttle), (22000., 1., 0.));
        r.dispatch(&json!({"op":"setDspConfig","handle":h,"engine":{"redline":18000}}))
            .unwrap();
        r.dispatch(&json!({"op":"setDspState","handle":h,"actualRpm":true,"state":{"load":0.5}}))
            .unwrap();
        let s = &r.synths[&(h as u32)].control;
        assert_eq!((s.rpm, s.load, s.throttle), (22000., 0.5, 0.));
    }
    #[test]
    fn json_wire_roundtrips_4096_finite_f64_bit_patterns_exactly() {
        // Include geometric/time-step scales and IEEE extremes before exercising
        // the full finite exponent/sign space with a deterministic bit stream.
        let mut samples = vec![
            0.,
            -0.,
            1.,
            -1.,
            1. / 240.,
            0.08799999999999998,
            1.0337829709552143e-4,
            3.49238571923317e-8,
            287.05,
            f64::MIN_POSITIVE,
            -f64::MIN_POSITIVE,
            f64::MAX,
            f64::MIN,
            f64::from_bits(1),
            f64::from_bits((1u64 << 63) | 1),
        ];
        let mut bits = 0x9e3779b97f4a7c15u64;
        while samples.len() < 4096 {
            bits ^= bits << 13;
            bits ^= bits >> 7;
            bits ^= bits << 17;
            let finite_bits = if (bits >> 52) & 0x7ff == 0x7ff {
                bits ^ (1u64 << 52)
            } else {
                bits
            };
            samples.push(f64::from_bits(finite_bits));
        }
        for sample in samples {
            assert!(sample.is_finite());
            let encoded = serde_json::to_string(&sample).unwrap();
            let decoded: f64 = serde_json::from_str(&encoded).unwrap();
            assert_eq!(
                decoded.to_bits(),
                sample.to_bits(),
                "direct f64 wire: {encoded}"
            );
            let value: Value = serde_json::from_str(&encoded).unwrap();
            assert_eq!(
                value.as_f64().unwrap().to_bits(),
                sample.to_bits(),
                "Value control wire: {encoded}"
            );
        }
    }
    #[test]
    fn ecu_handles_obey_the_shared_limit_and_explicit_lifecycle() {
        let mut r = Runtime::new();
        let dsp = r.dispatch(&json!({"op":"createDsp"})).unwrap()["handle"].clone();
        let first_ecu = r.dispatch(&json!({"op":"createEcu"})).unwrap()["handle"].clone();
        let before = r
            .dispatch(&json!({"op":"getEcuState","handle":first_ecu}))
            .unwrap();
        let zero = r
            .dispatch(&json!({"op":"stepEcu","handle":first_ecu,"dt":0,"input":{}}))
            .unwrap();
        assert_eq!(zero, before);
        for _ in 2..MAX_HANDLES {
            r.dispatch(&json!({"op":"createEcu"})).unwrap();
        }
        assert!(r.dispatch(&json!({"op":"createEcu"})).is_err());
        r.dispatch(&json!({"op":"destroy","handle":first_ecu}))
            .unwrap();
        assert!(
            r.dispatch(&json!({"op":"getEcuState","handle":first_ecu}))
                .is_err()
        );
        let replacement = r.dispatch(&json!({"op":"createEcu"})).unwrap()["handle"].clone();
        let reset = r
            .dispatch(&json!({"op":"resetEcu","handle":replacement}))
            .unwrap();
        assert_eq!(reset, before);
        assert!(
            r.dispatch(&json!({"op":"dspTelemetry","handle":dsp}))
                .is_ok()
        );
    }
    #[test]
    fn raw_search_axes_cannot_cross_combustion_modes_even_at_default_values() {
        let e = EngineConfig::default();
        let si = PhysicalConfig::from_value(&e, &json!({"ecu":{"enabled":true}})).unwrap();
        let di = PhysicalConfig::from_value(
            &e,
            &json!({"ecu":{"enabled":true,"combustionMode":"directInjectionDiesel"}}),
        )
        .unwrap();
        assert!(validate_ecu_search_axes(&di, &json!({"lambdaSteps":5})).is_err());
        assert!(validate_ecu_search_axes(&di, &json!({"lambdaBounds":[0.75,1.1]})).is_err());
        assert!(validate_ecu_search_axes(&si, &json!({"dieselQuantitySteps":5})).is_err());
        assert!(validate_ecu_search_axes(&si, &json!({"dieselQuantitySteps":null})).is_ok());
        assert!(
            validate_ecu_search_axes(&di, &json!({"lambdaSteps":null,"dieselQuantitySteps":5}))
                .is_ok()
        );
    }
    #[test]
    fn explicit_ecu_mode_reset_discards_film_while_ordinary_reconfiguration_rejects_it() {
        let mut r = Runtime::new();
        let h = r
            .dispatch(&json!({"op":"createEcu","config":{"enabled":true}}))
            .unwrap()["handle"]
            .clone();
        let before=r.dispatch(&json!({"op":"stepEcuMany","handle":h,"dt":0.01,"steps":10,"input":{"actualAirMassFlowKgs":0.05}})).unwrap();
        assert!(
            before["wallFilmMassKg"]
                .as_f64()
                .expect("ECU wire state includes wallFilmMassKg")
                > 1e-12
        );
        let change = json!({"op":"setEcuConfig","handle":h,"config":{"enabled":true,"combustionMode":"directInjectionDiesel"}});
        assert!(r.dispatch(&change).is_err());
        assert_eq!(
            r.dispatch(&json!({"op":"getEcuState","handle":h})).unwrap(),
            before
        );
        let reset=r.dispatch(&json!({"op":"setEcuConfigAndReset","handle":h,"config":{"enabled":true,"combustionMode":"directInjectionDiesel"}})).unwrap();
        let fresh_h=r.dispatch(&json!({"op":"createEcu","config":{"enabled":true,"combustionMode":"directInjectionDiesel"}})).unwrap()["handle"].clone();
        assert_eq!(
            reset,
            r.dispatch(&json!({"op":"getEcuState","handle":fresh_h}))
                .unwrap()
        );
    }
    #[test]
    fn explicit_powertrain_restart_is_atomic_and_matches_a_fresh_mode_instance() {
        let mut r = Runtime::new();
        let h = r.dispatch(&json!({"op":"createPowertrain"})).unwrap()["handle"].clone();
        let before=r.dispatch(&json!({"op":"stepPowertrainMany","handle":h,"dt":1./240.,"steps":80,"throttle":0.65,"gear":0})).unwrap();
        assert!(r.dispatch(&json!({"op":"setPowertrainConfigAndReset","handle":h,"physical":{"ecu":{"combustionMode":"unsupported"}}})).is_err());
        assert_eq!(
            r.dispatch(&json!({"op":"powertrainState","handle":h}))
                .unwrap(),
            before
        );
        let config = json!({"ecu":{"enabled":true,"combustionMode":"directInjectionDiesel"}});
        let reset = r
            .dispatch(&json!({"op":"setPowertrainConfigAndReset","handle":h,"physical":config}))
            .unwrap();
        let fresh_h = r
            .dispatch(&json!({"op":"createPowertrain","physical":config}))
            .unwrap()["handle"]
            .clone();
        assert_eq!(
            reset,
            r.dispatch(&json!({"op":"powertrainState","handle":fresh_h}))
                .unwrap()
        );
    }
}
