//! Headless native engine runner. It never changes audio devices or plays sound.
use carlab_engine_lab::{
    API_VERSION, MODEL_VERSION, Runtime,
    config::{EngineConfig, EngineState},
    cylinder_cycle::{CylinderCycleConfig, solve_cylinder_cycle},
    dsp::EngineDsp,
    powertrain::{PhysicalConfig, Powertrain, cycle_config_for},
};
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    fs,
    hint::black_box,
    io::{self, BufRead, Read, Write},
    time::Instant,
};

const HELP: &str = r#"CARLAB native engine lab (CPU, no audio-device access)
Usage: carlab-engine <command> [options]

Commands:
  version       API/model identity
  cycle         Engine-derived calibrated 720-degree cylinder analysis
  evaluate      Steady operating point (torque, power, flows and assumptions)
  potential     Sampled full-load envelope, not a certified power bound
  simulate      Fixed-step native engine/vehicle/thermal simulation
  render        Deterministic stereo PCM16 WAV (default: physical drive)
  request       Versioned JSON API request; --jsonl keeps handles between lines
  ecu-point     Warm steady/open-loop ECU actuator evaluation from --input JSON
  ecu-simulate  Fixed-input standalone ECU/film/sensor run from --input JSON
  ecu-fit       Fit fuel correction from declared observations (--input JSON)
  ecu-search    Mode-specific simulated fuel/timing operating-point search
  benchmark     Native compute measurements; execute only through lm-remote --bench

Common options:
  --config FILE       Engine JSON or lab-export {config,physical}; '-' reads stdin
  --physical FILE     Separate physical-input JSON override
  --rpm N             Analysis/initial simulation RPM (default: 3000 for analysis)
  --throttle N        Pedal/analysis fraction 0..1 (default: 0.65)
  --brake N           Brake fraction 0..1 (default: 0)
  --gear N            0=neutral, 1..8=forward gear (default: 1)
  --dt SECONDS        Fixed simulation step in (0,0.25] (default: 1/240)
  --steps N           Fixed simulation steps (default: 2400)
  --samples N         Potential-curve points 8..256 (default: 64)
  --boost-fraction N  Available target boost fraction (default: 1)
  --output FILE       JSON destination, or WAV destination for render

Rendering:
  --sample-rate HZ    8000..96000 (default: 48000)
  --duration SECONDS  0.1..120 (default: 12)
  --mode NAME         physical (starts idle/rest) or manual (fixed state)
  --load N            Manual acoustic load fraction (default: 0.6)

Requests:
  --input FILE        JSON request/payload file (default: stdin)
                      ECU payloads use {engine,config,input}, fitting adds
                      {observations,options}, search uses
                      {engine,physical,rpm,throttle,options}. ECU config is
                      distinct from engine config and defaults disabled.
                      config.combustionMode selects portInjectionSpark or
                      directInjectionDiesel. DI input explicitly records
                      injectionDownstreamPressurePa (number or null).
                      DI uses prescribed single-main injection/ignition delay;
                      it does not model spray, cetane, soot or NOx chemistry.
                      --config/--physical flags override payload inputs.
                      ecu-simulate uses --dt/--steps or payload dt/steps.
                      Its input is held constant; coupled plant runs use
                      simulate/render with enabled physical.ecu.
  --jsonl             One request/envelope per line, persistent instances

Benchmarking:
  --case NAME         all, cycle, simulation, dsp (default: all)
  --cycle-config FILE Explicit raw cylinder configuration for cycle/benchmark
  --iterations N      Measured iterations 1..1000 (default: 5)
  --warmup N          Untimed iterations 0..100 (default: 2)
  --frames N          DSP frames per iteration (default: 48000)
  --actual-rpm        DSP benchmark follows supplied RPM without artistic inertia

Examples:
  carlab-engine evaluate --config engine.json --rpm 4000 --throttle 0.8
  carlab-engine simulate --config engine.json --dt 0.004166666666666667 --steps 4800
  carlab-engine render --config engine.json --duration 12 --output engine.wav
  carlab-engine ecu-point --input ecu-point.json --output point-result.json
  carlab-engine ecu-simulate --input ecu-point.json --steps 2400 --dt 0.004166666666666667
  carlab-engine ecu-fit --input declared-observations.json --output fitted-map.json
  carlab-engine ecu-search --input simulated-search.json --output candidates.json
  carlab-engine ecu-point --input diesel-point.json --output diesel-result.json
    diesel-point.json selects config.combustionMode="directInjectionDiesel"
    with enabled:true and explicit input.injectionDownstreamPressurePa.
    DI search axes: dieselQuantityMinMg/MaxMg, injectionAdvanceMinDeg/MaxDeg,
    dieselQuantitySteps/injectionAdvanceSteps. SI lambda/spark axes are rejected.
    Diesel observation-map fitting is explicitly unsupported in this version.
  printf '{"op":"version","apiVersion":1}\n' | carlab-engine request

No live material data or calibration is implied. Gas/thermal models retain the
v4 assumptions; the complete engine/turbo energy balance is not closed.
"#;
#[derive(Default)]
struct Args {
    command: String,
    values: BTreeMap<String, String>,
    flags: Vec<String>,
}
impl Args {
    fn parse() -> Result<Self, String> {
        let mut it = std::env::args().skip(1);
        let Some(command) = it.next() else {
            return Ok(Self {
                command: "help".into(),
                ..Self::default()
            });
        };
        if matches!(command.as_str(), "--help" | "-h") {
            return Ok(Self {
                command: "help".into(),
                ..Self::default()
            });
        }
        let mut a = Self {
            command,
            ..Self::default()
        };
        while let Some(key) = it.next() {
            if matches!(key.as_str(), "--jsonl" | "--actual-rpm" | "--help") {
                a.flags.push(key);
                continue;
            }
            if !matches!(
                key.as_str(),
                "--config"
                    | "--physical"
                    | "--rpm"
                    | "--throttle"
                    | "--brake"
                    | "--gear"
                    | "--dt"
                    | "--steps"
                    | "--samples"
                    | "--boost-fraction"
                    | "--output"
                    | "--sample-rate"
                    | "--duration"
                    | "--mode"
                    | "--load"
                    | "--input"
                    | "--case"
                    | "--cycle-config"
                    | "--iterations"
                    | "--warmup"
                    | "--frames"
            ) {
                return Err(format!("Unknown option {key}; use --help"));
            }
            let val = it
                .next()
                .ok_or_else(|| format!("Missing value for {key}"))?;
            if a.values.insert(key.clone(), val).is_some() {
                return Err(format!("Duplicate option {key}"));
            }
        }
        Ok(a)
    }
    fn text<'a>(&'a self, k: &str, default: &'a str) -> &'a str {
        self.values.get(k).map(String::as_str).unwrap_or(default)
    }
    fn number(&self, k: &str, default: f64, lo: f64, hi: f64) -> Result<f64, String> {
        let n = match self.values.get(k) {
            None => default,
            Some(s) => s
                .parse::<f64>()
                .map_err(|_| format!("{k} must be numeric"))?,
        };
        if !n.is_finite() || n < lo || n > hi {
            return Err(format!("{k} must be finite and in {lo}..{hi}"));
        }
        Ok(n)
    }
    fn integer(&self, k: &str, default: usize, lo: usize, hi: usize) -> Result<usize, String> {
        let n = self.number(k, default as f64, lo as f64, hi as f64)?;
        if n.fract() != 0. {
            return Err(format!("{k} must be an integer"));
        }
        Ok(n as usize)
    }
    fn flag(&self, k: &str) -> bool {
        self.flags.iter().any(|v| v == k)
    }
}
fn read_json(path: &str) -> Result<Value, String> {
    let mut s = String::new();
    if path == "-" {
        io::stdin()
            .take(4_000_001)
            .read_to_string(&mut s)
            .map_err(|e| e.to_string())?;
    } else {
        s = fs::read_to_string(path).map_err(|e| format!("{path}: {e}"))?;
    }
    if s.len() > 4_000_000 {
        return Err("JSON input exceeds 4 MB".into());
    }
    serde_json::from_str(&s).map_err(|e| e.to_string())
}
fn inputs(a: &Args) -> Result<(EngineConfig, PhysicalConfig), String> {
    let doc = if let Some(path) = a.values.get("--config") {
        read_json(path)?
    } else {
        json!({})
    };
    let raw = doc
        .get("config")
        .or_else(|| doc.get("engine"))
        .unwrap_or(&doc);
    let engine = EngineConfig::from_value(raw)?;
    let p = if let Some(path) = a.values.get("--physical") {
        read_json(path)?
    } else {
        doc.get("physical").cloned().unwrap_or(json!({}))
    };
    let physical = PhysicalConfig::from_value(&engine, &p)?;
    Ok((engine, physical))
}
fn emit(v: &Value, path: Option<&String>) -> Result<(), String> {
    let bytes = serde_json::to_vec_pretty(v).map_err(|e| e.to_string())?;
    if let Some(path) = path {
        fs::write(path, bytes).map_err(|e| e.to_string())?;
    } else {
        io::stdout().write_all(&bytes).map_err(|e| e.to_string())?;
        println!();
    }
    Ok(())
}
fn cycle_config(
    a: &Args,
    e: &EngineConfig,
    p: &PhysicalConfig,
) -> Result<CylinderCycleConfig, String> {
    if let Some(path) = a.values.get("--cycle-config") {
        CylinderCycleConfig::from_value(&read_json(path)?)
    } else {
        cycle_config_for(
            e,
            p,
            a.number("--rpm", 3000., 0., 22000.)?,
            a.number("--throttle", 0.65, 0., 1.)?,
            None,
            a.number("--boost-fraction", 1., 0., 1.)?,
        )
    }
}
/// ECU commands retain a replayable normalized request alongside their result.
/// --input avoids a second, drifting set of CLI flags for injector/map schemas.
fn ecu_command(a: &Args) -> Result<(), String> {
    let mut request = read_json(a.text("--input", "-"))?;
    if !request.is_object() {
        return Err("ECU command payload must be a JSON object".into());
    }
    if let Some(path) = a.values.get("--config") {
        let doc = read_json(path)?;
        request["engine"] = doc
            .get("config")
            .or_else(|| doc.get("engine"))
            .unwrap_or(&doc)
            .clone();
        if request.get("physical").is_none() {
            if let Some(physical) = doc.get("physical") {
                request["physical"] = physical.clone();
            }
        }
    }
    if let Some(path) = a.values.get("--physical") {
        request["physical"] = read_json(path)?;
    }
    let engine = EngineConfig::from_value(request.get("engine").unwrap_or(&Value::Null))?;
    request["engine"] = serde_json::to_value(&engine).map_err(|e| e.to_string())?;
    let mut runtime = Runtime::new();
    let standalone = matches!(a.command.as_str(), "ecu-point" | "ecu-simulate");
    if standalone || a.command == "ecu-fit" {
        let cfg = request
            .get("config")
            .cloned()
            .or_else(|| request.get("physical").and_then(|p| p.get("ecu")).cloned())
            .unwrap_or(Value::Null);
        request["config"] =
            runtime.dispatch(&json!({"op":"normalizeEcuConfig","engine":engine,"config":cfg}))?;
    }
    if standalone {
        let mut input = serde_json::to_value(carlab_engine_lab::ecu::EcuInput {
            cylinders: engine.cylinders,
            displacement_l: engine.displacement,
            ..carlab_engine_lab::ecu::EcuInput::default()
        })
        .map_err(|e| e.to_string())?;
        if let Some(supplied) = request.get("input") {
            let supplied = supplied.as_object().ok_or("ECU input must be an object")?;
            for (key, value) in supplied {
                input[key] = value.clone();
            }
        }
        if a.values.contains_key("--rpm") {
            input["rpm"] = json!(a.number("--rpm", 3000., 0., 22000.)?);
        }
        if a.values.contains_key("--throttle") {
            input["throttle"] = json!(a.number("--throttle", 0.65, 0., 1.)?);
        }
        // Typed parsing makes the recorded geometry/units identical to the
        // actual standalone controller input rather than a partial UI patch.
        let typed: carlab_engine_lab::ecu::EcuInput =
            serde_json::from_value(input).map_err(|e| format!("Invalid ECU input: {e}"))?;
        request["input"] = serde_json::to_value(typed).map_err(|e| e.to_string())?;
    }
    if a.command == "ecu-fit" {
        let options: carlab_engine_lab::ecu_calibration::EcuFitOptions = match request.get("options")
        {
            None | Some(Value::Null) => Default::default(),
            Some(v) => serde_json::from_value(v.clone())
                .map_err(|e| format!("Invalid ECU fit options: {e}"))?,
        };
        request["options"] = serde_json::to_value(options).map_err(|e| e.to_string())?;
    } else if a.command == "ecu-search" {
        let raw = request.get("physical").cloned().unwrap_or(Value::Null);
        let physical = PhysicalConfig::from_value(&engine, &raw)?;
        carlab_engine_lab::validate_ecu_search_axes(
            &physical,
            request.get("options").unwrap_or(&Value::Null),
        )?;
        let options: carlab_engine_lab::ecu_calibration::EcuSearchOptions =
            match request.get("options") {
                None | Some(Value::Null) => Default::default(),
                Some(v) => serde_json::from_value(v.clone())
                    .map_err(|e| format!("Invalid ECU search options: {e}"))?,
            };
        let mut effective = serde_json::to_value(options).map_err(|e| e.to_string())?;
        let normalized = serde_json::to_value(&physical).map_err(|e| e.to_string())?;
        let diesel = normalized["ecu"]["combustionMode"] == "directInjectionDiesel";
        let inactive: &[&str] = if diesel {
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
        if let Some(map) = effective.as_object_mut() {
            for key in inactive {
                map.remove(*key);
            }
        }
        request["options"] = effective;
        request["physical"] = normalized;
    }
    let result = match a.command.as_str() {
        "ecu-point" => {
            request["op"] = json!("evaluateEcuSteady");
            runtime.dispatch(&request)?
        }
        "ecu-fit" => {
            request["op"] = json!("fitEcuFuelMap");
            runtime.dispatch(&request)?
        }
        "ecu-search" => {
            request["op"] = json!("searchEcuOperatingPoint");
            let raw = request.get("physical").cloned().unwrap_or(Value::Null);
            request["physical"] = serde_json::to_value(PhysicalConfig::from_value(&engine, &raw)?)
                .map_err(|e| e.to_string())?;
            if a.values.contains_key("--rpm") || request.get("rpm").is_none() {
                request["rpm"] = json!(a.number("--rpm", 3000., 0., 22000.)?);
            }
            if a.values.contains_key("--throttle") || request.get("throttle").is_none() {
                request["throttle"] = json!(a.number("--throttle", 0.65, 0., 1.)?);
            }
            runtime.dispatch(&request)?
        }
        "ecu-simulate" => {
            let payload_dt = match request.get("dt") {
                None => 1. / 240.,
                Some(v) => v
                    .as_f64()
                    .filter(|v| v.is_finite())
                    .ok_or("ECU payload dt must be finite")?,
            };
            let dt = a.number("--dt", payload_dt, f64::MIN_POSITIVE, 0.25)?;
            let payload_steps = match request.get("steps") {
                None => 2400,
                Some(v) => v
                    .as_u64()
                    .ok_or("ECU payload steps must be a nonnegative integer")?,
            };
            let steps = a.integer("--steps", payload_steps as usize, 0, 100000)?;
            let h =
                runtime.dispatch(
                    &json!({"op":"createEcu","engine":engine,"config":request["config"]}),
                )?["handle"]
                    .clone();
            let result=runtime.dispatch(&json!({"op":"stepEcuMany","handle":h,"dt":dt,"steps":steps,"input":request["input"]}))?;
            runtime.dispatch(&json!({"op":"destroy","handle":h}))?;
            request["op"] = json!("ecu-simulate");
            request["dt"] = json!(dt);
            request["steps"] = json!(steps);
            result
        }
        _ => return Err("Unknown ECU command".into()),
    };
    emit(
        &json!({
            "schema":"carlab-ecu-cli-run-1","apiVersion":API_VERSION,"modelVersion":MODEL_VERSION,
            "operation":a.command,"request":request,"result":result,
            "note":"Standalone point/sensor inputs are explicit assumptions. ecu-simulate holds those inputs constant; coupled plant history uses simulate/render. Fits require declared provenance; searches are simulated, without knock/material safety evidence."
        }),
        a.values.get("--output"),
    )
}
fn request(a: &Args) -> Result<(), String> {
    let mut rt = Runtime::new();
    if a.flag("--jsonl") {
        let reader: Box<dyn BufRead> = match a.values.get("--input") {
            Some(path) if path != "-" => Box::new(io::BufReader::new(
                fs::File::open(path).map_err(|e| e.to_string())?,
            )),
            _ => Box::new(io::BufReader::new(io::stdin())),
        };
        let mut failed = false;
        for line in reader.lines() {
            let line = line.map_err(|e| e.to_string())?;
            if line.trim().is_empty() {
                continue;
            }
            let response = if line.len() > 4_000_000 {
                json!({"apiVersion":API_VERSION,"ok":false,"error":"JSON line exceeds 4 MB"})
            } else {
                match serde_json::from_str::<Value>(&line) {
                    Ok(v) => rt.envelope(&v),
                    Err(e) => {
                        json!({"apiVersion":API_VERSION,"ok":false,"error":format!("Invalid request JSON: {e}")})
                    }
                }
            };
            failed |= response["ok"] == false;
            println!(
                "{}",
                serde_json::to_string(&response).map_err(|e| e.to_string())?
            );
        }
        if failed {
            return Err("One or more JSON requests failed".into());
        }
        Ok(())
    } else {
        let req = read_json(a.text("--input", "-"))?;
        let response = rt.envelope(&req);
        emit(&response, a.values.get("--output"))?;
        if response["ok"] == false {
            return Err(response["error"]
                .as_str()
                .unwrap_or("Request failed")
                .into());
        }
        Ok(())
    }
}
fn simulate(a: &Args, e: EngineConfig, p: PhysicalConfig) -> Result<Value, String> {
    let dt = a.number("--dt", 1. / 240., f64::MIN_POSITIVE, 0.25)?;
    let steps = a.integer("--steps", 2400, 0, 1_000_000)?;
    let throttle = a.number("--throttle", 0.65, 0., 1.)?;
    let brake = a.number("--brake", 0., 0., 1.)?;
    let gear = a.integer("--gear", 1, 0, 8)?;
    let mut model = Powertrain::new(e, p)?;
    if a.values.contains_key("--rpm") {
        model.reset(Some(a.number("--rpm", 3000., 0., 22000.)?), None)?;
    }
    let mut state = model.get_state();
    for _ in 0..steps {
        state = model.step(dt, throttle, brake, gear)?;
    }
    Ok(
        json!({"apiVersion":API_VERSION,"modelVersion":MODEL_VERSION,"dt":dt,"steps":steps,"simulatedSeconds":dt*steps as f64,"state":state}),
    )
}
fn wav(path: &str, sample_rate: u32, left: &[f32], right: &[f32]) -> Result<(), String> {
    if left.len() != right.len() {
        return Err("Mismatched audio channels".into());
    }
    let bytes = left
        .len()
        .checked_mul(4)
        .filter(|n| *n <= u32::MAX as usize - 36)
        .ok_or("WAV exceeds PCM RIFF size")? as u32;
    let mut file = io::BufWriter::new(fs::File::create(path).map_err(|e| e.to_string())?);
    file.write_all(b"RIFF").map_err(|e| e.to_string())?;
    file.write_all(&(bytes + 36).to_le_bytes())
        .map_err(|e| e.to_string())?;
    file.write_all(b"WAVEfmt ").map_err(|e| e.to_string())?;
    file.write_all(&16u32.to_le_bytes())
        .map_err(|e| e.to_string())?;
    file.write_all(&1u16.to_le_bytes())
        .map_err(|e| e.to_string())?;
    file.write_all(&2u16.to_le_bytes())
        .map_err(|e| e.to_string())?;
    file.write_all(&sample_rate.to_le_bytes())
        .map_err(|e| e.to_string())?;
    file.write_all(&(sample_rate * 4).to_le_bytes())
        .map_err(|e| e.to_string())?;
    file.write_all(&4u16.to_le_bytes())
        .map_err(|e| e.to_string())?;
    file.write_all(&16u16.to_le_bytes())
        .map_err(|e| e.to_string())?;
    file.write_all(b"data").map_err(|e| e.to_string())?;
    file.write_all(&bytes.to_le_bytes())
        .map_err(|e| e.to_string())?;
    for (l, r) in left.iter().zip(right) {
        for x in [l, r] {
            if !x.is_finite() {
                return Err("Nonfinite audio; WAV export aborted".into());
            }
            let s = x.clamp(-1., 1.);
            let pcm = if s < 0. {
                (s * 32768.).round()
            } else {
                (s * 32767.).round()
            } as i16;
            file.write_all(&pcm.to_le_bytes())
                .map_err(|e| e.to_string())?;
        }
    }
    file.flush().map_err(|e| e.to_string())
}
fn render(a: &Args, e: EngineConfig, p: PhysicalConfig) -> Result<Value, String> {
    let sr = a.integer("--sample-rate", 48000, 8000, 96000)?;
    let duration = a.number("--duration", 12., 0.1, 120.)?;
    let frames = (duration * sr as f64).round() as usize;
    let throttle = a.number("--throttle", 0.65, 0., 1.)?;
    let brake = a.number("--brake", 0., 0., 1.)?;
    let gear = a.integer("--gear", 1, 0, p.gear_ratios.len())?;
    let mode = a.text("--mode", "physical");
    if !matches!(mode, "physical" | "manual") {
        return Err("--mode must be physical or manual".into());
    }
    let mut dsp = EngineDsp::new(sr as f64, e.clone());
    let mut model = Powertrain::new(e.clone(), p.clone())?;
    let mut left = vec![0f32; frames];
    let mut right = vec![0f32; frames];
    let mut l = [0f32; 128];
    let mut r = [0f32; 128];
    let manual = EngineState {
        rpm: a.number("--rpm", 3000., 0., 22000.)?,
        load: a.number("--load", 0.6, 0., 1.)?,
        throttle,
        physical: None,
    };
    if mode == "physical" {
        let s = model.get_state();
        dsp.set_state(
            &EngineState {
                rpm: s.rpm,
                load: s.load,
                throttle: s.throttle,
                physical: Some(s.physical),
            },
            true,
        );
    } else {
        dsp.set_state(&manual, false);
    }
    let warmup_blocks = (sr as f64 * 1.5 / 128.).ceil() as usize;
    let warmup_frames = warmup_blocks * 128;
    for _ in 0..warmup_blocks {
        dsp.process(&mut l, &mut r);
    }
    for frame in (0..frames).step_by(128) {
        let count = (frames - frame).min(128);
        if mode == "physical" {
            let s = model.step(count as f64 / sr as f64, throttle, brake, gear)?;
            dsp.set_state(
                &EngineState {
                    rpm: s.rpm,
                    load: s.load,
                    throttle: s.throttle,
                    physical: Some(s.physical),
                },
                true,
            );
        }
        dsp.process(&mut l, &mut r);
        left[frame..frame + count].copy_from_slice(&l[..count]);
        right[frame..frame + count].copy_from_slice(&r[..count]);
    }
    let edge = ((sr as f64 * 0.008).floor() as usize).min(frames / 2);
    for i in 0..edge {
        let g = (0.5 - 0.5 * (std::f64::consts::PI * i as f64 / edge as f64).cos()) as f32;
        for j in [i, frames - 1 - i] {
            left[j] *= g;
            right[j] *= g;
        }
    }
    left[0] = 0.;
    right[0] = 0.;
    left[frames - 1] = 0.;
    right[frames - 1] = 0.;
    let mut peak = 0f64;
    let mut square = 0.;
    for x in left.iter().chain(right.iter()) {
        if !x.is_finite() {
            return Err("Nonfinite audio; render aborted".into());
        }
        peak = peak.max(x.abs() as f64);
        square += (*x as f64).powi(2);
    }
    let path = a.text("--output", "engine.wav");
    wav(path, sr as u32, &left, &right)?;
    Ok(json!({
      "apiVersion":API_VERSION,"modelVersion":MODEL_VERSION,"mode":mode,"output":path,
      "sampleRate":sr,"duration":frames as f64/sr as f64,"frames":frames,
      "peak":peak,"rms":(square/(frames*2)as f64).sqrt(),"engine":e,"physical":p,
      "controls":{
        "throttle":throttle,
        "brake":if mode=="physical"{brake}else{0.},
        "gear":if mode=="physical"{gear}else{0},
        "rpm":if mode=="manual"{Some(manual.rpm)}else{None},
        "load":if mode=="manual"{Some(manual.load)}else{None}
      },
      "start":{"phase":"before audio warmup","rpm":e.idle_rpm,"speedMs":0.},
      "blockFrames":128,"controlCadence":"sample-based blocks",
      "controlStepSeconds":128./sr as f64,
      "finalControlStepFrames":if frames%128==0{128}else{frames%128},
      "warmup":{"requestedSeconds":1.5,"blocks":warmup_blocks,"frames":warmup_frames,"seconds":warmup_frames as f64/sr as f64,"advancesPhysicalModel":false},
      "edgeFadeFrames":edge,
      "note":"Fresh deterministic take; no replay or material-safety claim. Physical RPM/load are derived; manual brake/gear have no effect."
    }))
}
fn measured<F: FnMut() -> Result<f64, String>>(
    name: &str,
    iterations: usize,
    warmup: usize,
    mut f: F,
) -> Result<Value, String> {
    for _ in 0..warmup {
        black_box(f()?);
    }
    let mut elapsed = Vec::with_capacity(iterations);
    let mut checksums = Vec::with_capacity(iterations);
    for _ in 0..iterations {
        let start = Instant::now();
        let checksum = black_box(f()?);
        elapsed.push(start.elapsed().as_secs_f64() * 1000.);
        checksums.push(checksum);
    }
    Ok(
        json!({"case":name,"iterations":iterations,"warmup":warmup,"elapsedMs":elapsed,"checksums":checksums}),
    )
}
fn benchmark(a: &Args, e: EngineConfig, p: PhysicalConfig) -> Result<Value, String> {
    let iterations = a.integer("--iterations", 5, 1, 1000)?;
    let warmup = a.integer("--warmup", 2, 0, 100)?;
    let case = a.text("--case", "all");
    if !matches!(case, "all" | "cycle" | "simulation" | "dsp") {
        return Err("--case must be all, cycle, simulation or dsp".into());
    }
    let mut cases = Vec::new();
    if matches!(case, "all" | "cycle") {
        let cfg = cycle_config(a, &e, &p)?;
        cases.push(measured("cycle", iterations, warmup, || {
            let c = solve_cylinder_cycle(black_box(&cfg))?;
            Ok(c.net_work_j + c.peak_pressure_pa / 1e5)
        })?);
    }
    if matches!(case, "all" | "simulation") {
        let dt = a.number("--dt", 1. / 240., f64::MIN_POSITIVE, 0.25)?;
        let steps = a.integer("--steps", 2400, 1, 1_000_000)?;
        let throttle = a.number("--throttle", 0.65, 0., 1.)?;
        let brake = a.number("--brake", 0., 0., 1.)?;
        let gear = a.integer("--gear", 1, 0, 8)?;
        cases.push(measured("simulation", iterations, warmup, || {
            let mut model = Powertrain::new(e.clone(), p.clone())?;
            let mut s = model.get_state();
            for _ in 0..steps {
                s = model.step(dt, throttle, brake, gear)?;
            }
            Ok(s.rpm + s.speed_ms + s.thermal.delta_stored_energy_j / 1000.)
        })?);
    }
    if matches!(case, "all" | "dsp") {
        let sr = a.integer("--sample-rate", 48000, 8000, 96000)?;
        let frames = a.integer("--frames", 48000, 1, 96_000_000)?;
        let state = EngineState {
            rpm: a.number("--rpm", 3000., 0., 22000.)?,
            load: a.number("--load", 0.6, 0., 1.)?,
            throttle: a.number("--throttle", 0.65, 0., 1.)?,
            physical: None,
        };
        let actual = a.flag("--actual-rpm");
        cases.push(measured("dsp", iterations, warmup, || {
            let mut dsp = EngineDsp::new(sr as f64, e.clone());
            dsp.set_state(&state, actual);
            let mut l = [0f32; 128];
            let mut r = [0f32; 128];
            let mut sum = 0.;
            for frame in (0..frames).step_by(128) {
                let count = (frames - frame).min(128);
                dsp.process(&mut l[..count], &mut r[..count]);
                sum += l[..count]
                    .iter()
                    .chain(r[..count].iter())
                    .map(|x| (*x as f64).powi(2))
                    .sum::<f64>();
            }
            Ok(sum)
        })?);
    }
    Ok(
        json!({"apiVersion":API_VERSION,"modelVersion":MODEL_VERSION,"backend":"native-rust","cases":cases,"measurement":"Instant around compute; process startup/input/output excluded. Fresh model construction included for simulation and DSP. Execute only through lm-remote --bench."}),
    )
}
fn run() -> Result<(), String> {
    let a = Args::parse()?;
    if a.command == "help" || a.flag("--help") {
        print!("{HELP}");
        return Ok(());
    }
    if a.command == "request" {
        return request(&a);
    }
    if matches!(
        a.command.as_str(),
        "ecu-point" | "ecu-simulate" | "ecu-fit" | "ecu-search"
    ) {
        return ecu_command(&a);
    }
    if a.command == "version" {
        return emit(
            &json!({"apiVersion":API_VERSION,"modelVersion":MODEL_VERSION,"backend":"native-rust"}),
            a.values.get("--output"),
        );
    }
    let (e, p) = inputs(&a)?;
    let result = match a.command.as_str() {
        "simulate" => simulate(&a, e, p)?,
        "render" => render(&a, e, p)?,
        "benchmark" => benchmark(&a, e, p)?,
        "cycle" | "evaluate" | "potential" => {
            let op = match a.command.as_str() {
                "cycle" => {
                    if a.values.contains_key("--cycle-config") {
                        "cycle"
                    } else {
                        "getCylinderCycle"
                    }
                }
                "evaluate" => "evaluate",
                _ => "potential",
            };
            let mut req = json!({"op":op,"engine":e,"physical":p,"rpm":a.number("--rpm",3000.,0.,22000.)?,"throttle":a.number("--throttle",0.65,0.,1.)?,"boostFraction":a.number("--boost-fraction",1.,0.,1.)?,"samples":a.integer("--samples",64,8,256)?});
            if a.values.contains_key("--cycle-config") {
                req["config"] =
                    serde_json::to_value(cycle_config(&a, &e, &p)?).map_err(|e| e.to_string())?;
            }
            Runtime::new().dispatch(&req)?
        }
        _ => return Err(format!("Unknown command {}; use --help", a.command)),
    };
    if a.command == "render" {
        emit(&result, None)
    } else {
        emit(&result, a.values.get("--output"))
    }
}
fn main() {
    if let Err(error) = run() {
        eprintln!("carlab-engine: {error}");
        std::process::exit(1);
    }
}
